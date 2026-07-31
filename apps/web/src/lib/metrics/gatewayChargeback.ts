import { EMPTY_GATEWAY_METRICS, costPerMillionTokens, sumGatewayMetrics } from '@dash/shared';
import type { GatewayBreakdownPoint, GatewayDailyPoint, GatewayMetrics } from '@dash/shared';
import { shiftIso } from './gateway.js';

/**
 * The gateway's chargeback statement — what one calendar month cost, split
 * across the units that will be billed for it.
 *
 * Every other card on the LLM gateway page is an *analysis*: it ranks, it
 * compares, it flags. This one is a **statement**, and that difference sets
 * every rule in the module. A statement leaves the dashboard — it is exported,
 * pasted into a finance thread, and argued with by the department on the line
 * — so it has to satisfy two things nothing else on the page does:
 *
 * - **It reconciles.** The lines plus the unallocated remainder equal the
 *   month's gateway total exactly. A ranked table can drop a long tail behind
 *   a "+ 31 more" footer; a statement that does not add up is worthless.
 * - **It covers a billing period, not a window.** Chargeback is monthly
 *   because invoices and budgets are, so the month is picked directly and the
 *   page's range picker is ignored — the same reason `gatewayForecast` fetches
 *   its own calendar month.
 *
 * Three consequences worth stating, because each one is a decision:
 *
 * - **Only payer-shaped dimensions are offered.** `team`, `tag`, `api_key` and
 *   `user` identify someone who can be charged. `model` and `provider` are the
 *   supply side — a statement charging AWS Bedrock $4,000 bills nobody — and
 *   `mcp_server` is a strict subset of the traffic rather than a slice of it.
 * - **The unallocated remainder is a line, never a spread.** LiteLLM only
 *   carries a user or a tag when the caller passed one, so a service key acting
 *   on nobody's behalf lands outside every row. Distributing those dollars
 *   pro-rata would invent an attribution the proxy never made and would put an
 *   unauditable number on a department's line. It is shown as its own row and
 *   left there.
 * - **Two statements are never combined.** The dimensions overlap — the same
 *   dollar appears in the `team` statement and in the `tag` statement — so a
 *   month is billed by exactly one of them.
 */

/**
 * The dimensions a bill can be issued against.
 *
 * A subset of `GATEWAY_DIMENSIONS` on purpose: this list is "who pays", not
 * "how can the spend be sliced".
 */
export const CHARGEBACK_DIMENSIONS = ['team', 'tag', 'api_key', 'user'] as const;
export type ChargebackDimension = (typeof CHARGEBACK_DIMENSIONS)[number];

/** Months are picked as `YYYY-MM`; every bound below is derived from that. */
export type MonthKey = string;

export interface ChargebackRange {
  month: MonthKey;
  monthStart: string;
  /** Calendar last day of the month — leap years included. */
  monthEnd: string;
  /** First day of the preceding month, for the line-level comparison. */
  priorStart: string;
  priorEnd: string;
  /** Fetch bounds: the two months, clamped at the proxy's retention floor. */
  from: string;
  to: string;
  /**
   * False when the preceding month falls partly outside retention. The prior
   * column then reads `—` rather than a partial month dressed as a full one,
   * the same rule `gatewayCompare.isWithinRetention` applies to the page's
   * comparison window.
   */
  priorComparable: boolean;
}

/** Last calendar day of `YYYY-MM`, in UTC. Day 0 of the next month. */
function monthEndOf(month: MonthKey): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return new Date(Date.UTC(year, index, 0)).toISOString().slice(0, 10);
}

/** The month `back` months before `month`, as `YYYY-MM`. */
function shiftMonth(month: MonthKey, back: number): MonthKey {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return new Date(Date.UTC(year, index - 1 - back, 1)).toISOString().slice(0, 7);
}

/**
 * The months the statement can be issued for, newest first.
 *
 * Bounded by the earliest day that can actually be read back: a month whose
 * *first* day is not covered can no longer be billed from this data at all, and
 * offering it would produce a statement short by however many days are gone.
 * The month in flight is offered too — as a preview, flagged `complete: false`
 * by `deriveChargeback` — because "where are we so far this month" is the
 * question a mid-month escalation starts from.
 *
 * The floor is passed in rather than computed from `todayIso` because the two
 * answers differ: the proxy prunes its rollup at 90 days, while the sync only
 * ever replaces the dates it re-fetched, so `gateway_daily` keeps everything it
 * has seen. `GET /api/gateway/coverage` is what knows which — a floor derived
 * from today would refuse months the database is holding.
 */
export function chargebackMonths(todayIso: string, retentionFloorIso: string): MonthKey[] {
  const months: MonthKey[] = [];
  for (let back = 0; back < 12; back += 1) {
    const month = shiftMonth(todayIso.slice(0, 7), back);
    if (`${month}-01` < retentionFloorIso) break;
    months.push(month);
  }
  return months;
}

