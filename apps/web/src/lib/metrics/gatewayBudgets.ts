import { budgetPeriodStart, budgetRemaining, budgetUtilization } from '@dash/shared';
import type { GatewayBudget, GatewayBudgetScope } from '@dash/shared';

/**
 * Governance derivations for the gateway page — what the proxy will *stop*, as
 * opposed to what it recorded.
 *
 * Every other card on this page reads usage: days, dollars, tokens, failures,
 * all of them slices of one 90-day spine that the range picker cuts. A budget
 * is a different kind of fact entirely. It is current configuration plus
 * LiteLLM's own enforced counter for the period in flight, there is exactly one
 * row per key and per team, it has no history, and it is not affected by the
 * range picker at all — asking "what were the budgets last week" is a question
 * the proxy cannot answer.
 *
 * Three rules follow from that, and all three are load-bearing:
 *
 *  - **No dollars are ever summed across rows.** Not per scope, not gateway-wide.
 *    Each row's `spend` is measured over that row's *own* period, and a real
 *    proxy mixes them freely: the mock alone has five monthly budgets, one
 *    weekly one and one key with no period at all whose counter simply never
 *    resets. Adding a $30-per-week cap to a $1,800-per-month cap produces a
 *    number with no unit. Where the usage cards can total anything because every
 *    row shares one spine, this one totals *counts of objects* and nothing else.
 *  - **Scopes never combine.** A key's cap and its team's cap govern the same
 *    dollars — spending under the key is spending under the team — exactly like
 *    the overlapping breakdown dimensions. The card is a switcher for the same
 *    reason the breakdown card is.
 *  - **Null is not zero.** `maxBudget: null` is uncapped; `maxBudget: 0` rejects
 *    every call. They are opposite states and the sort has to place them at
 *    opposite ends, not next to each other at "$0".
 *
 * Pure, like every module in `lib/metrics/` — it reads the payload already in
 * memory and never fetches. `now` is a parameter rather than a `Date.now()`
 * call so the pace projection is testable.
 */

/**
 * What state a governed object is in, worst first.
 *
 *  - `blocked` — the proxy is rejecting its calls right now, either because an
 *    admin disabled it or because it is budgeted at zero dollars. Two different
 *    causes, one observable effect, so they share a state and carry a reason.
 *  - `over` — past its hard cap. A proxy can bill past a cap on in-flight
 *    requests, so this is reachable without `blocked` being set.
 *  - `soft` — past the alert threshold its owner set, still under the cap. This
 *    is the state the whole card exists to surface: it is the last one anybody
 *    can act on before calls start failing.
 *  - `warn` — no soft budget configured, but far enough through the cap to say
 *    so. Derived, not reported — a stand-in for the threshold nobody set.
 *  - `ok` — capped and comfortably under.
 *  - `uncapped` — no hard cap at all. Not a good state and not a bad one: on a
 *    corporate gateway the biggest workload is usually the one nobody dares cap.
 */
export type BudgetState = 'blocked' | 'over' | 'soft' | 'warn' | 'ok' | 'uncapped';

/** Why a `blocked` row is blocked. Null on every other state. */
export type BlockReason = 'disabled' | 'zero-cap';

export interface BudgetRow {
  budget: GatewayBudget;
  state: BudgetState;
  blockReason: BlockReason | null;
  /** Share of the hard cap consumed, 0–100 and above 100 on overrun. Null when there is no cap to divide by. */
  utilization: number | null;
  /** Dollars left before the cap; negative when overrun. Null when uncapped. */
  remaining: number | null;
  /** Where the soft budget sits on the cap's scale, 0–100. Null when unset or uncapped. */
  softMark: number | null;
  /** ISO instant the period in flight began — `resetAt` less one duration. */
  periodStart: string | null;
  /** Fraction of the period elapsed at `now`, 0–1. Null when the period is unknown. */
  periodElapsed: number | null;
  /**
   * What this period ends at if the current pace holds — `spend ÷ elapsed`.
   *
   * Deliberately linear, and deliberately null early in a period: projecting a
   * month from its first afternoon multiplies one batch job by thirty. It is
   * also null for a row with no period, which is not a gap in the maths but the
   * fact that a counter that never resets has no period to project to the end of.
   */
  projectedSpend: number | null;
  /** Projected past the cap while not yet over it — the actionable one. */
  projectedOverrun: boolean;
  /** Either limit set. A key with no budget but a TPM ceiling is still governed. */
  rateLimited: boolean;
}

