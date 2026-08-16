import React, { useMemo, useState } from 'react';
import BillboardJS from '@billboard.js/react';
import bb, { bar, line, scatter } from 'billboard.js';
import { toBillboardColumns, toScatterData } from 'utils/crossTaxonomy';
import { Trans, useTranslation } from 'react-i18next';
import { IncidentLinks } from 'components/visualizations/ChartCard';

// Shared color palette — same order Billboard will use via data.colors
const CHART_COLORS = [
  '#1f77b4',
  '#ff7f0e',
  '#2ca02c',
  '#d62728',
  '#9467bd',
  '#8c564b',
  '#e377c2',
  '#7f7f7f',
  '#bcbd22',
  '#17becf',
  '#aec7e8',
  '#ffbb78',
  '#98df8a',
  '#ff9896',
  '#c5b0d5',
  '#c49c94',
  '#f7b6d2',
  '#c7c7c7',
  '#dbdb8d',
  '#9edae5',
];

export default function CrossTaxonomyChart({ chartType, crossData, xLabel, yLabel }) {
  const { t } = useTranslation();

  // When true, the chart is replaced by a list of the contributing incidents,
  // grouped by x-value then y-value.
  const [showIds, setShowIds] = useState(false);

  const options = useMemo(() => {
    if (!crossData || crossData.xValues.length === 0) return null;

    if (chartType === 'scatter') {
      return buildScatterOptions(crossData, xLabel, yLabel, t);
    }
    return buildBarLineOptions(crossData, chartType, xLabel, yLabel, t);
  }, [crossData, chartType, xLabel, yLabel, t]);

  if (!options) return null;

  // Custom legend entries for bar/line — Billboard's built-in legend is hidden to
  // avoid overlapping the x-axis tick labels at the bottom.
  const showCustomLegend =
    chartType !== 'scatter' && crossData.yValues && crossData.yValues.length <= 20;

  const legendEntries = showCustomLegend
    ? crossData.yValues.map((v, i) => ({ label: v, color: CHART_COLORS[i % CHART_COLORS.length] }))
    : [];

  const toggle = (
    <div className="flex justify-end gap-1 mb-2">
      <button
        type="button"
        onClick={() => setShowIds(false)}
        className={`text-xs px-2 py-0.5 rounded border transition-colors ${
          !showIds
            ? 'bg-blue-50 border-blue-300 text-blue-700 font-medium'
            : 'border-gray-200 text-gray-400 hover:text-gray-600 hover:border-gray-300'
        }`}
      >
        {t('Chart')}
      </button>
      <button
        type="button"
        onClick={() => setShowIds(true)}
        className={`text-xs px-2 py-0.5 rounded border transition-colors ${
          showIds
            ? 'bg-blue-50 border-blue-300 text-blue-700 font-medium'
            : 'border-gray-200 text-gray-400 hover:text-gray-600 hover:border-gray-300'
        }`}
      >
        {t('Incident IDs')}
      </button>
    </div>
  );

  if (showIds) {
    return (
      <div>
        {toggle}
        <CrossIncidentList crossData={crossData} xLabel={xLabel} yLabel={yLabel} t={t} />
      </div>
    );
  }

  return (
    <div>
      {toggle}
      <div className="[&_.bb-ygrid-line>line]:stroke-gray-300 [&_.bb-ygrid-line>line]:stroke-1 [&_.bb-line]:fill-none">
        {/* Legend sits above the chart so it never overlaps the x-axis label or tick labels */}
        {legendEntries.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2 px-8 justify-center">
            {legendEntries.map(({ label, color }) => (
              <div key={label} className="flex items-center gap-1 text-xs text-gray-600">
                <span
                  className="inline-block w-3 h-3 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: color }}
                />
                {label}
              </div>
            ))}
          </div>
        )}
        <BillboardJS
          key={`${chartType}-${xLabel}-${yLabel}-${crossData.xValues.length}`}
          bb={bb}
          options={{
            ...options,
            size: { height: 450 },
            resize: { auto: true },
          }}
        />
      </div>
    </div>
  );
}