/**
 * The window one statement fetches: the month itself plus the one before it,
 * so every line carries a prior-month figure without a second request.
 *
 * At most 62 days, and clamped at the retention floor rather than reaching
 * past it — asking for days the proxy has pruned returns an empty answer that
 * is indistinguishable from a month nobody used.
 */
export function chargebackRange(
  month: MonthKey,
  todayIso: string,
  retentionFloorIso: string,
): ChargebackRange {
  const monthStart = `${month}-01`;
  const monthEnd = monthEndOf(month);
  const prior = shiftMonth(month, 1);
  const priorStart = `${prior}-01`;
  const priorEnd = shiftIso(monthStart, -1);
  const priorComparable = priorStart >= retentionFloorIso;

  return {
    month,
    monthStart,
    monthEnd,
    priorStart,
    priorEnd,
    from: priorComparable ? priorStart : monthStart,
    to: monthEnd < todayIso ? monthEnd : todayIso,
    priorComparable,
  };
}

export interface ChargebackLine {
  key: string;
  /** Alias the proxy resolved — a team name, a key alias, an email. */
  label: string | null;
  metrics: GatewayMetrics;
  /** Share of the month's *gateway-wide* spend, 0..1 — never of the allocated sum. */
  share: number;
  /** Blended $/1M tokens for this payer; null when it moved no tokens. */
  costPerMillion: number | null;
  /**
   * The same line over `priorFrom..priorTo` — the whole prior month for a
   * complete statement, and only its first N days for a month still running.
   * Null when the prior month is outside retention.
   */
  priorSpend: number | null;
  /** Fractional change against `priorSpend`; null when there is nothing to divide by. */
  change: number | null;
}

export interface ChargebackStatement {
  dimension: ChargebackDimension;
  month: MonthKey;
  monthStart: string;
  monthEnd: string;
  /** The preceding month, `YYYY-MM` — what `priorSpend` on each line is measured over. */
  priorMonth: MonthKey;
  /**
   * The days of the prior month the comparison actually covers. For a month
   * still running these stop at the same day-of-month the statement reports
   * through, so a bill twelve days in is compared against twelve days and not
   * against a whole month — the same reason `gatewayCompare` measures its
   * window off the trimmed spine rather than off the requested range. Null when
   * the prior month is outside retention.
   */
  priorFrom: string | null;
  priorTo: string | null;
  /** True when `priorFrom..priorTo` is less than the whole prior month. */
  priorPartial: boolean;
  /** Last day of the month the proxy actually reported; null for an unreported month. */
  through: string | null;
  /** Reported days of the month — the evidence behind `complete`. */
  reportedDays: number;
  /** True only when the sync has reported the month's final day. */
  complete: boolean;
  lines: ChargebackLine[];
  /** The month's gateway-wide totals — the denominator and the reconciliation target. */
  total: GatewayMetrics;
  /** Sum of the lines. */
  allocated: GatewayMetrics;
  /** `total − allocated`, floored at zero. Its own row on the statement. */
  unallocated: GatewayMetrics;
  /** `allocated.spend / total.spend`, 0..1. Zero for a month with no spend. */
  coverage: number;
  /**
   * True when the lines plus the remainder reproduce the month's spend to the
   * cent. False can only mean the dimension attributed *more* than the gateway
   * saw, which is a proxy-side contradiction and is surfaced, not hidden.
   */
  reconciles: boolean;
  /** Gateway-wide spend in the preceding month; null when it is outside retention. */
  priorTotalSpend: number | null;
}

const CENT = 0.005;

function minIso(a: string, b: string): string {
  return a < b ? a : b;
}

function subtractMetrics(total: GatewayMetrics, part: GatewayMetrics): GatewayMetrics {
  return {
    spend: Math.max(0, total.spend - part.spend),
    requests: Math.max(0, total.requests - part.requests),
    successfulRequests: Math.max(0, total.successfulRequests - part.successfulRequests),
    failedRequests: Math.max(0, total.failedRequests - part.failedRequests),
    promptTokens: Math.max(0, total.promptTokens - part.promptTokens),
    completionTokens: Math.max(0, total.completionTokens - part.completionTokens),
    totalTokens: Math.max(0, total.totalTokens - part.totalTokens),
    cacheReadTokens: Math.max(0, total.cacheReadTokens - part.cacheReadTokens),
    cacheCreationTokens: Math.max(0, total.cacheCreationTokens - part.cacheCreationTokens),
  };
}