/**
 * One scope's rows and the counts that describe them.
 *
 * Counts, not dollars — see the module comment. `attention` is the number a
 * headline can carry honestly: rows in a state somebody has to do something
 * about, which is everything worse than `ok` except `uncapped`, plus the rows
 * heading for the cap on their current pace.
 */
export interface BudgetScopeSummary {
  scope: GatewayBudgetScope;
  rows: BudgetRow[];
  total: number;
  capped: number;
  uncapped: number;
  blocked: number;
  over: number;
  soft: number;
  warn: number;
  projectedOverrun: number;
  rateLimited: number;
  /** Rows worth acting on: blocked, over, past a soft budget, or pacing past the cap. */
  attention: number;
}

export interface BudgetSummary {
  scopes: BudgetScopeSummary[];
  /** No governed object at all — a proxy that refused the management routes, or a fresh sync. */
  isEmpty: boolean;
}

export interface BudgetOptions {
  /**
   * Share of the cap at which a row with no soft budget is called out anyway.
   *
   * A derived threshold is weaker evidence than a configured one — the owner
   * said nothing about 80% — so it gets its own state rather than being folded
   * into `soft`, and the card words it differently.
   */
  warnAt: number;
  /**
   * How far into a period the pace projection starts answering.
   *
   * `spend ÷ elapsed` is a ratio of two small numbers early on and it swings
   * wildly: one batch job on the first morning of a month projects thirty times
   * itself. A sixth of the period is roughly the point where a single day stops
   * dominating a monthly counter.
   */
  minElapsed: number;
}

export const DEFAULT_BUDGET_OPTIONS: BudgetOptions = {
  warnAt: 0.8,
  minElapsed: 1 / 6,
};

/** Sort key: blocked first, then by share of cap consumed, uncapped last. */
function rank(row: BudgetRow): number {
  if (row.state === 'blocked') return Number.POSITIVE_INFINITY;
  if (row.utilization === null) return Number.NEGATIVE_INFINITY;
  return row.utilization;
}

function classify(
  budget: GatewayBudget,
  utilization: number | null,
  options: BudgetOptions,
): { state: BudgetState; blockReason: BlockReason | null } {
  // Both block states are checked before anything else because they describe
  // what is happening to calls *now*, which outranks any percentage. A key
  // budgeted at zero is not "0% of its budget used" — it is closed.
  if (budget.blocked) return { state: 'blocked', blockReason: 'disabled' };
  if (budget.maxBudget === 0) return { state: 'blocked', blockReason: 'zero-cap' };
  if (budget.maxBudget === null || utilization === null) {
    return { state: 'uncapped', blockReason: null };
  }
  if (utilization >= 100) return { state: 'over', blockReason: null };
  if (budget.softBudget !== null && budget.spend >= budget.softBudget) {
    return { state: 'soft', blockReason: null };
  }
  if (utilization >= options.warnAt * 100) return { state: 'warn', blockReason: null };
  return { state: 'ok', blockReason: null };
}

/**
 * How far through its period a budget is, 0–1, or null when that is unknowable.
 *
 * Needs both ends: `resetAt` from the proxy and a parseable duration to walk
 * back from it. A counter with no period has no elapsed fraction — it is not
 * 0% through a period, it is outside the concept.
 */
