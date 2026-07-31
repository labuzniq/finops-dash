/**
 * Ad-hoc check of the web app's governance derivations against a real
 * mock-source budget snapshot. Not a test suite (the repo has none) — run it by
 * hand, with the API's env loaded:
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-budgets.ts
 *
 * It sits outside apps/api's tsconfig `include` on purpose: it imports the web
 * app's metrics modules, which do not belong in the API's build.
 *
 * What it proves:
 *
 * - every state the mock plants is classified as the state it was planted as —
 *   an uncapped key, a key past its soft budget, a key driven into overrun by
 *   its own batch burst, and a blocked one — so the card's badges are checked
 *   against the generator's intent rather than against themselves;
 * - null and zero stay opposite: an uncapped row has no utilization, no
 *   remaining and no percentage, while a `maxBudget: 0` row is *blocked*, and
 *   neither is ever rendered as "$0 of $0";
 * - the two scopes are kept apart. A key's cap and its team's cap govern the
 *   same dollars, so the derivation must never merge them — and, on the mock,
 *   every key's period spend is at least its team's would-be share, which is
 *   the arithmetic reason merging them would double-count;
 * - the sort is the one the card claims: blocked first, then descending share
 *   of cap, uncapped last ranked by dollars — so the biggest ungoverned
 *   consumer is the first row a reader meets after the problems;
 * - the pace projection only answers when it can. A period less than a sixth
 *   elapsed projects null rather than multiplying one morning by thirty, a
 *   counter with no period projects null because it has no end to project to,
 *   and `spend ÷ elapsed` is exactly reproduced where it does answer;
 * - `budgetPeriodStart` walks months on the calendar: a monthly budget resetting
 *   on 1 March started on 1 February, and the elapsed fraction derived from it
 *   is inside [0,1] for every mock row;
 * - the empty cases behave: a proxy that refuses the management routes yields no
 *   scopes at all (which the card words as "refused or ungoverned", since the
 *   two are indistinguishable from here) rather than an empty table.
 */
import { MockGatewayClient } from '../src/gateway/mock.js';
import { nanoToDollars } from '../src/lib/nano.js';
import { budgetPeriodStart, budgetUtilization } from '@dash/shared';
import type { GatewayBudget } from '@dash/shared';
import {
  DEFAULT_BUDGET_OPTIONS,
  deriveBudgets,
} from '../../web/src/lib/metrics/gatewayBudgets.js';
import type { BudgetRow } from '../../web/src/lib/metrics/gatewayBudgets.js';

const client = new MockGatewayClient();

const snapshot = await client.fetchBudgets();
const budgets: GatewayBudget[] = snapshot.map((row) => ({
  scope: row.scope,
  key: row.key,
  label: row.label,
  spend: nanoToDollars(row.spendNano),
  maxBudget: row.maxBudgetNano === null ? null : nanoToDollars(row.maxBudgetNano),
  softBudget: row.softBudgetNano === null ? null : nanoToDollars(row.softBudgetNano),
  budgetDuration: row.budgetDuration,
  resetAt: row.resetAt === null ? null : row.resetAt.toISOString(),
  tpmLimit: row.tpmLimit,
  rpmLimit: row.rpmLimit,
  blocked: row.blocked,
}));

