# Cross-Taxonomy Visualization — Server Load Analysis & Optimization Plan

This document analyzes the server cost of the cross-taxonomy visualization feature
(PR #3935, branch `feature/cross-taxonomy-visualization`) and lays out an optimization
ladder, from client-only quick wins to a zero-server-load design. It also explains the
AIID data architecture the feature runs on, so the trade-offs are legible.

---

## 1. How the AIID data architecture works

AIID is a **Gatsby static site with a serverless runtime API on the side**. There are
two completely separate paths for getting data into a page, and understanding the
difference is the key to this whole analysis.

### Path A — Build-time data (static, CDN-served)

At deploy time, Gatsby ingests the MongoDB collections (incidents, reports,
classifications, taxa, entities…) into its internal data layer. Page components declare
a `pageQuery` (e.g. `allMongodbAiidprodClassifications`), Gatsby runs it **once during
the build**, and the result is baked into the page's static assets (`page-data.json`).

- Runtime cost per visitor: **zero database queries, zero function invocations.**
  The data is served from Netlify's CDN like any static file.
- Freshness: data is as fresh as the last site build (AIID rebuilds on deploys and
  scheduled builds).
- Existing precedent: `src/pages/summaries/cset-charts.js` renders charts over **all**
  classifications this way — same data shape this feature needs.

### Path B — Runtime API (dynamic, serverless)

For live/interactive data, the browser POSTs GraphQL queries to a Netlify function
(`netlify/functions/graphql.ts`), which runs **Apollo Server inside an AWS Lambda**:

```
Browser ──POST /api/graphql──▶ Netlify Function (Lambda)
                                 └─ Apollo Server
                                     └─ graphql-to-mongodb resolvers
                                         └─ MongoDB Atlas (maxPoolSize: 10)
```

Three properties of this path matter for load:

1. **Query generation** (`server/utils.ts` → `generateQueryFields`): each collection
   gets an auto-generated resolver that translates the GraphQL selection into a single
   `collection.find(filter, { projection })`. Projections are derived from the
   selection set, so you only pull the fields you ask for. This part is efficient.

2. **Relationship fields are N+1** (`server/utils.ts` →
   `getListRelationshipResolver`): fields like `Classification.incidents` or
   `Incident.AllegedDeveloperOfAISystem` are resolved with a **separate
   `collection.find()` per parent document**. There is no batching (no DataLoader) and
   no `$lookup`. Query 1,800 classifications with a relationship subfield and the
   server runs 1,800 additional Mongo queries inside one Lambda invocation.

3. **Constrained execution environment**: the Lambda's Mongo client is capped at
   `maxPoolSize: 10`, so thousands of relationship queries queue ~10 at a time;
   Lambda billing is per-millisecond of duration; Atlas bills read ops. Long,
   query-heavy requests are exactly the wrong shape for this runtime.

**The important asymmetry:** Path A costs the server nothing per visitor; Path B costs
per visitor per page load. The cross-taxonomy page currently uses Path B exclusively —
for data that is read-only, public, identical for every visitor, and changes only when
editors annotate incidents. That is the root inefficiency, and the fix is architectural,
not micro-optimization.

---

## 2. What the feature currently costs per page load

On mount, `src/pages/apps/cross-taxonomy.js` fires three runtime queries in parallel
(`fetchPolicy: 'no-cache'`):

| Query | Base find() | Hidden relationship queries | Notes |
|---|---:|---:|---|
| `FindTaxa` | 1 | 0 | Small; fine. |
| `FindClassifications` (filter `{}`) | 1 | ~1,782 × 2 = **~3,564** | `incidents { incident_id }` and `reports { report_number }` each trigger one find() per classification. |
| `FindIncidentsEntities` (limit 9999) | 1 | ~1,425 × 3 = **~4,275** | Three entity relationship fields, one find() each per incident. |
| **Total** | **3** | **~7,839** | **≈ 7,842 MongoDB operations per visitor page load.** |

All of that funnels through one Lambda invocation per query, over a 10-connection pool
— hundreds of sequential round-trips per connection. Multi-second response times, high
Lambda duration billing, and ~8k Atlas read ops per visit. Ten simultaneous visitors ≈
78,000 reads. This is why it reads as "too heavy for the server."

### The painful irony: most of those queries fetch data the server already had

- A classification document **already contains** its `incidents` array of incident IDs.
  The relationship resolver runs a find() per classification just to return
  `incident_id` values that were sitting in the parent document. ~1,782 queries for
  nothing.
- Same for incidents: the raw documents already hold entity ID arrays
  (`Alleged deployer of AI system`, etc.). Only the entity **names** need a lookup —
  and the whole entities collection could be fetched **once** instead of 4,275 times.
- `reports { report_number }` is in the shared `FIND_CLASSIFICATION` query but the
  visualization **never uses reports**. ~1,782 queries fully wasted.

### Payload waste

- `publish` filtering happens client-side, so unpublished classifications are shipped
  to every anonymous browser (bandwidth waste and a soft data leak).
- `notes` (free-text editor notes) is fetched and never used by the page.
- Annotator namespaces (`*_Annotator`) are fetched, then filtered out client-side.

---

## 3. Optimization ladder

Ordered from smallest change to biggest win. Tiers 1–2 make the runtime path sane;
Tier 3 is the recommended end state and makes Tiers 1–2 mostly moot for this page
(they still improve other consumers of `FIND_CLASSIFICATION`).

### Tier 1 — Client-only fixes (no server changes) — ~55% fewer queries

1. **Stop sharing `FIND_CLASSIFICATION`.** Define a page-specific query without
   `reports`, `notes`, and `_id`. Removing `reports` alone eliminates ~1,782
   queries/load.
2. **Filter server-side instead of client-side.** The generated filter type already
   supports this — no schema change needed:
   ```graphql
   classifications(filter: {
     publish: { EQ: true },          # omit for admins to keep their current view
     namespace: { NIN: [...annotator namespaces] }
   })
   ```
   Smaller result set → fewer relationship resolutions → smaller payload, and
   unpublished data stops leaving the server for anonymous users.

Result: ~7,842 → ~3,200 queries, meaningfully smaller payload. Still N+1-bound.

### Tier 2 — Two tiny schema additions (kills all N+1s) — 4 queries total

The N+1s exist only because the schema exposes IDs *exclusively through relationship
fields*. Expose the raw arrays as scalars (they're already in the documents — the
resolvers do **zero** DB work):

```ts
// ClassificationType
incident_ids: {
  type: new GraphQLList(GraphQLInt),
  resolve: (source) => source.incidents,   // no DB query
},

// IncidentType (dbMapping handles the space-y field names)
alleged_deployer_ids:  { type: new GraphQLList(GraphQLString), resolve: (s) => s['Alleged deployer of AI system'] },
alleged_developer_ids: { type: new GraphQLList(GraphQLString), resolve: (s) => s['Alleged developer of AI system'] },
alleged_harmed_ids:    { type: new GraphQLList(GraphQLString), resolve: (s) => s['Alleged harmed or nearly harmed parties'] },
```

Client changes: query `incident_ids` instead of `incidents { incident_id }`; query the
ID arrays on incidents; add **one** query for the entities collection
(`entities { entity_id name }` — one find(), small documents) and join names client-side
in `buildIncidentEntityMap`.

Result: **the entire page costs 4 find() queries** (taxa, classifications, incidents,
entities) — down from ~7,842. Response time drops from seconds to one round-trip. This
also permanently improves any other consumer that adopts the scalar fields.

*(A DataLoader-style batching layer inside `getListRelationshipResolver` would fix N+1
site-wide and is worth considering separately, but it's a bigger, riskier change than
this feature needs.)*

### Tier 3 — Move to build time (recommended) — zero runtime server load

The dataset is public, read-only, identical for all users, and changes only via
editorial activity. That is the textbook profile for **Path A**. Precedent already in
tree: `summaries/cset-charts.js` loads *all* classifications
(`allMongodbAiidprodClassifications(limit: 9999999) { namespace attributes { short_name value_json } }`)
at build time and charts them.

Implementation sketch:

1. Replace the three runtime queries with a Gatsby `pageQuery` (or a
   `gatsby-node.js`-emitted compact JSON asset) selecting exactly:
   - classifications: `namespace`, `incidents` (raw IDs), `attributes { short_name value_json }`, published only
   - incidents: `incident_id`, `date`, the three raw entity-ID arrays
   - entities: `entity_id`, `name`
   - taxa: field lists for public fields
2. Keep every data-processing util (`groupClassificationsByIncident`,
   `buildCrossData`, …) unchanged — they're pure functions over arrays; only the data
   source swaps. The 57 unit tests keep their value as-is.
3. Optionally precompute the compact/tidy structure in `gatsby-node.js` so the shipped
   JSON is minimal (drop nulls, dedupe strings). Expect low-single-digit MB raw,
   far less gzipped — a static, CDN-cached, immutable-per-build download.

What this buys:

- **Zero** GraphQL/Lambda/Atlas cost per visitor. The "too heavy for the server"
  objection disappears entirely rather than being negotiated down.
- No abuse surface → no need for the login-gating the maintainer floated; the feature
  can stay open to the public.
- Faster page load (one cacheable static fetch vs. multi-second API fan-out).

Trade-offs, stated honestly:

- **Freshness**: data lags until the next build. For an analytics page over editorially
  curated taxonomies, hours of lag is immaterial.
- **Admin view of unpublished classifications** goes away on this page. Options: accept
  it (cleanest), or keep a small authenticated runtime query behind `isAdmin` only —
  admin traffic is negligible.

### Tier 4 — Precomputed aggregates (probably unnecessary)

Chart data is just counts over field pairs, so build-time could emit ready-made count
matrices. But the Custom Explorer allows arbitrary field pairs and filters, so shipping
the compact per-incident table (Tier 3) and keeping the client-side crossing preserves
full flexibility at acceptable size. Revisit only if the Tier 3 payload measures too
large in practice.

---

## 4. Measurement plan (the maintainer asked for human-driven numbers)

Before/after each tier, capture:

1. **Browser DevTools → Network**: per-query transfer size (gzipped), total bytes, and
   time-to-interactive for `/apps/cross-taxonomy`.
2. **MongoDB Atlas → Metrics/Profiler**: `opcounters.query` delta during a single page
   load (this is where the ~7.8k ops shows up directly), and slow-query log entries.
3. **Netlify function logs / Sentry spans**: Lambda invocation duration for the three
   operations (the Sentry plugin in `graphql.ts` already tags `graphql.operation` —
   the data is one dashboard query away).
4. Repeat with N concurrent simulated visitors to show connection-pool saturation
   before, and its absence after.

---

## 5. Summary

| | Mongo ops / page load | Runtime payload | Server cost profile |
|---|---:|---|---|
| Current | ~7,842 | Full classifications + notes + unpublished + reports refs | Seconds of Lambda time, thousands of Atlas reads, per visitor |
| Tier 1 | ~3,200 | Trimmed | Same shape, ~55% less |
| Tier 2 | 4 | Trimmed | One fast round-trip per query |
| Tier 3 | **0** | Compact static JSON on CDN | **None** |

The current design isn't wasteful because "load everything, analyze client-side" is
wrong — for an arbitrary-cross-tabulation tool, client-side crossing is the right call.
It's wasteful because (a) the runtime API multiplies one logical fetch into ~8,000
physical queries via per-document relationship resolvers, and (b) the fetch happens at
**runtime** through a serverless API when the same data is already available at
**build time** for free. Fix (b) and the server has nothing left to object to.
