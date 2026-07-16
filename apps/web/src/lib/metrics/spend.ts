import type { SpendPoint } from '@dash/shared';

/**
 * Spend derivations over the selected range.
 *
 * The series the API returns is org-wide. When a filter narrows the seat list,
 * the series is scaled by the surviving fraction of seats, so the chart tracks
 * the subset the rest of the page is describing.
 */

export interface ScaledSpendPoint {
  date: Date;
  license: number;
  premiumOverage: number;
  total: number;
}

export interface SpendSummary {
  points: ScaledSpendPoint[];
  total: number;
  license: number;
  premiumOverage: number;
  /** Change against the previous equal-length window, in percent. */
  deltaPercent: number;
}

/** `2026-04-17` as a *local* midnight, so axis labels can't slip a day. */
function parseIsoDate(iso: string): Date {
  const [year, month, day] = iso.split('-');
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function scale(point: SpendPoint, ratio: number): ScaledSpendPoint {
  const license = point.license * ratio;
  const premiumOverage = point.premiumOverage * ratio;
  return { date: parseIsoDate(point.date), license, premiumOverage, total: license + premiumOverage };
}

function sumTotal(points: readonly ScaledSpendPoint[]): number {
  return points.reduce((total, point) => total + point.total, 0);
}

function mean(points: readonly ScaledSpendPoint[]): number {
  return points.length === 0 ? 0 : sumTotal(points) / points.length;
}

/** The last `rangeDays` of the series, scaled to the filtered seat subset. */
export function sliceRange(
  series: readonly SpendPoint[],
  rangeDays: number,
  ratio: number,
): ScaledSpendPoint[] {
  return series.slice(Math.max(0, series.length - rangeDays)).map((point) => scale(point, ratio));
}

/**
 * Percent change vs the preceding window.
 *
 * When history runs out — at 90d, where there is no earlier 90d to compare —
 * fall back to comparing the window's own first half against its second.
 */
function deltaPercent(
  series: readonly SpendPoint[],
  window: readonly ScaledSpendPoint[],
  rangeDays: number,
  ratio: number,
): number {
  const current = sumTotal(window);

  if (rangeDays * 2 <= series.length) {
    const previous = sliceRange(series.slice(0, series.length - rangeDays), rangeDays, ratio);
    const previousTotal = sumTotal(previous);
    return previousTotal > 0 ? ((current - previousTotal) / previousTotal) * 100 : 0;
  }

  const midpoint = Math.floor(window.length / 2);
  const first = mean(window.slice(0, midpoint));
  const second = mean(window.slice(midpoint));
  return first > 0 ? ((second - first) / first) * 100 : 0;
}

export function summariseSpend(
  series: readonly SpendPoint[],
  rangeDays: number,
  ratio: number,
): SpendSummary {
  const points = sliceRange(series, rangeDays, ratio);

  return {
    points,
    total: sumTotal(points),
    license: points.reduce((sum, point) => sum + point.license, 0),
    premiumOverage: points.reduce((sum, point) => sum + point.premiumOverage, 0),
    deltaPercent: deltaPercent(series, points, rangeDays, ratio),
  };
}
