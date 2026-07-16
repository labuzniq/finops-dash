import { compactCount, dateLabel } from '../format.js';
import type { GridLine } from './chart.js';
import type { DailyTokenPoint } from './telemetry.js';

/**
 * Daily-token stacked-bar geometry — the spend-trend treatment applied to
 * bars. Same fixed 900×240 space stretched by preserveAspectRatio="none";
 * segment separation comes from a non-scaling surface-coloured stroke on the
 * rects, not from gaps computed here, so stretching can't distort it.
 */

const VIEWBOX_WIDTH = 900;
const VIEWBOX_HEIGHT = 240;

/** The plot floor sits just inside the viewbox so strokes aren't clipped. */
const PLOT_BOTTOM = 234;
const PLOT_HEIGHT = 220;

/** Headroom above the peak so the tallest bar never touches the top gridline. */
const HEADROOM = 1.12;

const GRID_FRACTIONS = [0.25, 0.5, 0.75, 1] as const;
const X_LABEL_COUNT = 5;

/** Fraction of each day's slot the bar occupies; the rest is breathing room. */
const BAR_FILL = 0.68;

export type TokenKind = 'input' | 'output' | 'cache';

/** Baseline-up stack order; also the legend order. */
export const TOKEN_STACK: readonly TokenKind[] = ['input', 'output', 'cache'];

export interface TokenBarSegment {
  kind: TokenKind;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TokenBar {
  segments: TokenBarSegment[];
  /** Native-tooltip text: date plus the per-kind volumes. */
  title: string;
}

export interface TokenChartGeometry {
  bars: TokenBar[];
  gridLines: GridLine[];
  xLabels: string[];
}

const EMPTY_GEOMETRY: TokenChartGeometry = { bars: [], gridLines: [], xLabels: [] };

export function buildTokenChartGeometry(points: readonly DailyTokenPoint[]): TokenChartGeometry {
  if (points.length < 2) return EMPTY_GEOMETRY;

  const peak = Math.max(...points.map((point) => point.total)) * HEADROOM || 1;
  const slot = VIEWBOX_WIDTH / points.length;
  const barWidth = slot * BAR_FILL;

  const bars = points.map((point, index) => {
    const x = index * slot + (slot - barWidth) / 2;
    const segments: TokenBarSegment[] = [];
    let floor = PLOT_BOTTOM;
    for (const kind of TOKEN_STACK) {
      const height = (point[kind] / peak) * PLOT_HEIGHT;
      if (height > 0) {
        segments.push({ kind, x, y: floor - height, width: barWidth, height });
        floor -= height;
      }
    }
    return {
      segments,
      title: `${dateLabel(point.date)} · in ${compactCount(point.input)} · out ${compactCount(point.output)} · cache ${compactCount(point.cache)}`,
    };
  });

  const y = (value: number): number => PLOT_BOTTOM - (value / peak) * PLOT_HEIGHT;

  return {
    bars,
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
