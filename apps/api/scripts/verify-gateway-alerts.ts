/**
 * Ad-hoc check of the web app's attention digest against a real mock-source
 * payload. Not a test suite (the repo has none) — run it by hand:
 *
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-alerts.ts
 *
 * It sits outside apps/api's tsconfig `include` on purpose: it imports the web
 * app's metrics modules, which do not belong in the API's build.
 *
 * The digest is the page's only derivation *of derivations*, so what it has to
 * prove is different from every other verify script here: not that a number is
 * right, but that it says exactly what the cards below it say — no more and no
 * less. That is two assertions in opposite directions, and both matter.
 *
 * What it proves:
 *
 * - **nothing is invented.** Every alert traces back to a row of the summary it
 *   claims to come from, in the state it claims: a budget row that really is
 *   blocked/over/soft/pacing, an anomaly date the detector really flagged, a
 *   reliability key the two gates really badged, a churning cache row, a gap
 *   that really is on the coverage report;
 * - **nothing is dropped.** The reverse direction, per source: the number of
 *   findings of each kind equals the number of flagged rows that source holds,
 *   so a digest cannot quietly stop reporting a category;
 * - the two rules that keep it from disagreeing with itself — a row currently
 *   over its cap does not also appear as a historical crossing, and a row can
 *   carry both a state finding and a pace finding because those are different
 *   claims;
 * - the ordering the card renders is the ordering the module documents:
 *   severity, then the editorial kind order, then each source's own ranking
 *   untouched (Array.sort being stable is load-bearing there);
 * - the cap costs visibility and never accuracy: the counts and `total` are
 *   identical capped and uncapped, and `truncated` closes the gap;
 * - severity is a total mapping — every kind that can be produced has a place in
 *   the order table, since a kind missing from it would sort to the front;
 * - ids are unique and stable across two derivations of the same state, which is
 *   what lets the list be a React list;
 * - silence is never read as health: an unanswered budgets query, an empty
 *   history and an unanswered coverage query each produce a blind spot, and
 *   `allClear` is only true when there is nothing to report *and* nothing
 *   unread;
 * - the dimension-scoped findings follow the switcher and the rest do not: the
 *   budget, anomaly and coverage rows are identical whichever breakdown is on
 *   screen.
 */
import { MockGatewayClient } from '../src/gateway/mock.js';
import { nanoToDollars } from '../src/lib/nano.js';
import { resolveDeploymentModel, summarizeGatewayCoverage } from '@dash/shared';
import type {
  GatewayDeployment,
  GatewayHealth,
  GatewayBreakdownPoint,
  GatewayBudget,
  GatewayBudgetHistory,
  GatewayBudgetObservation,
  GatewayCoverage,
  GatewayDailyPoint,
  GatewayUsage,
} from '@dash/shared';
import { deriveGateway } from '../../web/src/lib/metrics/gateway.js';
import {
  buildGatewayAlerts,
  KIND_ORDER,
  KIND_SEVERITY,
} from '../../web/src/lib/metrics/gatewayAlerts.js';
import type { AlertKind, GatewayAlertDigest } from '../../web/src/lib/metrics/gatewayAlerts.js';
import { detectSpendAnomalies } from '../../web/src/lib/metrics/gatewayAnomaly.js';
import { deriveBudgetHistory } from '../../web/src/lib/metrics/gatewayBudgetHistory.js';
import { deriveBudgets } from '../../web/src/lib/metrics/gatewayBudgets.js';
import { deriveGatewayCache } from '../../web/src/lib/metrics/gatewayCache.js';
import { deriveGatewayHealth } from '../../web/src/lib/metrics/gatewayHealth.js';
import { deriveReliability } from '../../web/src/lib/metrics/gatewayReliability.js';

const DAYS = 60;
const MS_PER_DAY = 86_400_000;
/** Above anything the mock can produce — the uncapped view the counts are checked on. */
const NO_CAP = { maxAlerts: 10_000 };

