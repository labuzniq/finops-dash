import type {
  GatewayBreakdownPoint,
  GatewayDailyPoint,
  GatewayDimension,
} from '@dash/shared';

/**
 * Reliability derivations for the gateway page — where the failures are.
 *
 * The page already reports one success rate for the whole gateway, which is the
 * least useful form the number can take: a single corporate inference endpoint
 * fronting three backends is never uniformly healthy. A 2.4% gateway-wide
 * failure rate is one deployment throttling at 15% while everything else runs
 * clean, and the aggregate hides exactly the thing an on-call engineer needs.
 *
 * Two questions, one module:
 *
 * - **Which days went wrong** — the daily failure rate against the range's own
 *   baseline, so a backend incident reads as the two days it was rather than as
 *   a fraction of a percent on the range total.
 * - **Which keys are carrying the failures** — per key of one dimension, with
 *   the ranking on *excess* failures rather than on raw count, because raw count
 *   just re-ranks by traffic and the busiest model always wins that.
 *
 * Two gates keep the "elevated" flag worth reading, and they fail in opposite
 * directions. A **Wilson score interval** against the gateway-wide rate handles
 * thin evidence: a key that failed 3 of its 4 requests has a 75% failure rate
 * and no case to answer. A **minimum ratio** handles the opposite regime, which
 * is the one a corporate gateway actually lives in: across half a million
 * requests a 3.39% rate is *certainly* worse than a 3.31% one, and saying so is
 * useless. Evidence and size are different questions and the card needs both
 * answered yes.
 *
 * Pure, like every module in `lib/metrics/` — it reads the payload already in
 * memory and never fetches. Failure counts are non-null everywhere (the proxy
 * omits what never happened, so zero is a fact), but a *rate* over zero requests
 * is genuinely unknown and stays null rather than rendering as a clean 0%.
 */

export interface ReliabilityOptions {
  /** Normal quantile for the Wilson interval. 1.96 ≈ 95% confidence. */
  confidenceZ: number;
  /**
   * A day or a key must also fail this many times the range baseline before it
   * is called out.
   *
   * Significance is not the same as size, and at gateway volumes the difference
   * bites hard: half a million requests make a 3.39% rate *certainly* different
   * from a 3.31% one, and the Wilson gate flags it. Nobody can act on eight
   * hundredths of a point. Without this ratio the "elevated" badge lands on
   * every key above the mean — which is, by construction, about half of them —
   * and a badge that fires on half the rows conveys nothing.
   */
  minRatio: number;
  /**
   * Failures required before anything can be flagged at all.
   *
   * The Wilson gate is not enough on its own, and the reason is worth stating
   * because it looks like a bug otherwise: one failure out of two requests has
   * a 95% lower bound of 9.4%, which genuinely clears a 2% baseline — the
   * statistics are right, since two coin-flips both failing is unlikely at 2%.
   * It is still not something to page anyone about. This second gate is the
   * materiality half, exactly as the unusual-spend detector pairs its robust
   * z-score with a minimum relative excess.
   */
  minFailures: number;
}

export const DEFAULT_RELIABILITY_OPTIONS: ReliabilityOptions = {
  confidenceZ: 1.96,
  minRatio: 1.5,
  minFailures: 5,
};

/**
 * Lower bound of the Wilson score interval for `failures / trials`, 0..1.
 *
 * Wilson rather than the textbook normal approximation because the normal one
 * collapses at exactly the rates this card lives at: at p near 0 it produces
 * intervals that run negative and it is flatly wrong for a handful of trials,
 * which is the regime every small key is in. Wilson stays inside [0,1] and
 * widens honestly when the sample is thin.
 *
 * Zero trials return 0 — no evidence bounds nothing away from zero, so a key
 * the proxy never routed to can never be flagged.
 */
export function wilsonLowerBound(failures: number, trials: number, z: number): number {
  if (trials <= 0 || failures <= 0) return 0;
  const rate = failures / trials;
  const z2 = z * z;
  const centre = rate + z2 / (2 * trials);
  const margin = z * Math.sqrt((rate * (1 - rate) + z2 / (4 * trials)) / trials);
  return Math.max(0, (centre - margin) / (1 + z2 / trials));
}

/** Failures ÷ requests as a fraction, or null when nothing was requested. */
function rateOf(failures: number, requests: number): number | null {
  return requests > 0 ? failures / requests : null;
}

export interface ReliabilityDay {
  date: string;
  requests: number;
  failedRequests: number;
  /** 0..1, or null on a day the gateway saw no traffic at all. */
  failureRate: number | null;
  /**
   * Failures beyond what the range's own rate would have produced on this day's
   * traffic. Signed, and sums to zero across the range by construction — it is
   * a redistribution of the same failures, which is what makes it a fair
   * ranking key across days of very different volume.
   */
  excessFailures: number;
  /** Significantly *and* materially worse than the range baseline. */
  elevated: boolean;
}

export interface ReliabilityKeyRow {
  key: string;
  /** Key alias / team name when the proxy resolved one; null renders as `—`. */
  label: string | null;
  requests: number;
  failedRequests: number;
  /** 0..1, or null for a key with no requests in range. */
  failureRate: number | null;
  /** Share of *gateway-wide* failures, 0..1 — the same denominator rule the spend breakdown uses. */
  shareOfFailures: number;
  /** Failures above what the gateway-wide rate predicts for this key's traffic. Signed. */
  excessFailures: number;
  /**
   * Significantly *and* materially worse than the gateway-wide rate — see
   * `ReliabilityOptions`. A key whose badness is two days out of sixty is
   * correctly not elevated here; that is what the day strip is for.
   */
  elevated: boolean;
  /** This key's worst single day, by failure rate among days it ran. Null if it never ran. */
  worstDay: { date: string; failureRate: number; failedRequests: number } | null;
}

