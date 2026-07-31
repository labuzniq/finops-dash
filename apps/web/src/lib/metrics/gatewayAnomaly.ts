import type {
  GatewayBreakdownPoint,
  GatewayDailyPoint,
  GatewayDimension,
} from '@dash/shared';

/**
 * Unusual-spend detection for the gateway page.
 *
 * The reason this exists and the Copilot pages have no equivalent: a seat
 * licence cannot surprise you. Per-token spend can. A retraining job left
 * looping over a document corpus, a prompt that grew a 40k-token system block,
 * an agent stuck in a retry cycle — each of those outspends the entire
 * developer population in a night, and none of them show up in a range total
 * until the month closes. The daily series already carries the evidence; this
 * module reads it.
 *
 * Two baselines, on purpose, because they answer different questions:
 *
 * - **Detection** uses the trailing *median* and MAD. A mean is dragged upward
 *   by the very spike being looked for, and one bad Tuesday would then mask the
 *   next one. The median of a fortnight ignores it.
 * - **Attribution** uses the trailing *mean*, because the mean is additive: the
 *   sum of the per-key means is the mean of the gateway total, so the per-key
 *   overruns add back up to the day's overrun exactly. A median does not sum,
 *   and the contributor list would silently fail to reconcile.
 *
 * Pure, like every module in `lib/metrics/` — it runs over the payload already
 * in memory and never fetches.
 */

export interface AnomalyOptions {
  /** Trailing days the baseline is measured over. Two weeks covers the weekday shape. */
  window: number;
  /** Days of history required before a day can be judged at all. */
  minHistory: number;
  /** Robust z-score (deviations from the median) at which a day is unusual. */
  threshold: number;
  /** Also required: this much above baseline, so a flat week can't flag a rounding error. */
  minExcessShare: number;
}

export const DEFAULT_ANOMALY_OPTIONS: AnomalyOptions = {
  window: 14,
  minHistory: 7,
  threshold: 3.5,
  minExcessShare: 0.25,
};

/** MAD → standard-deviation-equivalent for a normal distribution. */
const MAD_SCALE = 1.4826;