function iso(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
}

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

const client = new MockGatewayClient();

async function pull(from: string, to: string): Promise<GatewayUsage> {
  const snapshot = await client.fetchUsage(from, to);
  return {
    daily: snapshot.daily.map(
      (row): GatewayDailyPoint => ({ ...row, spend: nanoToDollars(row.spendNano) }),
    ),
    breakdowns: snapshot.breakdowns.map(
      (row): GatewayBreakdownPoint => ({ ...row, spend: nanoToDollars(row.spendNano) }),
    ),
  };
}

const from = iso(-(DAYS - 1));
const to = iso(0);
const usage = await pull(from, to);
const summary = deriveGateway(usage, from, to);

const budgetRows: GatewayBudget[] = (await client.fetchBudgets()).map((row) => ({
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
const budgets = deriveBudgets(budgetRows, now);
const anomalies = detectSpendAnomalies(summary.daily);
const reliability = deriveReliability(summary.daily, usage.breakdowns, 'model');
const cache = deriveGatewayCache(summary.daily, usage.breakdowns, 'api_key');

// The mock records no budget history (it accrues from real sync runs on distinct
// days — iteration 23), so the readings are planted here the way earlier syncs
// would have written them: one key driven over its cap three days ago and back
// under it since, which is the entire case the crossing alert exists for.
const CROSSED_KEY = 'sk-copilot-agents';
function observation(
  date: string,
  spend: number,
  maxBudget: number | null,
): GatewayBudgetObservation {
  return {
    scope: 'api_key',
    key: CROSSED_KEY,
    label: 'copilot-agents',
    date,
    observedAt: `${date}T02:00:00.000Z`,
    spend,
    maxBudget,
    softBudget: null,
    budgetDuration: '30d',
    resetAt: null,
    tpmLimit: null,
    rpmLimit: null,
    blocked: false,
  };
}

const historyPayload: GatewayBudgetHistory = {
  from: iso(-5),
  to: iso(0),
  recordingSince: iso(-5),
  observations: [
    observation(iso(-5), 400, 1_000),
    observation(iso(-4), 900, 1_000),
    // Over on this day: the counter passed a cap that has not moved.
    observation(iso(-3), 1_100, 1_000),
    // Rolled: a new period, comfortably under. Today's snapshot shows nothing.
    observation(iso(-2), 120, 1_000),
    observation(iso(-1), 300, 1_000),
    observation(iso(0), 480, 1_000),
  ],
};
const history = deriveBudgetHistory(historyPayload);

// A coverage report with one fillable run and one the proxy has pruned.
const storedDays: string[] = [];
for (let offset = -95; offset <= 0; offset++) {
  const date = iso(offset);
  // A three-day hole inside retention, and a two-day hole outside it.
  if (offset >= -10 && offset <= -8) continue;
  if (offset >= -94 && offset <= -93) continue;
  storedDays.push(date);
}
const coverage: GatewayCoverage = summarizeGatewayCoverage(storedDays, iso(0));

// The stored `/health` reading, joined to the catalogue the way the sync joins
// it — `/health` reports routing strings and never public aliases.
const catalogue = await client.fetchModels();
const checkedAt = new Date().toISOString();
const healthPayload: GatewayHealth = {
  checkedAt,
  deployments: (await client.fetchHealth()).map(
    (row): GatewayDeployment => ({
      id: row.id,
      backend: row.backend,
      model: resolveDeploymentModel(catalogue, row.backend),
      provider: row.provider,
      apiBase: row.apiBase,
      healthy: row.healthy,
      error: row.error,
      errorStatus: row.errorStatus,
      checkedAt,
    }),
  ),
};
const health = deriveGatewayHealth(healthPayload, new Date());

const inputs = {
  budgets,
  budgetsLoaded: true,
  history,
  anomalies,
  reliability,
  cache,
  coverage,
  health,
};

const digest = buildGatewayAlerts(inputs, NO_CAP);

console.log(
  `digest: ${digest.total} findings (${digest.critical} critical · ${digest.warning} warning · ${digest.info} info)`,
);
for (const entry of digest.alerts) {
  console.log(`  [${entry.severity}] ${entry.kind} · ${entry.label ?? entry.subject}`);
}
console.log(`blind spots: ${digest.blindSpots.length}`);

// ------------------------------------------------ 1. nothing is invented

const budgetByKey = new Map(
  budgets.scopes.flatMap((scope) =>
    scope.rows.map((row) => [`${row.budget.scope}:${row.budget.key}`, row] as const),
  ),
);

for (const entry of digest.alerts) {
  switch (entry.kind) {
    case 'budget-blocked':
    case 'budget-over':
    case 'budget-soft': {
      const row = budgetByKey.get(entry.subject);
      const expected = entry.kind.slice('budget-'.length);
      check(
        row !== undefined && row.state === expected,
        `${entry.kind} names ${entry.subject}, whose state is ${row?.state ?? 'missing'}`,
      );
      break;
    }
    case 'budget-pacing': {
      const row = budgetByKey.get(entry.subject);
      check(
        row !== undefined && row.projectedOverrun,
        `budget-pacing names ${entry.subject}, which the budget card does not project over`,
      );
      break;
    }
    case 'budget-crossed': {
      const row = history.rows.find((candidate) => `${candidate.scope}:${candidate.key}` === entry.subject);
      check(
        row !== undefined && row.events.some((event) => event.kind === 'over'),
        `budget-crossed names ${entry.subject}, which recorded no crossing`,
      );
      const current = budgetByKey.get(entry.subject);
      check(
        current === undefined || (current.state !== 'over' && current.state !== 'blocked'),
        `budget-crossed names ${entry.subject}, which is flagged as ${current?.state ?? '?'} right now`,
      );
      break;
    }
    case 'spend-anomaly':
      check(
        anomalies.some((anomaly) => anomaly.date === entry.subject),
        `spend-anomaly names ${entry.subject}, which the detector did not flag`,
      );
      break;
    case 'reliability-elevated': {
      const key = entry.subject.slice(`${reliability.dimension}:`.length);
      check(
        reliability.rows.some((row) => row.key === key && row.elevated),
        `reliability-elevated names ${key}, which is not badged elevated`,
      );
      break;
    }
    case 'cache-churn': {
      const key = entry.subject.slice(`${cache.dimension}:`.length);
      check(
        cache.rows.some((row) => row.key === key && row.state === 'churning'),
        `cache-churn names ${key}, which is not churning`,
      );
      break;
    }
    case 'deployment-down':
    case 'deployment-degraded': {
      const name = entry.subject.slice('model:'.length);
      const model = health.summary.models.find(
        (row) => (row.model ?? 'unnamed deployments') === name,
      );
      check(
        model?.state === (entry.kind === 'deployment-down' ? 'down' : 'degraded'),
        `${entry.kind} names ${name}, which the health summary does not hold in that state`,
      );
      break;
    }
    case 'coverage-gap':
      check(
        coverage.gaps.some((gap) => gap.to >= coverage.retentionFloor),
        'coverage-gap reported with no fillable run on the coverage report',
      );
      break;
    case 'coverage-pruned':
      check(
        coverage.gaps.some((gap) => gap.to < coverage.retentionFloor),
        'coverage-pruned reported with no pruned run on the coverage report',
      );
      break;
  }
}

// ------------------------------------------------ 2. nothing is dropped

const countOf = (kind: AlertKind) => digest.alerts.filter((entry) => entry.kind === kind).length;
const budgetRowsAll = budgets.scopes.flatMap((scope) => scope.rows);
const stateCount = (state: string) => budgetRowsAll.filter((row) => row.state === state).length;

check(
  countOf('budget-blocked') === stateCount('blocked'),
  `${countOf('budget-blocked')} blocked findings against ${stateCount('blocked')} blocked rows`,
);
check(
  countOf('budget-over') === stateCount('over'),
  `${countOf('budget-over')} overrun findings against ${stateCount('over')} overrun rows`,
);
check(
  countOf('budget-soft') === stateCount('soft'),
  `${countOf('budget-soft')} soft findings against ${stateCount('soft')} soft rows`,
);
check(
  countOf('budget-pacing') ===
    budgetRowsAll.filter(
      (row) => row.projectedOverrun && row.state !== 'over' && row.state !== 'blocked',
    ).length,
  'pacing findings do not match the rows the budget card projects over',
);
check(
  countOf('spend-anomaly') === anomalies.length,
  `${countOf('spend-anomaly')} anomaly findings against ${anomalies.length} flagged days`,
);
check(
  countOf('reliability-elevated') === reliability.rows.filter((row) => row.elevated).length,
  'elevated-key findings do not match the reliability card',
);
check(
  countOf('cache-churn') === cache.rows.filter((row) => row.state === 'churning').length,
  'churning findings do not match the cache card',
);
check(
  digest.total === digest.critical + digest.warning + digest.info,
  'the severity counts do not add up to the total',
);

// The digest counts findings and never money — the dollars on these rows come
// from different denominators. Structural, so it cannot drift into a total.
check(
  !Object.keys(digest).some((key) => /spend|dollar|amount|cost/i.test(key)),
  'the digest grew a money-shaped field, which the overlapping denominators do not permit',
);

// The crossing plant must actually be found, or the reverse checks above are
// vacuous for that kind.
check(
  countOf('budget-crossed') === 1,
  `${countOf('budget-crossed')} crossing findings, expected exactly the planted one`,
);
check(
  digest.alerts.some(
    (entry) => entry.kind === 'budget-crossed' && entry.subject === `api_key:${CROSSED_KEY}`,
  ),
  'the planted crossing is not the key that was planted',
);

check(
  countOf('deployment-down') === health.summary.down.length,
  `${countOf('deployment-down')} down findings against ${health.summary.down.length} down aliases`,
);
check(
  countOf('deployment-degraded') === health.summary.degraded.length,
  `${countOf('deployment-degraded')} degraded findings against ${health.summary.degraded.length} degraded aliases`,
);

// ------------------------------------------------ 3. the two self-consistency rules

// A row currently over its cap must not also be reported as a historical
// crossing: one problem, two rows, and the reader counts two.
const overKey = budgetRowsAll.find((row) => row.state === 'over');
if (overKey !== undefined) {
  const subject = `${overKey.budget.scope}:${overKey.budget.key}`;
  const alsoCrossed: GatewayBudgetHistory = {
    from: iso(-3),
    to: iso(0),
    recordingSince: iso(-3),
    observations: [
      { ...observation(iso(-3), 100, 1_000), scope: overKey.budget.scope, key: overKey.budget.key },
      { ...observation(iso(-2), 1_400, 1_000), scope: overKey.budget.scope, key: overKey.budget.key },
      { ...observation(iso(-1), 200, 1_000), scope: overKey.budget.scope, key: overKey.budget.key },
      { ...observation(iso(0), 400, 1_000), scope: overKey.budget.scope, key: overKey.budget.key },
    ],
  };
  const doubled = buildGatewayAlerts(
    { ...inputs, history: deriveBudgetHistory(alsoCrossed) },
    NO_CAP,
  );
  const forKey = doubled.alerts.filter((entry) => entry.subject === subject);
  check(
    forKey.length === 1 && forKey[0]?.kind === 'budget-over',
    `a key that is over now and crossed before produced ${forKey.length} findings, expected one`,
  );
}

// ...while a state finding and a pace finding about one row are two different
// claims and both belong.
const bothRow = budgetRowsAll.find((row) => row.state === 'soft' && row.projectedOverrun);
if (bothRow !== undefined) {
  const subject = `${bothRow.budget.scope}:${bothRow.budget.key}`;
  // Scoped to the budget source: an `api_key` subject can legitimately also
  // carry a cache or reliability finding about the same key, and those are
  // other cards' claims rather than a duplicated budget one.
  const kinds = digest.alerts
    .filter((entry) => entry.subject === subject && entry.source === 'budget')
    .map((entry) => entry.kind)
    .sort();
  check(
    kinds.length === 2 && kinds.includes('budget-soft') && kinds.includes('budget-pacing'),
    `a soft row pacing over produced ${kinds.join(', ') || 'nothing'}, expected both findings`,
  );
}

// ------------------------------------------------ 4. ordering

const rank = { critical: 0, warning: 1, info: 2 };
let ordered = true;
for (let i = 1; i < digest.alerts.length; i++) {
  const previous = digest.alerts[i - 1];
  const current = digest.alerts[i];
  if (previous === undefined || current === undefined) continue;
  const bySeverity = rank[previous.severity] - rank[current.severity];
  if (bySeverity > 0) ordered = false;
  if (
    bySeverity === 0 &&
    KIND_ORDER.indexOf(previous.kind) > KIND_ORDER.indexOf(current.kind)
  ) {
    ordered = false;
  }
}
check(ordered, 'the digest is not ordered by severity then editorial kind order');

// Within one kind, each source's own ranking survives untouched — the reliability
// card ranks by excess failures and the digest must not re-rank it.
const elevatedOrder = reliability.rows.filter((row) => row.elevated).map((row) => row.key);
const digestOrder = digest.alerts
  .filter((entry) => entry.kind === 'reliability-elevated')
  .map((entry) => entry.subject.slice(`${reliability.dimension}:`.length));
check(
  JSON.stringify(elevatedOrder) === JSON.stringify(digestOrder),
  `reliability findings reordered: ${digestOrder.join(', ')} against ${elevatedOrder.join(', ')}`,
);

// Every kind that can be produced has a place in the order table. A kind missing
// from it gets indexOf === -1 and silently sorts to the front of its band.
const kinds = Object.keys(KIND_SEVERITY) as AlertKind[];
check(
  kinds.every((kind) => KIND_ORDER.includes(kind)) && KIND_ORDER.length === kinds.length,
  'KIND_ORDER and KIND_SEVERITY disagree about which kinds exist',
);

// ------------------------------------------------ 5. the cap

const capped = buildGatewayAlerts(inputs, { maxAlerts: 3 });
check(capped.alerts.length === Math.min(3, digest.total), 'the cap did not limit the list');
check(
  capped.total === digest.total &&
    capped.critical === digest.critical &&
    capped.warning === digest.warning &&
    capped.info === digest.info,
  'the cap changed the counts — it must cost visibility, never accuracy',
);
check(
  capped.truncated === Math.max(0, digest.total - 3),
  `truncated reads ${capped.truncated}, expected ${Math.max(0, digest.total - 3)}`,
);
check(
  JSON.stringify(capped.alerts) === JSON.stringify(digest.alerts.slice(0, 3)),
  'the capped list is not the head of the full one',
);

// ------------------------------------------------ 6. ids

const ids = new Set(digest.alerts.map((entry) => entry.id));
check(ids.size === digest.alerts.length, 'two findings share an id');
const again = buildGatewayAlerts(inputs, NO_CAP);
check(
  JSON.stringify(again.alerts.map((entry) => entry.id)) ===
    JSON.stringify(digest.alerts.map((entry) => entry.id)),
  'ids are not stable across two derivations of the same state',
);

// ------------------------------------------------ 7. silence is not health

const emptyBudgets = deriveBudgets([], now);
const emptyHistory = deriveBudgetHistory(undefined);
const quiet = {
  budgets: emptyBudgets,
  budgetsLoaded: false,
  history: emptyHistory,
  anomalies: [],
  reliability: deriveReliability([], [], 'model'),
  cache: deriveGatewayCache([], [], 'api_key'),
  coverage: null,
  health: deriveGatewayHealth(null, now),
};
const quietDigest = buildGatewayAlerts(quiet);
check(quietDigest.total === 0, 'an unread gateway produced findings');
check(!quietDigest.allClear, 'an unread gateway reported all clear');
check(
  quietDigest.blindSpots.length >= 3,
  `an unread gateway named ${quietDigest.blindSpots.length} blind spots, expected the budgets, coverage and traffic ones`,
);

// A healthy gateway that *was* read: no findings, no blind spots, all clear.
const healthySpine = summary.daily.map((day) => ({ ...day, failedRequests: 0 }));
const healthy: GatewayAlertDigest = buildGatewayAlerts({
  budgets: deriveBudgets(
    [
      {
        scope: 'api_key',
        key: 'sk-fine',
        label: 'fine',
        spend: 10,
        maxBudget: 1_000,
        softBudget: null,
        budgetDuration: '30d',
        resetAt: new Date(now.getTime() + 15 * MS_PER_DAY).toISOString(),
        tpmLimit: null,
        rpmLimit: null,
        blocked: false,
      },
    ],
    now,
  ),
  budgetsLoaded: true,
  history: deriveBudgetHistory({
    from: iso(-1),
    to: iso(0),
    recordingSince: iso(-1),
    observations: [
      { ...observation(iso(-1), 8, 1_000), key: 'sk-fine', label: 'fine' },
      { ...observation(iso(0), 10, 1_000), key: 'sk-fine', label: 'fine' },
    ],
  }),
  anomalies: [],
  reliability: deriveReliability(healthySpine, [], 'model'),
  cache: deriveGatewayCache(healthySpine, [], 'api_key'),
  coverage: summarizeGatewayCoverage(
    summary.daily.map((day) => day.date),
    iso(0),
  ),
  health: deriveGatewayHealth(
    {
      checkedAt,
      deployments: healthPayload.deployments.map((row) => ({
        ...row,
        healthy: true,
        error: null,
        errorStatus: null,
      })),
    },
    new Date(),
  ),
});
check(
  healthy.allClear && healthy.total === 0 && healthy.blindSpots.length === 0,
  `a healthy read gateway reported ${healthy.total} findings and ${healthy.blindSpots.length} blind spots, expected all clear`,
);

// A gateway whose budgets answered but whose history has one reading: the
// crossing question is unanswerable and must be said, not assumed clean.
const thin = buildGatewayAlerts({
  ...inputs,
  history: deriveBudgetHistory({
    from: iso(0),
    to: iso(0),
    recordingSince: iso(0),
    observations: [observation(iso(0), 480, 1_000)],
  }),
});
check(
  thin.blindSpots.some((spot) => /readings/.test(spot)),
  'a one-reading history did not produce a blind spot about crossings',
);

// ------------------------------------------------ 8. dimension scoping

const byKey = buildGatewayAlerts(
  {
    ...inputs,
    reliability: deriveReliability(summary.daily, usage.breakdowns, 'api_key'),
    cache: deriveGatewayCache(summary.daily, usage.breakdowns, 'model'),
  },
  NO_CAP,
);
check(byKey.dimension === 'api_key', 'the digest does not report the dimension it read');
const scopeFree = (value: GatewayAlertDigest) =>
  value.alerts
    .filter((entry) => entry.source !== 'reliability' && entry.source !== 'cache')
    .map((entry) => entry.id);
check(
  JSON.stringify(scopeFree(byKey)) === JSON.stringify(scopeFree(digest)),
  'switching the breakdown dimension moved findings that do not depend on it',
);

// ------------------------------------------------ verdict

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('\nall alert checks passed');
