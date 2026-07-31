import { sumGatewayMetrics } from '@dash/shared';
import type { GatewayBreakdownPoint, GatewayDailyPoint, GatewayMetrics } from '@dash/shared';

/**
 * Who is on the gateway, and how evenly the bill is spread across them.
 *
 * Every other card on this page reads the gateway as *workloads* — models,
 * providers, keys, servers. This one reads it as *people*. A single corporate
 * inference endpoint gets funded on the strength of two numbers that no
 * spend chart can answer: how many people actually use it, and whether the cost
 * is a broad platform bill or a handful of power users the platform is
 * subsidising. Those are different arguments with different responses — a
 * narrow, concentrated gateway is a chargeback conversation with three teams,
 * a broad one is a per-seat economics conversation with finance.
 *
 * Three honesty constraints run through the module.
 *
 * **Attribution is partial.** LiteLLM's `user` dimension carries whatever the
 * caller passed as an end-user id (or the key's owner). A service key that
 * makes calls on nobody's behalf carries no user at all, so the user rows do
 * not have to reconstitute the gateway total the way `model` and `provider` do.
 * `coverage` measures exactly that — user-attributed spend over gateway spend —
 * and it is reported rather than assumed, because a gateway at 40% coverage is
 * a gateway whose per-user table is describing a minority of the money.
 *
 * **Two denominators, deliberately.** Each row's `share` is gateway-wide, like
 * every other card on the page, so it stays comparable with the breakdown
 * table. Concentration is measured *within* the attributed spend, because "how
 * unevenly is usage spread across users" is a question about a distribution,
 * and mixing unattributed dollars into that denominator would make a
 * concentrated population look flat purely because half the bill has no name on
 * it.
 *
 * **"Active" is per-day and is a floor.** The proxy omits a user who made no
 * call, so a day's active count is the number of users who actually transacted
 * — a fact, not an unknown. But "new" can only mean *first seen in this
 * window*: a user who last called the week before the range starts is
 * indistinguishable here from one who has never called at all, and the card
 * says so rather than reporting churn it cannot see.
 *
 * Pure, like every module in `lib/metrics/` — it reads the payload already in
 * memory and adds no fetch.
 */

/** The dimension that carries people. A constant: this card is never on the switcher. */
export const ADOPTION_DIMENSION = 'user';

/** Fewest spine days before a first-half/second-half trend is worth stating. */
const MIN_TREND_DAYS = 6;

/** Cumulative-share marks the concentration read reports. */
const HALF = 0.5;
const MOST = 0.8;

export interface AdoptionDay {
  date: string;
  /** Distinct users that made at least one call. Zero on a day nobody did. */
  activeUsers: number;
  /** Gateway-wide spend for the day — the denominator, kept for the tooltip. */
  spend: number;
  /** Spend the day's user rows carry, which is ≤ the gateway total. */
  attributedSpend: number;
  /** Attributed spend ÷ active users. Null on a day with no active user. */
  spendPerActiveUser: number | null;
}

/** One user, summed across the range. */
export interface AdoptionUserRow {
  key: string;
  /** Resolved email / alias when the proxy had one; null renders as `—`. */
  label: string | null;
  metrics: GatewayMetrics;
  /** Share of gateway-wide spend, 0..1 — the page's usual denominator. */
  share: number;
  /** Share of *user-attributed* spend, 0..1 — the distribution's own denominator. */
  shareOfAttributed: number;
  /** Running `shareOfAttributed` down the ranking, ending at 1 on the last row. */
  cumulativeShare: number;
  /** Days of the spine this user transacted on. */
  activeDays: number;
  firstSeen: string;
  lastSeen: string;
  /**
   * First seen in the second half of the spine. Window-limited by construction:
   * a returning user who was quiet before the range starts reads as new here.
   */
  isNew: boolean;
}

/**
 * How unevenly the attributed bill is spread.
 *
 * Reported as counts of users rather than as a single index: "9 users are 80%
 * of the bill" is a number someone can act on, where a Gini coefficient of 0.71
 * needs a paragraph before it means anything.
 */