function elapsedFraction(budget: GatewayBudget, periodStart: string | null, now: Date): number | null {
  if (periodStart === null || budget.resetAt === null) return null;
  const start = new Date(periodStart).getTime();
  const end = new Date(budget.resetAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.min(1, Math.max(0, (now.getTime() - start) / (end - start)));
}

function toRow(budget: GatewayBudget, now: Date, options: BudgetOptions): BudgetRow {
  const utilization = budgetUtilization(budget);
  const { state, blockReason } = classify(budget, utilization, options);
  const periodStart = budgetPeriodStart(budget);
  const periodElapsed = elapsedFraction(budget, periodStart, now);

  const projectedSpend =
    periodElapsed !== null && periodElapsed >= options.minElapsed
      ? budget.spend / periodElapsed
      : null;

  return {
    budget,
    state,
    blockReason,
    utilization,
    remaining: budgetRemaining(budget),
    softMark:
      budget.softBudget === null || budget.maxBudget === null || budget.maxBudget <= 0
        ? null
        : Math.min(100, (budget.softBudget / budget.maxBudget) * 100),
    periodStart,
    periodElapsed,
    projectedSpend,
    projectedOverrun:
      projectedSpend !== null &&
      budget.maxBudget !== null &&
      budget.maxBudget > 0 &&
      state !== 'over' &&
      state !== 'blocked' &&
      projectedSpend > budget.maxBudget,
    rateLimited: budget.tpmLimit !== null || budget.rpmLimit !== null,
  };
}

/**
 * Group the proxy's governance rows by scope, classify each one and count the
 * states. `now` decides the pace projection only — nothing else here is
 * time-dependent, because a budget snapshot is already "right now".
 */
export function deriveBudgets(
  budgets: readonly GatewayBudget[] | undefined,
  now: Date,
  options: BudgetOptions = DEFAULT_BUDGET_OPTIONS,
): BudgetSummary {
  const byScope = new Map<GatewayBudgetScope, BudgetRow[]>();

  for (const budget of budgets ?? []) {
    const row = toRow(budget, now, options);
    const rows = byScope.get(budget.scope);
    if (rows === undefined) byScope.set(budget.scope, [row]);
    else rows.push(row);
  }

  const scopes: BudgetScopeSummary[] = [];
  for (const [scope, rows] of byScope) {
    rows.sort((a, b) => {
      // Compared, not subtracted: the ranks are deliberately infinite at both
      // ends (blocked above every percentage, uncapped below every one) and
      // `Infinity - Infinity` is NaN, which a sort silently reads as "equal".
      const left = rank(a);
      const right = rank(b);
      if (left !== right) return right > left ? 1 : -1;
      // Uncapped rows all rank equal, so they order by the dollars actually
      // flowing through them — the biggest ungoverned consumer reads first.
      if (b.budget.spend !== a.budget.spend) return b.budget.spend - a.budget.spend;
      return (a.budget.label ?? a.budget.key).localeCompare(b.budget.label ?? b.budget.key);
    });

    const count = (state: BudgetState): number => rows.filter((row) => row.state === state).length;
    const projectedOverrun = rows.filter((row) => row.projectedOverrun).length;
    const blocked = count('blocked');
    const over = count('over');
    const soft = count('soft');

    scopes.push({
      scope,
      rows,
      total: rows.length,
      capped: rows.filter((row) => row.budget.maxBudget !== null).length,
      uncapped: count('uncapped'),
      blocked,
      over,
      soft,
      warn: count('warn'),
      projectedOverrun,
      rateLimited: rows.filter((row) => row.rateLimited).length,
      attention: rows.filter(
        (row) =>
          row.state === 'blocked' ||
          row.state === 'over' ||
          row.state === 'soft' ||
          row.projectedOverrun,
      ).length,
    });
  }

  // Keys before teams, matching the read endpoint's own order.
  scopes.sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'api_key' ? -1 : 1));

  return { scopes, isEmpty: scopes.length === 0 };
}