export interface SpendAnomaly {
  date: string;
  spend: number;
  /** Trailing median — what the day "should" have cost. */
  baseline: number;
  /** Dollars above that median. Always positive: only overruns are flagged. */
  excess: number;
  /** Fraction above baseline, e.g. 1.4 for "140% more than usual". */
  excessShare: number;
  /**
   * Robust z-score, or null when the trailing window is perfectly flat and has
   * no spread to measure against. Null is not "not unusual" — such a day is
   * flagged on the relative gate alone, which is the only evidence available.
   */
  score: number | null;
  /** Context the row shows: was it more traffic, or dearer traffic? */
  requests: number;
  totalTokens: number;
  failedRequests: number;
  /** Days of history the baseline was drawn from. */
  baselineDays: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Median absolute deviation — the spread the median cares about. */
function medianAbsoluteDeviation(values: readonly number[], centre: number): number {
  return median(values.map((value) => Math.abs(value - centre)));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Days whose spend ran away from the fortnight before them, biggest overrun
 * first.
 *
 * Only overruns. A quiet day is already visible on the trend chart and costs
 * nobody anything, and flagging the weekend every Saturday would train the
 * reader to ignore the card — which is the failure mode that matters, because
 * the one day it fires for real is the one that has to be read.
 *
 * The baseline is drawn from the days *before* the candidate, never including
 * it: a spike must not be allowed to raise the bar it is being measured
 * against. Days without `minHistory` behind them are not judged at all rather
 * than judged badly, so the first week of any range is never flagged.
 *
 * A baseline of zero is skipped for the same reason the comparison module
 * refuses to divide by an absent prior period: traffic starting from nothing is
 * new, not anomalous, and there is no ratio to report.
 */
export function detectSpendAnomalies(
  spine: readonly GatewayDailyPoint[],
  options: Partial<AnomalyOptions> = {},
): SpendAnomaly[] {
  const { window, minHistory, threshold, minExcessShare } = {
    ...DEFAULT_ANOMALY_OPTIONS,
    ...options,
  };

  const anomalies: SpendAnomaly[] = [];

  for (let index = minHistory; index < spine.length; index += 1) {
    const day = spine[index];
    if (day === undefined) continue;

    const trailing = spine.slice(Math.max(0, index - window), index).map((point) => point.spend);
    if (trailing.length < minHistory) continue;

    const baseline = median(trailing);
    if (baseline <= 0) continue;

    const excess = day.spend - baseline;
    const excessShare = excess / baseline;
    if (excess <= 0 || excessShare < minExcessShare) continue;

    const scale = MAD_SCALE * medianAbsoluteDeviation(trailing, baseline);
    const score = scale > 0 ? excess / scale : null;
    if (score !== null && score < threshold) continue;

    anomalies.push({
      date: day.date,
      spend: day.spend,
      baseline,
      excess,
      excessShare,
      score,
      requests: day.requests,
      totalTokens: day.totalTokens,
      failedRequests: day.failedRequests,
      baselineDays: trailing.length,
    });
  }

  return anomalies.sort((a, b) => b.excess - a.excess || a.date.localeCompare(b.date));
}

export interface AnomalyContributor {
  key: string;
  label: string | null;
  /** What this key spent on the flagged day. */
  spend: number;
  /** Its own trailing mean over the same window. */
  baseline: number;
  /** Signed: positive is the overrun this key contributed, negative offset it. */
  excess: number;
  /** Fraction of the day's total overrun. Zero when the day did not overrun the mean. */
  share: number;
  /** Requests moved alongside the dollars — more calls, or dearer ones. */
  requests: number;
  requestsBaseline: number;
}

export interface AnomalyAttribution {
  dimension: GatewayDimension;
  date: string;
  /** Gateway-wide trailing *mean* — not the median the detector used. */
  baseline: number;
  /** Day spend above that mean. The contributors' `excess` values sum to exactly this. */
  excess: number;
  /** Every key that moved, biggest overrun first; keys that offset it sort last. */
  contributors: AnomalyContributor[];
}

/**
 * Which keys of one dimension paid for a flagged day's overrun.
 *
 * The load-bearing property, and the reason this uses a mean where the detector
 * uses a median: for a full-coverage dimension the per-key overruns sum to the
 * gateway's own overrun, exactly. That makes the share column a reconciliation
 * rather than a decoration — and it is asserted in
 * `apps/api/scripts/verify-gateway-anomaly.ts`, over every dimension the mock
 * answers for.
 *
 * `mcp_server` is the standing exception, as everywhere else on this page: it
 * covers a subset of the same requests, so its keys can only account for part
 * of the day. The card says so rather than pretending the remainder vanished.
 *
 * Keys absent from a trailing day are worth zero for that day, not skipped —
 * the proxy omits what never happened, so a key that ran for the first time on
 * the flagged day has a baseline of zero and its whole spend is overrun. That
 * is the single most useful row this card can produce.
 */
export function attributeAnomaly(
  points: readonly GatewayBreakdownPoint[],
  dimension: GatewayDimension,
  date: string,
  spine: readonly GatewayDailyPoint[],
  options: Partial<AnomalyOptions> = {},
): AnomalyAttribution {
  const { window } = { ...DEFAULT_ANOMALY_OPTIONS, ...options };
  const index = spine.findIndex((day) => day.date === date);
  const trailing = index < 0 ? [] : spine.slice(Math.max(0, index - window), index);
  const trailingDates = new Set(trailing.map((day) => day.date));

  const baseline = mean(trailing.map((day) => day.spend));
  const excess = (spine[index]?.spend ?? 0) - baseline;

  interface Bucket {
    label: string | null;
    spend: number;
    requests: number;
    trailingSpend: number;
    trailingRequests: number;
  }
  const buckets = new Map<string, Bucket>();
  const bucketFor = (key: string): Bucket => {
    const existing = buckets.get(key);
    if (existing !== undefined) return existing;
    const created: Bucket = {
      label: null,
      spend: 0,
      requests: 0,
      trailingSpend: 0,
      trailingRequests: 0,
    };
    buckets.set(key, created);
    return created;
  };

  for (const point of points) {
    if (point.dimension !== dimension) continue;
    const onDay = point.date === date;
    if (!onDay && !trailingDates.has(point.date)) continue;

    const bucket = bucketFor(point.key);
    if (bucket.label === null) bucket.label = point.label;
    if (onDay) {
      bucket.spend += point.spend;
      bucket.requests += point.requests;
    } else {
      bucket.trailingSpend += point.spend;
      bucket.trailingRequests += point.requests;
    }
  }

  const days = trailing.length;
  const contributors = [...buckets.entries()]
    .map(([key, bucket]): AnomalyContributor => {
      const keyBaseline = days > 0 ? bucket.trailingSpend / days : 0;
      const keyExcess = bucket.spend - keyBaseline;
      return {
        key,
        label: bucket.label,
        spend: bucket.spend,
        baseline: keyBaseline,
        excess: keyExcess,
        share: excess > 0 ? keyExcess / excess : 0,
        requests: bucket.requests,
        requestsBaseline: days > 0 ? bucket.trailingRequests / days : 0,
      };
    })
    .filter((row) => row.excess !== 0)
    .sort((a, b) => b.excess - a.excess || a.key.localeCompare(b.key));

  return { dimension, date, baseline, excess, contributors };
}
