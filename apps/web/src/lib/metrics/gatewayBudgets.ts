import {
  DEFAULT_BUDGET_ASSESSMENT_OPTIONS,
  GATEWAY_BUDGET_SCOPES,
  assessBudget,
  budgetCounterResets,
} from '@dash/shared';
import type {
  GatewayBudget,
  GatewayBudgetAssessment,
  GatewayBudgetAssessmentOptions,
  GatewayBudgetBlockReason,
  GatewayBudgetScope,
  GatewayBudgetState,
} from '@dash/shared';

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
 *  - **Scopes never combine.** A key's cap, its team's cap and its tag's cap all
 *    govern the same dollars — spending under the key is spending under the team
 *    and under whatever the call was tagged — exactly like the overlapping
 *    breakdown dimensions. The card is a switcher for the same reason the
 *    breakdown card is. The three do not even cover the same population: a
 *    proxy typically caps every key and only the tags somebody worried about.
 *  - **Null is not zero.** `maxBudget: null` is uncapped; `maxBudget: 0` rejects
 *    every call. They are opposite states and the sort has to place them at
 *    opposite ends, not next to each other at "$0".
 *
 * Pure, like every module in `lib/metrics/` — it reads the payload already in
 * memory and never fetches. `now` is a parameter rather than a `Date.now()`
 * call so the pace projection is testable.
 */

/**
 * The state machine and the pace projection both live in `@dash/shared`
 * (`assessBudget`), not here, because the API evaluates the same snapshot after
 * every sync to decide what to notify about. Re-stating "over its cap" in the
 * browser would let a notification and the card it links to disagree. What stays
 * in this module is everything that is about the *card*: grouping, ordering and
 * the counts a headline can carry.
 */
export type BudgetState = GatewayBudgetState;
export type BlockReason = GatewayBudgetBlockReason;

export interface BudgetRow extends GatewayBudgetAssessment {
  budget: GatewayBudget;
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
  /**
   * Every row in this scope carries a counter the proxy never resets, so the
   * scope needs one caveat rather than a badge on each of its rows. Read off
   * the scope, not off the rows, so it is still true of an empty one.
   */
  spendIsCumulative: boolean;
}

export interface BudgetSummary {
  scopes: BudgetScopeSummary[];
  /** No governed object at all — a proxy that refused the management routes, or a fresh sync. */
  isEmpty: boolean;
}

export type BudgetOptions = GatewayBudgetAssessmentOptions;

export const DEFAULT_BUDGET_OPTIONS: BudgetOptions = DEFAULT_BUDGET_ASSESSMENT_OPTIONS;

/** Sort key: blocked first, then by share of cap consumed, uncapped last. */
function rank(row: BudgetRow): number {
  if (row.state === 'blocked') return Number.POSITIVE_INFINITY;
  if (row.utilization === null) return Number.NEGATIVE_INFINITY;
  return row.utilization;
}

function toRow(budget: GatewayBudget, now: Date, options: BudgetOptions): BudgetRow {
  return { budget, ...assessBudget(budget, now, options) };
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
      spendIsCumulative: !budgetCounterResets(scope),
    });
  }

  // Scopes render in the shared const's order rather than in whatever order the
  // payload grouped them, so a proxy with no teams does not silently move the
  // tag switcher into the team's place. That const is also the read endpoint's
  // own order, so the switcher and the payload agree.
  //
  // One sort, not two: a second pass of `a.scope === 'api_key' ? -1 : 1` is not
  // a consistent comparator once a third scope exists — it answers "after" for
  // both team-vs-tag and tag-vs-team, which put `tag` ahead of `team`.
  scopes.sort(
    (a, b) => GATEWAY_BUDGET_SCOPES.indexOf(a.scope) - GATEWAY_BUDGET_SCOPES.indexOf(b.scope),
  );

  return { scopes, isEmpty: scopes.length === 0 };
}