export interface AdoptionConcentration {
  /** Distinct users in the window. */
  users: number;
  /** Fewest users whose spend covers half of the attributed spend. Null when nothing was attributed. */
  usersForHalf: number | null;
  /** Fewest users covering 80%. */
  usersForMost: number | null;
  /** Share of attributed spend taken by the top tenth of users (at least one). */
  topDecileShare: number | null;
  /** Share taken by the single heaviest user. */
  topUserShare: number | null;
}

/** Direction of travel in daily actives, taken from the two halves of the spine. */
export interface AdoptionTrend {
  firstHalfMeanActive: number | null;
  secondHalfMeanActive: number | null;
  /** Second half minus first, in users. Null when either half had no day. */
  deltaUsers: number | null;
  firstHalfDays: number;
  secondHalfDays: number;
}

export interface AdoptionSummary {
  /** Every day of the trimmed spine, in order. */
  daily: AdoptionDay[];
  /** Users ranked by spend, with cumulative share down the ranking. */
  users: AdoptionUserRow[];
  /** Distinct users that transacted anywhere in the window. */
  totalUsers: number;
  /** Mean distinct actives per spine day. Null on an empty spine. */
  meanDailyActive: number | null;
  peakDailyActive: number;
  /**
   * Mean daily actives ÷ distinct users in the window, 0..1 — what share of the
   * population shows up on an average day. A gateway everyone touches daily
   * reads near 1; one people try once a month reads near 1/30.
   */
  stickiness: number | null;
  /** Everything the proxy attributed to a user, over the spine. */
  attributed: GatewayMetrics;
  /** Gateway-wide totals for the same days. */
  totals: GatewayMetrics;
  /** Attributed ÷ gateway spend, 0..1. Null when the gateway cost nothing. */
  coverage: number | null;
  /** Attributed spend ÷ distinct users. */
  spendPerUser: number | null;
  /** Attributed requests ÷ distinct users. */
  requestsPerUser: number | null;
  /** Users whose first call in this window landed in its second half. */
  newUsers: number;
  trend: AdoptionTrend | null;
  /** How unevenly the attributed spend is spread across those users. */
  concentration: AdoptionConcentration;
}

