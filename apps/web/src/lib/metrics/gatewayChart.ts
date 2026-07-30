import type { GatewayDailyPoint } from '@dash/shared';
import { compactCount, count, isoDateLabel, usd, usdCompact } from '../format.js';
import type { GridLine } from './chart.js';
import type { ChartHoverPoint } from './hover.js';

/**
 * Gateway trend geometry — the same hand-rolled 900×240 SVG treatment as the
 * Copilot spend trend and the Claude Code token charts, so the three pages
 * draw identically. One series per chart.
 *
 * The series differ only in how they format: dollars need two decimals in the
 * tooltip and a compact `$1.2k` on the axis, token and request counts need
 * `3.4M`. Everything else — scale, headroom, gridlines — is shared.
 */

const VIEWBOX_WIDTH = 900;
const VIEWBOX_HEIGHT = 240;

/** The plot floor sits just inside the viewbox so a 2px stroke isn't clipped. */
const PLOT_BOTTOM = 234;
const PLOT_HEIGHT = 220;

/** Headroom above the peak so the line never touches the top gridline. */
const HEADROOM = 1.12;

const GRID_FRACTIONS = [0.25, 0.5, 0.75, 1] as const;
const X_LABEL_COUNT = 5;

/** The daily fields worth a chart of their own. */
export type GatewaySeries = 'spend' | 'requests' | 'totalTokens';

interface SeriesSpec {
  label: string;
  /** Axis gridline text. */
  axis: (value: number) => string;
  /** Tooltip readout. */
  readout: (value: number) => string;
}

const SERIES: Record<GatewaySeries, SeriesSpec> = {
  spend: {
    label: 'Spend',
    axis: usdCompact,
    // Gateway days can land under a dollar; whole dollars would read as $0.
    readout: (value) => usd(value, 2),
  },
  requests: {
    label: 'Requests',
    axis: compactCount,
    readout: (value) => count(Math.round(value)),
  },
  totalTokens: {
    label: 'Tokens',
    axis: compactCount,
    readout: (value) => count(Math.round(value)),
  },
};

export interface GatewayChartGeometry {
  areaPath: string;
  linePath: string;
  gridLines: GridLine[];
  xLabels: string[];
  hoverPoints: ChartHoverPoint[];
}

const EMPTY_GEOMETRY: GatewayChartGeometry = {
  areaPath: '',
  linePath: '',
  gridLines: [],
  xLabels: [],
  hoverPoints: [],
};

export function buildGatewayChartGeometry(
  points: readonly GatewayDailyPoint[],
  series: GatewaySeries,
): GatewayChartGeometry {
  // A single point has no line to draw and would divide by zero below.
  if (points.length < 2) return EMPTY_GEOMETRY;

  const spec = SERIES[series];
  // `|| 1` keeps an all-zero range flat on the floor instead of NaN everywhere.
  const peak = Math.max(...points.map((point) => point[series])) * HEADROOM || 1;

  const x = (index: number): number => (index / (points.length - 1)) * VIEWBOX_WIDTH;
  const y = (value: number): number => PLOT_BOTTOM - (value / peak) * PLOT_HEIGHT;

  const steps = points.map(
    (point, index) => `${x(index).toFixed(1)} ${y(point[series]).toFixed(1)}`,
  );
  const linePath = `M${steps.join(' L')}`;

  return {
    linePath,
    // Close the line down to the floor and back to make the fill.
    areaPath: `${linePath} L${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT} L0 ${VIEWBOX_HEIGHT} Z`,
    gridLines: GRID_FRACTIONS.map((fraction) => ({
      topPercent: `${((y(peak * fraction) / VIEWBOX_HEIGHT) * 100).toFixed(1)}%`,
      label: spec.axis(peak * fraction),
    })),
    xLabels: Array.from({ length: X_LABEL_COUNT }, (_, i) => {
      const index = Math.round((i * (points.length - 1)) / (X_LABEL_COUNT - 1));
      const point = points[index];
      return point ? isoDateLabel(point.date) : '';
    }),
    hoverPoints: points.map((point, index) => ({
      xPercent: (x(index) / VIEWBOX_WIDTH) * 100,
      dateLabel: isoDateLabel(point.date),
      series: [
        {
          label: spec.label,
          value: spec.readout(point[series]),
          color: 'var(--accent)',
          yPercent: (y(point[series]) / VIEWBOX_HEIGHT) * 100,
        },
      ],
    })),
  };
}

export const GATEWAY_CHART_VIEWBOX = `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`;
