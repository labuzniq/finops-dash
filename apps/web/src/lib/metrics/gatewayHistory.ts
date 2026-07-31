import { costPerMillionTokens, costPerRequest } from '@dash/shared';
import type { GatewayMetrics, GatewaySeal, GatewaySealOrigin, GatewaySeals } from '@dash/shared';

/**
 * The gateway's month-by-month ledger — the one card on this page that can see
 * further back than the proxy can.
 *
 * Every other gateway derivation reads `gateway_daily`, and `gateway_daily` is
 * bounded twice over: LiteLLM prunes its aggregates at 90 days, and the range
 * picker is clamped to what this database actually stored. That makes "what did
 * the gateway cost in March" unanswerable from the usage payload the moment
 * March falls out of the window — which is precisely the question a budget
 * conversation opens with.
 *
 * `gateway_month` is the answer, and it is the reason the seal exists: a closed
 * month whose every day was stored is recorded once, totals and payer lines, and
 * that record outlives the days it was taken from. This module reads the seal
 * headers (`GET /api/gateway/months`) as a series.
 *
 * Four properties of that input decide everything here:
 *
 *  - **It is a record, not a derivation.** Nothing here re-adds `gateway_daily`
 *    to check a month, and nothing may: for the older months there is nothing
 *    left to add, and for the newer ones the comparison already exists as
 *    `sealDrift` on the chargeback card. A ledger that quietly re-derived what
 *    it could would report two different histories depending on how far back the
 *    reader scrolled.
 *  - **A month with no seal is a hole, never a zero.** It can be missing because
 *    the month had a gap in it when it closed, or because this dashboard was not
 *    running yet — and those are indistinguishable from here. Either way, a
 *    zero-height bar in the strip would read as a month the gateway was free,
 *    which is the same mistake as zero-filling an unobserved budget day.
 *  - **Months are the one gateway axis that may be summed.** The breakdown
 *    dimensions overlap, budget counters run on their own periods, and neither
 *    adds up. Calendar months are disjoint spans of the same gateway-wide total,
 *    so a multi-month total is a real number — as long as the unsealed months
 *    are named, because the sum is over the sealed ones only.
 *  - **Only the current statement counts.** `GET /api/gateway/months` already
 *    filters superseded revisions, but the type carries `supersededAt`, so the
 *    filter is repeated here rather than assumed. A revised month is still
 *    marked (`revision > 1`), because "we billed $X in June and then corrected
 *    it" is a fact about the ledger a reader should see without opening the
 *    revision chain.
 *
 * Pure like every module in `lib/metrics/`, and `todayIso` / `retentionFloorIso`
 * are parameters for the same reason `summarizeGatewayCoverage` takes a date:
 * both answers move at midnight and a function reading the clock cannot be
 * asserted against a fixture.
 */

/** How many months the ledger renders before it becomes a sample of itself. */
export const MAX_LEDGER_MONTHS = 24;

/** Growth below this (in absolute percent) is a flat month, not a direction. */
const FLAT_PERCENT = 1;

export interface LedgerMonth {
  /** `YYYY-MM`. */
  month: string;
  /** A current statement exists for it. Everything below is null when false. */
  sealed: boolean;
  total: GatewayMetrics | null;
  /** Which statement of the month this is — above 1, it has been corrected. */
  revision: number | null;
  sealedAt: string | null;
  sealedBy: GatewaySealOrigin | null;
  /** Days the seal covered — the month's calendar length, since a short month cannot be sealed. */
  days: number | null;
  /**
   * Spend against the *previous calendar month*, and null when that neighbour
   * carries no seal.
   *
   * Deliberately not "against the last month we have": a change measured across
   * a hole is not a month-over-month change, and presenting it as one would let
   * a missing August turn a flat September into a doubling.
   */
  spendDelta: number | null;
  spendPercent: number | null;
  /** The month `spendDelta` is against; null when there was nothing to compare with. */
  comparedWith: string | null;
  /** Blended dollars per million tokens over the month. Null when it moved none. */
  costPerMillion: number | null;
  costPerRequest: number | null;
  /**
   * The proxy could still be asked to reproduce this month — its last day is on
   * or after the retention floor. False means this database is the only copy.
   */
  reproducible: boolean;
}

