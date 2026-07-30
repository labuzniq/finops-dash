import { EMPTY_GATEWAY_METRICS, sumGatewayMetrics } from '@dash/shared';
import type {
  GatewayBreakdownPoint,
  GatewayDailyPoint,
  GatewayDimension,
  GatewayMetrics,
  GatewayUsage,
} from '@dash/shared';
import { shiftIso } from './gateway.js';
import type { GatewayBreakdownRow } from './gateway.js';

/**
 * Period-over-period comparison for the gateway page.
 *
 * A spend total on its own answers "what did it cost"; the question a FinOps
 * conversation actually starts from is "is it growing, and because of what".
 * These derivations answer both against the *immediately preceding* window of
 * the same length — not against a calendar month, which would compare 31 days
 * to 28 and call the difference growth.
 *
 * The window is measured off the page's already-trimmed spine, not off the
 * requested range. The sync ends at yesterday UTC, so a "30d" range holds 29
 * reported days; comparing those 29 against a full 30 would understate every
 * metric by a day's worth of traffic on every chart, every day.
 *
 * Pure and memo-friendly, like every other module in `lib/metrics/`.
 */

export interface ComparisonWindow {
  from: string;
  to: string;
  /** Day count — identical to the current spine's, by construction. */
  days: number;
}

/**
 * The window immediately before the given spine, of exactly the same length.
 * Null for an empty spine: there is nothing to compare against nothing.
 */
export function comparisonWindow(
  spine: readonly GatewayDailyPoint[],
): ComparisonWindow | null {
  const first = spine[0];
  if (first === undefined) return null;

  const days = spine.length;
  const to = shiftIso(first.date, -1);
  return { from: shiftIso(to, -(days - 1)), to, days };
}

/**
 * Whether the prior window is inside what the proxy still retains. Outside it,
 * an empty payload means "we never asked", not "nothing was spent", and a
 * -100% delta would be a lie. The page shows no comparison at all instead.
 */
export function isWithinRetention(window: ComparisonWindow, earliestIso: string): boolean {
  return window.from >= earliestIso;
}

export interface MetricDelta {
  current: number;
  previous: number;
  /** Signed difference in the metric's own unit. */
  absolute: number;
  /**
   * Signed fraction of the prior value, or null when there is no prior value
   * to be a fraction of. Null with a positive `absolute` is genuinely new
   * traffic; null with a zero one is two quiet periods, not a change.
   */
  change: number | null;
}

export function metricDelta(current: number, previous: number): MetricDelta {
  return {
    current,
    previous,
    absolute: current - previous,
    change: previous > 0 ? (current - previous) / previous : null,
  };
}

/**
 * The delta of a derived rate that may not exist on either side — `$/1M
 * tokens` over a period with no tokens, say. Null propagates rather than
 * becoming a zero, which would read as "unchanged".
 */
export function optionalDelta(
  current: number | null,
  previous: number | null,
): MetricDelta | null {
  if (current === null || previous === null) return null;
  return metricDelta(current, previous);
}

/**
 * A rate (success, cache-hit, …) compared in percentage *points*. Ratios of
 * ratios read as nonsense — a cache-hit rate going 20% → 24% is +4 points, not
 * +20%. Null when either side is undefined, which for these helpers means the
 * denominator was zero.
 */
export function rateDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return current - previous;
}

export interface GatewayComparison {
  window: ComparisonWindow;
  /** Prior-window gateway totals — the denominator of every delta below. */
  totals: GatewayMetrics;
  spend: MetricDelta;
  requests: MetricDelta;
  totalTokens: MetricDelta;
  failedRequests: MetricDelta;
  /** False when the prior window saw no traffic at all; every delta is then unanchored. */
  hasActivity: boolean;
}

/**
 * Fold the prior window's payload into the deltas the KPI row shows.
 *
 * The prior daily rows are summed as they come — no zero-filling and no
 * trimming, because a total does not care which days are missing, and the
 * window's length is already fixed by the spine it was derived from.
 */
export function deriveGatewayComparison(
  previous: GatewayUsage | undefined,
  window: ComparisonWindow,
  current: GatewayMetrics,
): GatewayComparison {
  const totals =
    previous === undefined ? EMPTY_GATEWAY_METRICS : sumGatewayMetrics(previous.daily);

  return {
    window,
    totals,
    spend: metricDelta(current.spend, totals.spend),
    requests: metricDelta(current.requests, totals.requests),
    totalTokens: metricDelta(current.totalTokens, totals.totalTokens),
    failedRequests: metricDelta(current.failedRequests, totals.failedRequests),
    hasActivity: totals.requests > 0 || totals.spend > 0,
  };
}

export interface GatewayMoverRow {
  key: string;
  label: string | null;
  spend: MetricDelta;
  /** Requests moved alongside the dollars — a price change moves one and not the other. */
  requests: MetricDelta;
}

/**
 * The keys of one dimension that moved the most dollars between the two
 * windows, biggest absolute swing first, risers and fallers in one list.
 *
 * Ranking by absolute dollars rather than by percentage is the point: a key
 * that went $4 → $12 tripled, and a key that went $900 → $1,400 did not, but
 * only one of those is worth a conversation. The list is a *union* of both
 * windows' keys, so a model that appeared this period and one that vanished
 * both show up — the two most interesting rows a spend review can have.
 *
 * Shares are deliberately absent. These rows are one dimension's slice of an
 * overlapping set, and putting a percentage-of-total next to a movement invites
 * exactly the cross-dimension arithmetic the whole page is built to prevent.
 */
export function rankMovers(
  current: readonly GatewayBreakdownRow[],
  previousPoints: readonly GatewayBreakdownPoint[],
  dimension: GatewayDimension,
  limit = 8,
): GatewayMoverRow[] {
  const previous = new Map<string, GatewayBreakdownPoint[]>();
  for (const point of previousPoints) {
    if (point.dimension !== dimension) continue;
    const bucket = previous.get(point.key);
    if (bucket === undefined) previous.set(point.key, [point]);
    else bucket.push(point);
  }

  const labels = new Map<string, string | null>();
  for (const row of current) labels.set(row.key, row.label);
  for (const [key, points] of previous) {
    const resolved = points.find((point) => point.label !== null)?.label ?? null;
    if (!labels.has(key)) labels.set(key, resolved);
    else if (labels.get(key) === null && resolved !== null) labels.set(key, resolved);
  }

  const currentByKey = new Map(current.map((row) => [row.key, row.metrics]));

  return [...labels.entries()]
    .map(([key, label]): GatewayMoverRow => {
      const now = currentByKey.get(key) ?? EMPTY_GATEWAY_METRICS;
      const before = sumGatewayMetrics(previous.get(key) ?? []);
      return {
        key,
        label,
        spend: metricDelta(now.spend, before.spend),
        requests: metricDelta(now.requests, before.requests),
      };
    })
    .filter((row) => row.spend.absolute !== 0)
    .sort(
      (a, b) =>
        Math.abs(b.spend.absolute) - Math.abs(a.spend.absolute) || a.key.localeCompare(b.key),
    )
    .slice(0, limit);
}