// Lists the incidents behind each plotted (x, y) cell, grouped under each
// x-value. Each y-value series within an x-value gets a colored sub-heading
// matching the chart legend, followed by links to the contributing incidents.
function CrossIncidentList({ crossData, xLabel, yLabel, t }) {
  const { pairs, xValues, yValues } = crossData;

  const colorByY = {};

  yValues.forEach((v, i) => {
    colorByY[v] = CHART_COLORS[i % CHART_COLORS.length];
  });

  const pairsByX = new Map();

  for (const p of pairs) {
    if (!pairsByX.has(p.x)) pairsByX.set(p.x, []);
    pairsByX.get(p.x).push(p);
  }

  return (
    <div className="flex flex-col gap-4 max-h-[450px] overflow-y-auto pr-1">
      {xValues
        .filter((xv) => pairsByX.has(xv))
        .map((xv) => (
          <div key={xv} className="flex flex-col gap-2">
            <div className="text-sm font-semibold text-gray-800">
              {t(xLabel)}: {xv}
            </div>
            {pairsByX.get(xv).map((p) => (
              <div key={p.y} className="ml-3 flex flex-col gap-1">
                <div className="flex items-center gap-1.5 text-xs text-gray-600">
                  <span
                    className="inline-block w-3 h-3 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: colorByY[p.y] }}
                  />
                  <span className="font-medium">
                    {t(yLabel)}: {p.y}
                  </span>
                  <span className="text-gray-400">
                    ({p.ids.length} {t('incidents')})
                  </span>
                </div>
                <IncidentLinks ids={p.ids} />
              </div>
            ))}
          </div>
        ))}
      {pairs.length === 0 && (
        <div className="text-sm text-gray-400 py-4 text-center">
          <Trans>No incidents to list.</Trans>
        </div>
      )}
    </div>
  );
}

function buildBarLineOptions(crossData, chartType, xLabel, yLabel, t) {
  const columns = toBillboardColumns(crossData);

  const chartTypeFunc = chartType === 'line' ? line() : bar();

  const isStacked = chartType === 'histogram';

  // Assign explicit colors so bars match the custom React legend rendered above the chart
  const colorMap = {};

  crossData.yValues.forEach((v, i) => {
    colorMap[v] = CHART_COLORS[i % CHART_COLORS.length];
  });

  return {
    data: {
      x: 'x',
      columns,
      type: chartTypeFunc,
      groups: isStacked ? [crossData.yValues] : [],
      colors: colorMap,
    },
    axis: {
      x: {
        type: 'category',
        label: { text: t(xLabel), position: 'outer-center' },
        tick: { multiline: true },
        height: 160,
      },
      y: {
        label: { text: t('Count'), position: 'outer-middle' },
      },
    },
    bar: {
      width: { ratio: 0.7 },
    },
    grid: { y: { show: false } },
    // Billboard's built-in legend is hidden — custom legend is rendered above the chart
    legend: {
      show: false,
    },
    tooltip: {
      grouped: true,
    },
  };
}

function buildScatterOptions(crossData, xLabel, yLabel, t) {
  const { xs, columns, xValues } = toScatterData(crossData);

  return {
    data: {
      xs,
      columns,
      type: scatter(),
    },
    axis: {
      x: {
        label: { text: t(xLabel), position: 'outer-center' },
        tick: { multiline: true },
        height: 160,
      },
      y: {
        label: { text: t('Count'), position: 'outer-middle' },
        min: 0,
      },
    },
    legend: {
      show: crossData.yValues.length <= 20,
    },
    point: {
      r: 5,
    },
    tooltip: {
      format: {
        title: (i) => xValues[Math.round(i)] || '',
      },
    },
  };
}