/**
 * The direction of the longest unbroken run of sealed months ending at the
 * newest one.
 *
 * Compounded rather than averaged, and measured over the *contiguous* run only:
 * a mean of month-over-month percentages is dominated by whichever month was
 * smallest, and a run that jumps a hole is not a run.
 */
export interface LedgerTrend {
  /** Months in the run, including both ends. Always ≥ 2. */
  months: number;
  from: string;
  to: string;
  /** Compound growth per month, as a percentage. Negative for a falling gateway. */
  percentPerMonth: number;
  direction: 'rising' | 'falling' | 'flat';
}

export interface GatewayLedger {
  /** The seals query answered. False while it is pending or errored. */
  answered: boolean;
  /**
   * Newest first, so the table renders in the order it is read. Includes the
   * unsealed months between the first and last sealed one, and any closed month
   * since the newest seal.
   */
  months: LedgerMonth[];
  sealedCount: number;
  /** Closed months inside the ledger's span carrying no statement. */
  unsealedCount: number;
  /** Sealed months the proxy can no longer reproduce — history only we hold. */
  beyondRetentionCount: number;
  /** Sealed months whose current statement is a correction of an earlier one. */
  revisedCount: number;
  /** Oldest and newest sealed month, or null when nothing is sealed. */
  from: string | null;
  to: string | null;
  /** Sum over the sealed months only — legal because calendar months are disjoint. */
  totalSpend: number;
  /** `totalSpend / sealedCount`, or null when nothing is sealed. */
  meanMonthlySpend: number | null;
  trend: LedgerTrend | null;
  /** Sealed months older than the ledger's window, which the list does not show. */
  truncated: number;
}

const EMPTY_LEDGER: GatewayLedger = {
  answered: false,
  months: [],
  sealedCount: 0,
  unsealedCount: 0,
  beyondRetentionCount: 0,
  revisedCount: 0,
  from: null,
  to: null,
  totalSpend: 0,
  meanMonthlySpend: null,
  trend: null,
  truncated: 0,
};

/** `YYYY-MM` of the month `offset` months after `month`. */
export function shiftMonth(month: string, offset: number): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;
  const shifted = new Date(Date.UTC(year, index + offset, 1));
  return shifted.toISOString().slice(0, 7);
}

/** Last calendar day of `YYYY-MM`, UTC — day 0 of the next month. */
function monthEndOf(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return new Date(Date.UTC(year, index, 0)).toISOString().slice(0, 10);
}

export interface LedgerOptions {
  /** Today, UTC. The last *closed* month is the one before this one. */
  todayIso: string;
  /**
   * The first day the proxy would still answer for — `today − retentionDays`.
   * A month ending before it is one only this database holds.
   */
  retentionFloorIso: string;
  /** How many months the list renders. Defaults to `MAX_LEDGER_MONTHS`. */
  limit?: number;
}

/**
 * The sealed-month ledger, newest first.
 *
 * The spine runs from the oldest sealed month to the last *closed* month rather
 * than to the newest seal, deliberately: a month that closed and never got
 * sealed is the most interesting row in the table, and ending the spine at the
 * last seal would hide exactly that row.
 */