const now = new Date();
const summary = deriveBudgets(budgets, now);

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};
const near = (a: number, b: number, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
const money = (value: number | null) => (value === null ? 'n/a' : `$${value.toFixed(2)}`);

const keys = summary.scopes.find((scope) => scope.scope === 'api_key');
const teams = summary.scopes.find((scope) => scope.scope === 'team');

console.log(`budgets: ${budgets.length} rows · ${summary.scopes.length} scopes`);

// ------------------------------------------------------------------- shape

check(!summary.isEmpty, 'the mock reported no budgets at all');
check(keys !== undefined && teams !== undefined, 'a scope is missing from the derivation');
check(
  summary.scopes[0]?.scope === 'api_key',
  'keys must come before teams — the read endpoint orders them that way',
);
check(
  (keys?.total ?? 0) + (teams?.total ?? 0) === budgets.length,
  'the scopes did not partition the rows',
);
check(
  keys?.rows.every((row) => row.budget.scope === 'api_key') === true &&
    teams?.rows.every((row) => row.budget.scope === 'team') === true,
  'a row landed in the wrong scope',
);

if (keys === undefined || teams === undefined) {
  console.error('cannot continue without both scopes');
  process.exit(1);
}

const byAlias = new Map(keys.rows.map((row) => [row.budget.label ?? row.budget.key, row]));
const row = (alias: string): BudgetRow | undefined => byAlias.get(alias);

for (const entry of keys.rows) {
  console.log(
    `  ${(entry.budget.label ?? entry.budget.key).padEnd(22)} ${entry.state.padEnd(9)} ` +
      `${money(entry.budget.spend).padStart(10)} of ${money(entry.budget.maxBudget).padStart(9)} ` +
      `· ${entry.utilization === null ? 'n/a' : `${entry.utilization.toFixed(1)}%`} ` +
      `· pace ${money(entry.projectedSpend)}` +
      `${entry.projectedOverrun ? ' · pacing over' : ''}`,
  );
}

// ------------------------------------------------- the states the mock plants

const uncapped = row('copilot-agents');
check(uncapped?.state === 'uncapped', 'the deliberately uncapped key was not classified uncapped');
check(
  uncapped?.utilization === null && uncapped?.remaining === null && uncapped?.softMark === null,
  'an uncapped key must have no utilization, no remaining and no soft mark — nothing to divide by',
);
check(uncapped?.budget.spend !== undefined && uncapped.budget.spend > 0, 'the uncapped key reported no spend — a counter with no period still counts');
check(uncapped?.rateLimited === true, 'the uncapped key is rate-limited instead and that was lost');
check(uncapped?.projectedSpend === null, 'a counter that never resets has no period end to project to');

const blocked = row('sandbox-experiments');
check(blocked?.state === 'blocked', 'the administratively blocked key was not classified blocked');
check(blocked?.blockReason === 'disabled', 'the block reason must be the admin flag, not the cap');
check(
  blocked?.budget.maxBudget === 30 && blocked.budget.budgetDuration === '7d',
  'the blocked key lost its weekly cap',
);

const batch = row('data-platform-etl');
check(batch !== undefined, 'the batch key is missing');
check(
  batch !== undefined && (batch.state === 'over' || batch.state === 'soft'),
  `the batch key should be past its soft budget by now, was ${batch?.state}`,
);
check(
  batch?.softMark !== null && batch?.softMark !== undefined && near(batch.softMark, 80, 0.01),
  'the batch key soft mark should sit at 80% of its cap',
);

// Overrun is not clamped: a proxy bills past a cap on in-flight requests and
// hiding it would make the one state nobody can undo the least visible.
for (const entry of [...keys.rows, ...teams.rows]) {
  if (entry.state !== 'over') continue;
  check(
    entry.utilization !== null && entry.utilization > 100,
    `${entry.budget.key} is 'over' but its utilization was clamped to ${entry.utilization}`,
  );
  check(
    entry.remaining !== null && entry.remaining < 0,
    `${entry.budget.key} is over budget but reports non-negative remaining`,
  );
}

// ------------------------------------------------------- null is never zero

for (const entry of [...keys.rows, ...teams.rows]) {
  const budget = entry.budget;
  check(
    (budget.maxBudget === null) === (entry.utilization === null && entry.remaining === null),
    `${budget.key}: uncapped and capped must not both produce a number`,
  );
  check(
    budget.maxBudget !== 0 || entry.state === 'blocked',
    `${budget.key}: a $0 cap is a block, not a budget`,
  );
  check(
    entry.utilization === null || near(entry.utilization, budgetUtilization(budget) ?? -1),
    `${budget.key}: utilization disagrees with the shared helper`,
  );
}

// A synthetic zero-cap row — the mock has none, and it is the case that would
// otherwise render as the least-constrained key rather than the strictest.
const zeroCap = deriveBudgets(
  [
    {
      scope: 'api_key',
      key: 'closed',
      label: 'closed-key',
      spend: 0,
      maxBudget: 0,
      softBudget: null,
      budgetDuration: '1mo',
      resetAt: null,
      tpmLimit: null,
      rpmLimit: null,
      blocked: false,
    },
  ],
  now,
).scopes[0]?.rows[0];
check(zeroCap?.state === 'blocked', 'a $0 cap must classify as blocked');
check(zeroCap?.blockReason === 'zero-cap', 'a $0 cap must say why it is blocked');
check(zeroCap?.utilization === null, 'a $0 cap has no percentage — there is nothing to divide by');

// --------------------------------------------------------------- the ordering

const rank = (entry: BudgetRow): number =>
  entry.state === 'blocked' ? Infinity : (entry.utilization ?? -Infinity);
for (const scope of summary.scopes) {
  for (let index = 1; index < scope.rows.length; index += 1) {
    const previous = scope.rows[index - 1];
    const current = scope.rows[index];
    if (previous === undefined || current === undefined) continue;
    check(
      rank(previous) >= rank(current) ||
        (rank(previous) === rank(current) && previous.budget.spend >= current.budget.spend),
      `${scope.scope}: ${current.budget.key} outranks ${previous.budget.key} but sorts after it`,
    );
  }
  const uncappedRows = scope.rows.filter((entry) => entry.state === 'uncapped');
  const lastCapped = scope.rows.findLastIndex((entry) => entry.state !== 'uncapped');
  check(
    uncappedRows.length === 0 || scope.rows.findIndex((entry) => entry.state === 'uncapped') > lastCapped,
    `${scope.scope}: an uncapped row sorted above a capped one — "no budget" is not a small budget`,
  );
}

// ------------------------------------------------------------ the two scopes

// The mock gives every key a team of its own with a wider cap, which is exactly
// the shape that makes summing the scopes wrong: the same dollars are governed
// twice, once by each. Assert the containment rather than any total.
const teamOf = new Map(teams.rows.map((entry) => [entry.budget.key, entry]));
check(teamOf.size === teams.total, 'team keys are not unique');
check(
  keys.rows.every((entry) => !teamOf.has(entry.budget.key)),
  'a key id collided with a team id — the two scopes would merge',
);

const monthlyTeamCaps = teams.rows
  .filter((entry) => entry.budget.maxBudget !== null)
  .map((entry) => entry.budget.maxBudget ?? 0);
check(monthlyTeamCaps.length > 0, 'no team carries a cap');

// ---------------------------------------------------------------- the pace

for (const entry of [...keys.rows, ...teams.rows]) {
  const { budget } = entry;
  if (budget.budgetDuration === null) {
    check(
      entry.periodStart === null && entry.periodElapsed === null && entry.projectedSpend === null,
      `${budget.key}: a counter with no duration must project nothing`,
    );
    continue;
  }
  check(
    entry.periodStart !== null && entry.periodStart === budgetPeriodStart(budget),
    `${budget.key}: period start disagrees with the shared helper`,
  );
  check(
    entry.periodElapsed !== null && entry.periodElapsed >= 0 && entry.periodElapsed <= 1,
    `${budget.key}: elapsed fraction ${entry.periodElapsed} is outside [0,1]`,
  );
  if (entry.periodElapsed !== null && entry.periodElapsed >= DEFAULT_BUDGET_OPTIONS.minElapsed) {
    check(
      entry.projectedSpend !== null &&
        near(entry.projectedSpend, budget.spend / entry.periodElapsed, 1e-6),
      `${budget.key}: the projection is not spend ÷ elapsed`,
    );
    check(
      entry.projectedSpend === null || entry.projectedSpend >= budget.spend - 1e-9,
      `${budget.key}: a projection below what is already spent`,
    );
  } else {
    check(
      entry.projectedSpend === null,
      `${budget.key}: projected from only ${((entry.periodElapsed ?? 0) * 100).toFixed(1)}% of the period`,
    );
  }
}

// A month one day in must not project, and the same row late in the month must.
const monthly = (elapsedDays: number, periodDays: number, spend: number): BudgetRow | undefined => {
  const reset = new Date(now.getTime() + (periodDays - elapsedDays) * 86_400_000);
  return deriveBudgets(
    [
      {
        scope: 'api_key',
        key: 'paced',
        label: 'paced',
        spend,
        maxBudget: 1_000,
        softBudget: 800,
        budgetDuration: `${periodDays}d`,
        resetAt: reset.toISOString(),
        tpmLimit: null,
        rpmLimit: null,
        blocked: false,
      },
    ],
    now,
  ).scopes[0]?.rows[0];
};

const earlyMonth = monthly(1, 30, 120);
check(earlyMonth?.projectedSpend === null, 'a month one day in must not project $3,600 from one day');
check(earlyMonth?.projectedOverrun === false, 'nothing may be flagged from an unprojectable period');

const midMonth = monthly(15, 30, 600);
check(
  midMonth?.projectedSpend !== null && near(midMonth.projectedSpend, 1_200, 1),
  `half a month at $600 must project $1,200, got ${money(midMonth?.projectedSpend ?? null)}`,
);
check(midMonth?.projectedOverrun === true, 'a row pacing past its cap must be flagged');
check(midMonth?.state === 'warn' || midMonth?.state === 'ok', 'a pacing row is not yet over budget');

const comfortable = monthly(15, 30, 300);
check(comfortable?.projectedOverrun === false, 'a row pacing under its cap must not be flagged');
check(comfortable?.state === 'ok', 'a row at 30% of its cap is not in a warning state');

// The derived warning threshold is weaker evidence than a configured soft
// budget, so it must be a different state, not folded into it.
const noSoft = deriveBudgets(
  [
    {
      scope: 'api_key',
      key: 'nosoft',
      label: 'nosoft',
      spend: 900,
      maxBudget: 1_000,
      softBudget: null,
      budgetDuration: null,
      resetAt: null,
      tpmLimit: null,
      rpmLimit: null,
      blocked: false,
    },
  ],
  now,
).scopes[0]?.rows[0];
check(noSoft?.state === 'warn', '90% of a cap with no soft budget must warn, not read as ok');
check(noSoft?.softMark === null, 'no soft budget means no mark on the bar');

// ------------------------------------------------------------------- counts

for (const scope of summary.scopes) {
  const states = scope.rows.map((entry) => entry.state);
  check(
    scope.blocked === states.filter((state) => state === 'blocked').length &&
      scope.over === states.filter((state) => state === 'over').length &&
      scope.soft === states.filter((state) => state === 'soft').length &&
      scope.warn === states.filter((state) => state === 'warn').length &&
      scope.uncapped === states.filter((state) => state === 'uncapped').length,
    `${scope.scope}: the state counts disagree with the rows`,
  );
  check(
    scope.capped + scope.uncapped === scope.total,
    `${scope.scope}: capped + uncapped must be every row`,
  );
  check(
    scope.attention <= scope.total && scope.attention >= scope.blocked + scope.over + scope.soft,
    `${scope.scope}: the attention count does not cover its own states`,
  );
}
check(keys.attention > 0, 'the mock plants a blocked key and an overrun one — attention cannot be 0');

// -------------------------------------------------------------------- edges

const empty = deriveBudgets([], now);
check(empty.isEmpty && empty.scopes.length === 0, 'an empty budget list must produce no scopes');
check(deriveBudgets(undefined, now).isEmpty, 'an unanswered query must produce no scopes');

// -------------------------------------------------------------------- verdict

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('\nall gateway budget checks passed');