/** Sum one dimension's rows per key, restricted to a date window. */
function bucketByKey(
  points: readonly GatewayBreakdownPoint[],
  dimension: ChargebackDimension,
  from: string,
  to: string,
): Map<string, { label: string | null; metrics: GatewayMetrics }> {
  const buckets = new Map<string, { label: string | null; points: GatewayBreakdownPoint[] }>();

  for (const point of points) {
    if (point.dimension !== dimension) continue;
    if (point.date < from || point.date > to) continue;
    const bucket = buckets.get(point.key);
    if (bucket === undefined) {
      buckets.set(point.key, { label: point.label, points: [point] });
    } else {
      bucket.points.push(point);
      if (bucket.label === null) bucket.label = point.label;
    }
  }

  return new Map(
    [...buckets.entries()].map(([key, bucket]) => [
      key,
      { label: bucket.label, metrics: sumGatewayMetrics(bucket.points) },
    ]),
  );
}

/**
 * The statement for one month and one payer dimension.
 *
 * Takes the raw payload for the two-month window rather than the page's
 * derived summary: the spine `deriveGateway` builds is trimmed to the *range
 * picker's* window and zero-filled across it, and a bill must be measured over
 * the calendar month and nothing else. Days are filtered by date here, which
 * also means the prior month costs no extra fetch.
 *
 * `complete` is decided by whether the month's last day was reported, not by
 * whether it is in the past: the sync ends at yesterday UTC, so on the 1st of
 * a month the month that just ended is still one day short.
 */
export function deriveChargeback(
  daily: readonly GatewayDailyPoint[],
  breakdowns: readonly GatewayBreakdownPoint[],
  range: ChargebackRange,
  dimension: ChargebackDimension,
): ChargebackStatement {
  const monthDays = daily.filter(
    (day) => day.date >= range.monthStart && day.date <= range.monthEnd,
  );
  const total = sumGatewayMetrics(monthDays);
  const through = monthDays.reduce<string | null>(
    (latest, day) => (latest === null || day.date > latest ? day.date : latest),
    null,
  );

  // A month twelve days in must be compared against twelve days of the month
  // before it, not against the whole of it — otherwise every statement reads
  // as a collapse until the month is over. The cut is by day-of-month and
  // clamped, so a run through the 31st compared with February stops at the
  // 28th and the comparison is flagged partial rather than silently short.
  const complete = through === range.monthEnd;
  const priorTo =
    !range.priorComparable || through === null
      ? null
      : complete
        ? range.priorEnd
        : minIso(shiftIso(range.priorStart, Number(through.slice(8, 10)) - 1), range.priorEnd);
  const priorFrom = priorTo === null ? null : range.priorStart;

  const priorDays =
    priorFrom === null || priorTo === null
      ? []
      : daily.filter((day) => day.date >= priorFrom && day.date <= priorTo);
  const priorTotalSpend = priorTo === null ? null : sumGatewayMetrics(priorDays).spend;

  const current = bucketByKey(breakdowns, dimension, range.monthStart, range.monthEnd);
  const prior =
    priorFrom !== null && priorTo !== null
      ? bucketByKey(breakdowns, dimension, priorFrom, priorTo)
      : new Map<string, { label: string | null; metrics: GatewayMetrics }>();

  const lines: ChargebackLine[] = [...current.entries()]
    .map(([key, bucket]) => {
      const priorSpend = priorTo === null ? null : (prior.get(key)?.metrics.spend ?? 0);
      return {
        key,
        label: bucket.label,
        metrics: bucket.metrics,
        share: total.spend > 0 ? bucket.metrics.spend / total.spend : 0,
        costPerMillion: costPerMillionTokens(bucket.metrics),
        priorSpend,
        change:
          priorSpend === null || priorSpend === 0
            ? null
            : (bucket.metrics.spend - priorSpend) / priorSpend,
      };
    })
    .sort((a, b) => b.metrics.spend - a.metrics.spend || a.key.localeCompare(b.key));

  const allocated =
    lines.length === 0
      ? EMPTY_GATEWAY_METRICS
      : sumGatewayMetrics(lines.map((line) => line.metrics));
  const unallocated = subtractMetrics(total, allocated);

  return {
    dimension,
    month: range.month,
    monthStart: range.monthStart,
    monthEnd: range.monthEnd,
    priorMonth: range.priorStart.slice(0, 7),
    priorFrom,
    priorTo,
    priorPartial: priorTo !== null && priorTo < range.priorEnd,
    through,
    reportedDays: monthDays.length,
    complete,
    lines,
    total,
    allocated,
    unallocated,
    coverage: total.spend > 0 ? Math.min(1, allocated.spend / total.spend) : 0,
    reconciles: Math.abs(allocated.spend + unallocated.spend - total.spend) < CENT,
    priorTotalSpend,
  };
}

/** `2026-06` → `June 2026` — the statement's own header, not a chart axis label. */
export function monthLabel(month: MonthKey): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** `2026-06` → `Jun 2026` — the month switcher's segments. */
export function shortMonthLabel(month: MonthKey): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