/** `part ÷ whole`, or null when there is no whole to take a share of. */
function shareOf(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Mean actives across a slice of the spine. Null for an empty slice. */
function meanActive(days: readonly AdoptionDay[]): number | null {
  if (days.length === 0) return null;
  return days.reduce((sum, day) => sum + day.activeUsers, 0) / days.length;
}

/**
 * Fewest leading rows of a spend-ranked list whose cumulative share reaches
 * `mark`. Reads off the cumulative column the rows already carry, so the count
 * and the table can never disagree.
 */
function usersToReach(rows: readonly AdoptionUserRow[], mark: number): number | null {
  if (rows.length === 0) return null;
  const index = rows.findIndex((row) => row.cumulativeShare >= mark - 1e-9);
  return index === -1 ? rows.length : index + 1;
}

/**
 * The adoption read for one range.
 *
 * `spine` is the page's already-trimmed daily series, so the strip lines up
 * day-for-day with the trend charts above it and stops at the same last
 * reported day. `points` is the same breakdown array every other card reads;
 * only the `user` rows are consulted, and only on days the spine still covers —
 * a row on a dropped tail day would push coverage above 100%.
 */
export function deriveAdoption(
  spine: readonly GatewayDailyPoint[],
  points: readonly GatewayBreakdownPoint[],
): AdoptionSummary {
  const onSpine = new Set(spine.map((day) => day.date));
  const userPoints = points.filter(
    (point) => point.dimension === ADOPTION_DIMENSION && onSpine.has(point.date),
  );

  const byDate = new Map<string, GatewayBreakdownPoint[]>();
  const buckets = new Map<
    string,
    { label: string | null; points: GatewayBreakdownPoint[]; days: Set<string> }
  >();

  for (const point of userPoints) {
    const dayBucket = byDate.get(point.date);
    if (dayBucket === undefined) byDate.set(point.date, [point]);
    else dayBucket.push(point);

    const bucket = buckets.get(point.key);
    if (bucket === undefined) {
      buckets.set(point.key, { label: point.label, points: [point], days: new Set([point.date]) });
    } else {
      bucket.points.push(point);
      bucket.days.add(point.date);
      // The proxy may only resolve an alias on some days; first one wins.
      if (bucket.label === null) bucket.label = point.label;
    }
  }

  const daily = spine.map((day): AdoptionDay => {
    const rows = byDate.get(day.date) ?? [];
    // A user with a row but no call is not active: the proxy can emit a row for
    // a day of pure failures, and counting it as usage would inflate adoption
    // exactly where reliability is already reporting a problem.
    const active = new Set(rows.filter((row) => row.requests > 0).map((row) => row.key));
    const attributedSpend = sumGatewayMetrics(rows).spend;
    return {
      date: day.date,
      activeUsers: active.size,
      spend: day.spend,
      attributedSpend,
      spendPerActiveUser: active.size > 0 ? attributedSpend / active.size : null,
    };
  });

  const totals = sumGatewayMetrics(spine);
  const attributed = sumGatewayMetrics(userPoints);

  // The halfway date of the spine, so "new" means "first seen in the second
  // half" — a date comparison rather than an index one, because a user's first
  // row is found by date.
  const midpoint = spine[Math.floor(spine.length / 2)]?.date ?? null;

  const ranked = [...buckets.entries()]
    .map(([key, bucket]) => {
      const metrics = sumGatewayMetrics(bucket.points);
      const dates = [...bucket.days].sort();
      const firstSeen = dates[0] ?? '';
      return {
        key,
        label: bucket.label,
        metrics,
        share: shareOf(metrics.spend, totals.spend) ?? 0,
        shareOfAttributed: shareOf(metrics.spend, attributed.spend) ?? 0,
        cumulativeShare: 0,
        activeDays: bucket.days.size,
        firstSeen,
        lastSeen: dates[dates.length - 1] ?? '',
        isNew: midpoint !== null && firstSeen >= midpoint && spine.length >= MIN_TREND_DAYS,
      };
    })
    .sort((a, b) => b.metrics.spend - a.metrics.spend || a.key.localeCompare(b.key));

  let running = 0;
  const users = ranked.map((row): AdoptionUserRow => {
    running += row.shareOfAttributed;
    return { ...row, cumulativeShare: Math.min(1, running) };
  });

  const totalUsers = users.length;
  const decile = Math.max(1, Math.ceil(totalUsers / 10));
  const decileSpend = users
    .slice(0, decile)
    .reduce((sum, row) => sum + row.metrics.spend, 0);

  const mean = meanActive(daily);
  const half = Math.floor(daily.length / 2);
  const trend =
    daily.length >= MIN_TREND_DAYS
      ? {
          firstHalfMeanActive: meanActive(daily.slice(0, half)),
          secondHalfMeanActive: meanActive(daily.slice(half)),
          deltaUsers: null as number | null,
          firstHalfDays: half,
          secondHalfDays: daily.length - half,
        }
      : null;

  if (trend !== null && trend.firstHalfMeanActive !== null && trend.secondHalfMeanActive !== null) {
    trend.deltaUsers = trend.secondHalfMeanActive - trend.firstHalfMeanActive;
  }

  return {
    daily,
    users,
    totalUsers,
    meanDailyActive: mean,
    peakDailyActive: daily.reduce((most, day) => Math.max(most, day.activeUsers), 0),
    stickiness: mean === null ? null : shareOf(mean, totalUsers),
    attributed,
    totals,
    coverage: shareOf(attributed.spend, totals.spend),
    spendPerUser: shareOf(attributed.spend, totalUsers),
    requestsPerUser: shareOf(attributed.requests, totalUsers),
    newUsers: users.filter((row) => row.isNew).length,
    trend,
    concentration: {
      users: totalUsers,
      usersForHalf: usersToReach(users, HALF),
      usersForMost: usersToReach(users, MOST),
      topDecileShare: shareOf(decileSpend, attributed.spend),
      topUserShare: shareOf(users[0]?.metrics.spend ?? 0, attributed.spend),
    },
  };
}

/**
 * Whether the proxy attributed anything to a user at all.
 *
 * A gateway whose callers pass no end-user id reports no rows here, which is a
 * fact about how it is integrated rather than an empty state to apologise for —
 * the card stands down the same way the agent-traffic one does.
 */
export function hasAdoption(summary: AdoptionSummary): boolean {
  return summary.totalUsers > 0 && summary.attributed.requests > 0;
}
