import { compactCount, dateLabel } from '../format.js';
import type { GridLine } from './chart.js';
import type { DailyTokenPoint } from './telemetry.js';

/**
 * Token-series geometry — the spend-trend line treatment with token-count
 * axis labels. One series per chart: the headline chart plots `total`, the
 * small multiples plot one kind each. Same fixed 900×240 space stretched by
 * preserveAspectRatio="none" as the cost chart.
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

export type TokenSeries = 'total' | 'input' | 'output' | 'cache';

export interface TokenChartGeometry {
  areaPath: string;
  linePath: string;
  gridLines: GridLine[];
  xLabels: string[];
}

const EMPTY_GEOMETRY: TokenChartGeometry = {
  areaPath: '',
  linePath: '',
  gridLines: [],
  xLabels: [],
};

export function buildTokenChartGeometry(
  points: readonly DailyTokenPoint[],
  series: TokenSeries,
): TokenChartGeometry {
  // A single point has no line to draw and would divide by zero below.
  if (points.length < 2) return EMPTY_GEOMETRY;

  const peak = Math.max(...points.map((point) => point[series])) * HEADROOM || 1;

  const x = (index: number): number => (index / (points.length - 1)) * VIEWBOX_WIDTH;
  const y = (value: number): number => PLOT_BOTTOM - (value / peak) * PLOT_HEIGHT;

  const steps = points.map((point, index) => `${x(index).toFixed(1)} ${y(point[series]).toFixed(1)}`);
  const linePath = `M${steps.join(' L')}`;

  return {
    linePath,
    // Close the line down to the floor and back to make the fill.
    areaPath: `${linePath} L${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT} L0 ${VIEWBOX_HEIGHT} Z`,
    gridLines: GRID_FRACTIONS.map((fraction) => ({
      topPercent: `${((y(peak * fraction) / VIEWBOX_HEIGHT) * 100).toFixed(1)}%`,
      label: compactCount(peak * fraction),
    })),
    xLabels: Array.from({ length: X_LABEL_COUNT }, (_, i) => {
      const index = Math.round((i * (points.length - 1)) / (X_LABEL_COUNT - 1));
      const point = points[index];
      return point ? dateLabel(point.date) : '';
    }),
  };
}

export const TOKEN_CHART_VIEWBOX = `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`;
