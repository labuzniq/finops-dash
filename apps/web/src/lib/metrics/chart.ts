import { dateLabel, usd, usdCompact } from '../format.js';
import type { ChartHoverPoint } from './hover.js';
import type { ScaledSpendPoint } from './spend.js';

/**
 * Spend-trend geometry.
 *
 * The SVG uses preserveAspectRatio="none" and non-scaling strokes, so paths
 * are computed in a fixed 900×240 space and stretched to whatever width the
 * card gets. Only the maths lives here; the markup lives in the component.
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

export interface GridLine {
  /** Offset from the plot's top edge, as a CSS percentage. */
  topPercent: string;
  label: string;
}

export interface ChartGeometry {
  areaPath: string;
  linePath: string;
  premiumPath: string;
  gridLines: GridLine[];
  xLabels: string[];
  hoverPoints: ChartHoverPoint[];
}

const EMPTY_GEOMETRY: ChartGeometry = {
  areaPath: '',
  linePath: '',
  premiumPath: '',
  gridLines: [],
  xLabels: [],
  hoverPoints: [],
};

export interface ChartHoverOptions {
  totalLabel: string;
  /** null drops the premium series from the readout — for charts that don't draw it. */
  premiumLabel: string | null;
  /** Cents on the values — daily API cost needs them, seat spend doesn't. */
  decimals?: number;
}

const SPEND_HOVER: ChartHoverOptions = {
  totalLabel: 'Total spend',
  premiumLabel: 'Premium overage',
};

function polyline(points: readonly ScaledSpendPoint[], value: (p: ScaledSpendPoint) => number, x: (i: number) => number, y: (v: number) => number): string {
  const steps = points.map((point, index) => `${x(index).toFixed(1)} ${y(value(point)).toFixed(1)}`);
  return `M${steps.join(' L')}`;
}

export function buildChartGeometry(
  points: readonly ScaledSpendPoint[],
  hover: ChartHoverOptions = SPEND_HOVER,
): ChartGeometry {
  // A single point has no line to draw and would divide by zero below.
  if (points.length < 2) return EMPTY_GEOMETRY;

  const peak = Math.max(...points.map((point) => point.total)) * HEADROOM || 1;

  const x = (index: number): number => (index / (points.length - 1)) * VIEWBOX_WIDTH;
  const y = (value: number): number => PLOT_BOTTOM - (value / peak) * PLOT_HEIGHT;

  const linePath = polyline(points, (p) => p.total, x, y);

  return {
    linePath,
    // Close the line down to the floor and back to make the fill.
    areaPath: `${linePath} L${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT} L0 ${VIEWBOX_HEIGHT} Z`,
    premiumPath: polyline(points, (p) => p.premiumOverage, x, y),
    gridLines: GRID_FRACTIONS.map((fraction) => ({
      topPercent: `${((y(peak * fraction) / VIEWBOX_HEIGHT) * 100).toFixed(1)}%`,
      label: usdCompact(peak * fraction),
    })),
    xLabels: Array.from({ length: X_LABEL_COUNT }, (_, i) => {
      const index = Math.round((i * (points.length - 1)) / (X_LABEL_COUNT - 1));
      const point = points[index];
      return point ? dateLabel(point.date) : '';
    }),
    hoverPoints: points.map((point, index) => ({
      xPercent: (x(index) / VIEWBOX_WIDTH) * 100,
      dateLabel: dateLabel(point.date),
      series: [
        {
          label: hover.totalLabel,
          value: usd(point.total, hover.decimals ?? 0),
          color: 'var(--accent)',
          yPercent: (y(point.total) / VIEWBOX_HEIGHT) * 100,
        },
        ...(hover.premiumLabel === null
          ? []
          : [
              {
                label: hover.premiumLabel,
                value: usd(point.premiumOverage, hover.decimals ?? 0),
                color: 'var(--faint)',
                yPercent: (y(point.premiumOverage) / VIEWBOX_HEIGHT) * 100,
              },
            ]),
      ],
    })),
  };
}

export const CHART_VIEWBOX = `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`;