export function deriveLedger(
  payload: GatewaySeals | null | undefined,
  options: LedgerOptions,
): GatewayLedger {
  if (payload === null || payload === undefined) return EMPTY_LEDGER;

  // The route already excludes superseded rows; repeated here because the type
  // permits them and a superseded statement is what we *said* a month cost.
  const current = payload.seals.filter((seal) => seal.supersededAt === null);
  const byMonth = new Map<string, GatewaySeal>();
  for (const seal of current) byMonth.set(seal.month, seal);

  const sealedMonths = [...byMonth.keys()].sort();
  const oldest = sealedMonths[0];
  const newestSealed = sealedMonths[sealedMonths.length - 1];
  if (oldest === undefined || newestSealed === undefined) {
    return { ...EMPTY_LEDGER, answered: true };
  }

  const lastClosed = shiftMonth(options.todayIso.slice(0, 7), -1);
  // A seal newer than the last closed month should not exist, but a clock skew
  // or a hand-sealed month must not shorten the spine below what is stored.
  const end = newestSealed > lastClosed ? newestSealed : lastClosed;

  const spine: string[] = [];
  for (let month = oldest; month <= end; month = shiftMonth(month, 1)) spine.push(month);

  const limit = options.limit ?? MAX_LEDGER_MONTHS;
  const shown = spine.slice(Math.max(0, spine.length - limit));
  const truncated = sealedMonths.filter((month) => shown[0] !== undefined && month < shown[0]).length;

  const rows: LedgerMonth[] = shown.map((month) => {
    const seal = byMonth.get(month);
    if (seal === undefined) {
      return {
        month,
        sealed: false,
        total: null,
        revision: null,
        sealedAt: null,
        sealedBy: null,
        days: null,
        spendDelta: null,
        spendPercent: null,
        comparedWith: null,
        costPerMillion: null,
        costPerRequest: null,
        reproducible: monthEndOf(month) >= options.retentionFloorIso,
      };
    }

    const previous = byMonth.get(shiftMonth(month, -1));
    const spendDelta = previous === undefined ? null : seal.total.spend - previous.total.spend;
    const spendPercent =
      previous === undefined || previous.total.spend === 0 || spendDelta === null
        ? null
        : (spendDelta / previous.total.spend) * 100;

    return {
      month,
      sealed: true,
      total: seal.total,
      revision: seal.revision,
      sealedAt: seal.sealedAt,
      sealedBy: seal.sealedBy,
      days: seal.days,
      spendDelta,
      spendPercent,
      comparedWith: previous === undefined ? null : previous.month,
      costPerMillion: costPerMillionTokens(seal.total),
      costPerRequest: costPerRequest(seal.total),
      reproducible: seal.monthEnd >= options.retentionFloorIso,
    };
  });

  const sealed = rows.filter((row) => row.sealed);
  const totalSpend = sealed.reduce((sum, row) => sum + (row.total?.spend ?? 0), 0);

  return {
    answered: true,
    months: [...rows].reverse(),
    sealedCount: sealed.length,
    unsealedCount: rows.length - sealed.length,
    beyondRetentionCount: sealed.filter((row) => !row.reproducible).length,
    revisedCount: sealed.filter((row) => (row.revision ?? 1) > 1).length,
    from: sealed[0]?.month ?? null,
    to: sealed[sealed.length - 1]?.month ?? null,
    totalSpend,
    meanMonthlySpend: sealed.length === 0 ? null : totalSpend / sealed.length,
    trend: deriveTrend(rows),
    truncated,
  };
}

/**
 * Compound growth across the longest unbroken run of sealed months ending at
 * the newest sealed row.
 *
 * The run has to end at the newest one for the figure to be about the gateway
 * *now*; a longer run three months back would describe a different gateway. A
 * run of one, or one that opens at $0, has no growth rate — a rate out of zero
 * is not a large number, it is no number.
 */
function deriveTrend(oldestFirst: readonly LedgerMonth[]): LedgerTrend | null {
  let end = -1;
  for (let index = oldestFirst.length - 1; index >= 0; index -= 1) {
    if (oldestFirst[index]?.sealed === true) {
      end = index;
      break;
    }
  }
  if (end < 0) return null;

  let start = end;
  while (start > 0 && oldestFirst[start - 1]?.sealed === true) start -= 1;

  const first = oldestFirst[start];
  const last = oldestFirst[end];
  if (first === undefined || last === undefined) return null;

  const months = end - start + 1;
  const opening = first.total?.spend ?? 0;
  const closing = last.total?.spend ?? 0;
  if (months < 2 || opening <= 0) return null;

  const percentPerMonth = ((closing / opening) ** (1 / (months - 1)) - 1) * 100;
  return {
    months,
    from: first.month,
    to: last.month,
    percentPerMonth,
    direction:
      Math.abs(percentPerMonth) < FLAT_PERCENT
        ? 'flat'
        : percentPerMonth > 0
          ? 'rising'
          : 'falling',
  };
}

/** Whether there is a ledger worth rendering: at least one sealed month. */
export function hasLedger(ledger: Readonly<GatewayLedger>): boolean {
  return ledger.sealedCount > 0;
}

/** The tallest sealed month in the ledger, for scaling the strip. Zero when empty. */
export function ledgerPeak(ledger: Readonly<GatewayLedger>): number {
  return ledger.months.reduce((peak, row) => Math.max(peak, row.total?.spend ?? 0), 0);
}
