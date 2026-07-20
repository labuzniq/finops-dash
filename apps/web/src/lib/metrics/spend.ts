import { rangeDayCount } from '@dash/shared';
import type { DateRange, SpendPoint } from '@dash/shared';

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

/** The points between two inclusive ISO dates, scaled like `sliceRange`. */
export function sliceDates(
  series: readonly SpendPoint[],
  from: string,
  to: string,
  ratio: number,
): ScaledSpendPoint[] {
  return series
    .filter((point) => point.date >= from && point.date <= to)
    .map((point) => scale(point, ratio));
}

/** ISO date shifted by `days` (negative shifts backwards), in UTC. */
function shiftIso(iso: string, days: number): string {
  const [year, month, day] = iso.split('-');
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days))
    .toISOString()
    .slice(0, 10);
}

/**
 * The preceding equal-length window, or null when the series doesn't reach
 * back far enough to contain all of it.
 */
function previousWindow(
  series: readonly SpendPoint[],
  range: DateRange,
  ratio: number,
): ScaledSpendPoint[] | null {
  if (range.kind === 'preset') {
    if (range.days * 2 > series.length) return null;
    return sliceRange(series.slice(0, series.length - range.days), range.days, ratio);
  }

  const days = rangeDayCount(range);
  const previousFrom = shiftIso(range.from, -days);
  const first = series[0];
  if (first === undefined || first.date > previousFrom) return null;
  return sliceDates(series, previousFrom, shiftIso(range.from, -1), ratio);
}

/**
 * Percent change vs the preceding window.
 *
 * When history runs out — at 90d, where there is no earlier 90d to compare —
 * fall back to comparing the window's own first half against its second.
 */
function deltaPercent(
  previous: readonly ScaledSpendPoint[] | null,
  window: readonly ScaledSpendPoint[],
): number {
  const current = sumTotal(window);

  if (previous !== null) {
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
  range: DateRange,
  ratio: number,
): SpendSummary {
  const points =
    range.kind === 'preset'
      ? sliceRange(series, range.days, ratio)
      : sliceDates(series, range.from, range.to, ratio);

  return {
    points,
    total: sumTotal(points),
    license: points.reduce((sum, point) => sum + point.license, 0),
    premiumOverage: points.reduce((sum, point) => sum + point.premiumOverage, 0),
    deltaPercent: deltaPercent(previousWindow(series, range, ratio), points),
  };
}