export interface ReliabilitySummary {
  requests: number;
  failedRequests: number;
  /** Gateway-wide failure rate for the range, 0..1. Null when the range is empty. */
  failureRate: number | null;
  /** Every day of the trimmed spine, in order — the strip the card draws. */
  daily: ReliabilityDay[];
  /** The elevated days only, worst first. */
  worstDays: ReliabilityDay[];
  dimension: GatewayDimension;
  /** Keys of `dimension`, ranked by excess failures. */
  rows: ReliabilityKeyRow[];
}

/**
 * The whole reliability picture for one range and one breakdown dimension.
 *
 * The baseline both gates measure against is the *range's own* failure rate, not
 * a fixed SLO. A gateway with a 6% floor has different questions to answer than
 * one with a 0.3% floor, and neither is served by a hardcoded threshold; what
 * both need is "what stands out from how this gateway normally behaves".
 *
 * Shares are taken from the gateway-wide failure count for the same reason the
 * spend breakdown takes them from gateway-wide spend: the dimensions overlap,
 * so a share is only comparable across them if the denominator is the one thing
 * they all slice. `mcp_server` therefore sums to less than 100%, correctly —
 * it covers a subset of the same requests.
 */
export function deriveReliability(
  spine: readonly GatewayDailyPoint[],
  points: readonly GatewayBreakdownPoint[],
  dimension: GatewayDimension,
  options: Partial<ReliabilityOptions> = {},
): ReliabilitySummary {
  const { confidenceZ, minRatio, minFailures } = {
    ...DEFAULT_RELIABILITY_OPTIONS,
    ...options,
  };

  const requests = spine.reduce((total, day) => total + day.requests, 0);
  const failedRequests = spine.reduce((total, day) => total + day.failedRequests, 0);
  const baseline = rateOf(failedRequests, requests);

  const daily = spine.map((day): ReliabilityDay => {
    const failureRate = rateOf(day.failedRequests, day.requests);
    const expected = baseline === null ? 0 : baseline * day.requests;
    const elevated =
      baseline !== null &&
      baseline > 0 &&
      failureRate !== null &&
      day.failedRequests >= minFailures &&
      failureRate >= baseline * minRatio &&
      wilsonLowerBound(day.failedRequests, day.requests, confidenceZ) > baseline;

    return {
      date: day.date,
      requests: day.requests,
      failedRequests: day.failedRequests,
      failureRate,
      excessFailures: day.failedRequests - expected,
      elevated,
    };
  });

  interface Bucket {
    label: string | null;
    requests: number;
    failedRequests: number;
    worstDay: { date: string; failureRate: number; failedRequests: number } | null;
  }
  const buckets = new Map<string, Bucket>();

  for (const point of points) {
    if (point.dimension !== dimension) continue;
    let bucket = buckets.get(point.key);
    if (bucket === undefined) {
      bucket = { label: point.label, requests: 0, failedRequests: 0, worstDay: null };
      buckets.set(point.key, bucket);
    }
    // The proxy may only resolve an alias on some days; first one wins.
    if (bucket.label === null) bucket.label = point.label;
    bucket.requests += point.requests;
    bucket.failedRequests += point.failedRequests;

    // Worst day is per *row* rather than per summed day: the sync writes one row
    // per (date, dimension, key), so the two are the same thing, and comparing
    // rates day by day is what turns "this model is 8% bad" into "this model had
    // a Tuesday".
    const dayRate = rateOf(point.failedRequests, point.requests);
    if (dayRate !== null && (bucket.worstDay === null || dayRate > bucket.worstDay.failureRate)) {
      bucket.worstDay = {
        date: point.date,
        failureRate: dayRate,
        failedRequests: point.failedRequests,
      };
    }
  }

  const rows = [...buckets.entries()]
    .map(([key, bucket]): ReliabilityKeyRow => {
      const expected = baseline === null ? 0 : baseline * bucket.requests;
      const failureRate = rateOf(bucket.failedRequests, bucket.requests);
      return {
        key,
        label: bucket.label,
        requests: bucket.requests,
        failedRequests: bucket.failedRequests,
        failureRate,
        shareOfFailures: failedRequests > 0 ? bucket.failedRequests / failedRequests : 0,
        excessFailures: bucket.failedRequests - expected,
        elevated:
          baseline !== null &&
          baseline > 0 &&
          failureRate !== null &&
          bucket.failedRequests >= minFailures &&
          failureRate >= baseline * minRatio &&
          wilsonLowerBound(bucket.failedRequests, bucket.requests, confidenceZ) > baseline,
        worstDay: bucket.worstDay,
      };
    })
    // Ranked by excess, not by count: ranking by count would just re-rank by
    // traffic, and the answer would be "the biggest model has the most
    // failures" on every gateway, every day.
    .sort(
      (a, b) =>
        b.excessFailures - a.excessFailures ||
        b.failedRequests - a.failedRequests ||
        a.key.localeCompare(b.key),
    );

  return {
    requests,
    failedRequests,
    failureRate: baseline,
    daily,
    worstDays: daily
      .filter((day) => day.elevated)
      .sort((a, b) => b.excessFailures - a.excessFailures || a.date.localeCompare(b.date)),
    dimension,
    rows,
  };
}
