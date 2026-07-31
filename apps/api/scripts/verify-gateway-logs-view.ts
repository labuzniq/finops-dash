/**
 * Ad-hoc check of the web app's request-log view — the matrix, the latency
 * read, and the deployment split. Not a test suite (the repo has none) — run it
 * by hand:
 *
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-logs-view.ts
 *
 * `verify-litellm-contract.ts` covers the `/spend/logs` wire and
 * `verify-gateway-logs.ts` covers the shared cross-tab and the mock's rows.
 * What is left, and what this script is for, is what the *page* does with a
 * sample:
 *
 *  - **Capping happens here, and it has to be reported.** `crossTabSpendLogs`
 *    is deliberately not allowed to truncate — dropping keys would leave its
 *    axis totals disagreeing with the cells that survived — so the view is
 *    where the axes are cut, and a cut that says nothing turns a 40-key gateway
 *    into an 8-key one.
 *  - **The heat scale is a scale, not a share.** It is taken over the *drawn*
 *    cells: a matrix whose brightest cell sits outside the grid would render
 *    every visible one dim, which reads as "nothing here" rather than as
 *    "cropped".
 *  - **The three states that all draw an empty table mean different things.**
 *    Not asked yet, refused (`disable_spend_logs`), and answered-with-nothing
 *    are separate answers, and the third is not a fault at all.
 *  - **The completeness figure is in requests.** A share of gateway *spend*
 *    taken from a capped sample is the one number this layer must never
 *    produce, so the denominator is the ledger's own request count and the
 *    ratio can never exceed one.
 *  - **A deployment row is only a finding above a floor.** A pool that served
 *    three requests has a failure rate of 0% or 33% and neither means anything.
 *
 * The mock half then drives `MockGatewayClient.fetchSpendLogs` through the same
 * derivation the page runs, which is what proves the split view finds the
 * refusing PTU pool behind a healthy-looking alias — the finding that is the
 * reason this layer exists.
 *
 * Like its siblings it sits outside apps/api's tsconfig `include`: a harness,
 * not part of the API build.
 */
import { crossTabSpendLogs, SPEND_LOG_MAX_WINDOW_DAYS } from '@dash/shared';
import type { GatewayDailyPoint, GatewaySpendLog, GatewaySpendLogs } from '@dash/shared';
import { MockGatewayClient } from '../src/gateway/mock.js';
import type { GatewaySpendLogRecord } from '../src/gateway/types.js';
import {
  cellId,
  deriveSpendLogs,
  DEPLOYMENT_MIN_REQUESTS,
  ledgerRequestsIn,
  MATRIX_COLUMN_CAP,
  MATRIX_ROW_CAP,
  spendLogWindow,
} from '../../web/src/lib/metrics/gatewayLogs.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
};

const near = (a: number, b: number, epsilon = 1e-9): boolean => Math.abs(a - b) <= epsilon;

// ------------------------------------------------------------ fixtures

function madeLog(over: Partial<GatewaySpendLog> = {}): GatewaySpendLog {
  return {
    requestId: 'req',
    callType: 'acompletion',
    startTime: '2026-07-01T09:00:00.000Z',
    endTime: '2026-07-01T09:00:01.000Z',
    durationMs: 1_000,
    model: 'gpt-4o-eu2',
    modelGroup: 'azure/gpt-4o',
    deploymentId: 'dep-payg',
    provider: 'azure',
    apiBase: null,
    apiKey: 'hash-a',
    keyAlias: 'copilot-agents',
    user: 'ana@corp.example',
    teamId: 'team-platform',
    teamAlias: 'Platform',
    endUser: null,
    tags: ['chat'],
    mcpTool: null,
    sessionId: null,
    agentId: null,
    spend: 0.01,
    promptTokens: 900,
    completionTokens: 100,
    totalTokens: 1_000,
    cacheHit: false,
    status: 'success',
    ...over,
  };
}

function madePayload(rows: GatewaySpendLog[], over: Partial<GatewaySpendLogs> = {}): GatewaySpendLogs {
  return {
    from: '2026-07-01',
    to: '2026-07-03',
    rows,
    available: true,
    truncated: false,
    fetchedAt: '2026-07-04T08:00:00.000Z',
    ...over,
  };
}

function madeDay(date: string, requests: number, spend = 100): GatewayDailyPoint {
  return {
    date,
    spend,
    requests,
    successfulRequests: requests,
    failedRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

const AXES = { rowDimension: 'team', columnDimension: 'model' } as const;

// =====================================================================
// 1 · the three silences
// =====================================================================

console.log('1 · not asked, refused, and answered-with-nothing');

const unasked = deriveSpendLogs(null, AXES);
check(!unasked.answered, 'an unfetched sample has not answered');
check(
  !unasked.available && !unasked.isEmpty && unasked.window === null && unasked.rows.length === 0,
  'and claims nothing about the proxy — no window, no availability, no emptiness',
);
check(
  unasked.latency.p50Ms === null && unasked.latency.timed === 0,
  'no latency is invented out of a sample that was never read',
);

const refused = deriveSpendLogs(madePayload([], { available: false }), AXES);
check(
  refused.answered && !refused.available && !refused.isEmpty,
  'a refused route has answered and is not available — and is NOT "empty", which would read as a quiet gateway',
);
check(refused.window !== null, 'it still carries the window it asked about');

const nothing = deriveSpendLogs(madePayload([]), AXES);
check(
  nothing.answered && nothing.available && nothing.isEmpty,
  'a route that answered with no rows is available and empty — a different answer from refused',
);
check(
  nothing.sampleRequests === 0 && nothing.sampleSpend === 0 && nothing.deployments.length === 0,
  'and derives nothing from nothing',
);

// =====================================================================
// 2 · the window
// =====================================================================

console.log('\n2 · the window is the tail of the spine');

const spine = Array.from({ length: 30 }, (_, index) =>
  madeDay(`2026-06-${String(index + 1).padStart(2, '0')}`, 100 + index),
);

const tail = spendLogWindow(spine);
check(tail !== null && tail.to === '2026-06-30', 'the window ends on the last day of the trimmed spine, not on today');
check(
  tail !== null && tail.from === '2026-06-24' && tail.days === SPEND_LOG_MAX_WINDOW_DAYS,
  `and is exactly ${SPEND_LOG_MAX_WINDOW_DAYS} days long — the route's own cap`,
);

const short = spendLogWindow(spine.slice(0, 3));
check(
  short !== null && short.from === '2026-06-01' && short.to === '2026-06-03',
  'a spine shorter than the cap is not padded backwards past its own first day',
);
check(spendLogWindow([]) === null, 'an empty spine has no window — there is nothing to be evidence about');

const ledger = ledgerRequestsIn(spine, tail);
const expected = spine.filter((day) => day.date >= '2026-06-24').reduce((sum, day) => sum + day.requests, 0);
check(ledger === expected, `the ledger count covers only the days in the window (${ledger} of ${spine.length} days' worth)`);
check(
  ledgerRequestsIn(spine, { from: '2025-01-01', to: '2025-01-07', days: 7 }) === null,
  'a window the spine does not cover has no ledger count rather than a zero — unknown is not none',
);

// =====================================================================
// 3 · capping, and saying so
// =====================================================================

console.log('\n3 · the matrix is cut here, and reports the cut');

const wide: GatewaySpendLog[] = [];
for (let team = 0; team < MATRIX_ROW_CAP + 3; team++) {
  for (let model = 0; model < MATRIX_COLUMN_CAP + 2; model++) {
    wide.push(
      madeLog({
        teamId: `team-${String(team).padStart(2, '0')}`,
        modelGroup: `model-${String(model).padStart(2, '0')}`,
        // Descending, so the ranking is knowable: the lowest indices lead.
        spend: (MATRIX_ROW_CAP + 3 - team) * 10 + (MATRIX_COLUMN_CAP + 2 - model),
      }),
    );
  }
}

const cut = deriveSpendLogs(madePayload(wide), AXES);
check(cut.rows.length === MATRIX_ROW_CAP && cut.columns.length === MATRIX_COLUMN_CAP, 'the axes are capped');
check(
  cut.hiddenRows === 3 && cut.hiddenColumns === 2,
  `and the keys that did not fit are counted rather than dropped silently (${cut.hiddenRows} rows, ${cut.hiddenColumns} columns)`,
);
check(
  cut.rows[0]?.key === 'team-00' && cut.columns[0]?.key === 'model-00',
  'the axes are ranked by sample spend, heaviest first',
);
check(
  cut.cells.size === MATRIX_ROW_CAP * MATRIX_COLUMN_CAP,
  'only the cells inside the drawn grid are carried — the rest would never be read',
);
check(
  cut.cells.get(cellId('team-00', `model-${String(MATRIX_COLUMN_CAP + 1).padStart(2, '0')}`)) === undefined,
  'a pair whose column was cut has no cell',
);

const full = crossTabSpendLogs(wide, 'team', 'model');
check(
  full.sampleSpend === cut.sampleSpend && cut.sampleRequests === wide.length,
  'the totals above the matrix still cover every key, including the ones not drawn',
);

const heaviest = cut.cells.get(cellId('team-00', 'model-00'));
check(heaviest !== undefined && near(heaviest.intensity, 1), 'the heaviest drawn cell is the top of the scale');
check(
  [...cut.cells.values()].every((cell) => cell.intensity >= 0 && cell.intensity <= 1),
  'and every other drawn cell is scaled against it, never against a cell nobody can see',
);

// =====================================================================
// 4 · what the sample refuses to claim
// =====================================================================

console.log('\n4 · a sample says how thin it is, in requests');

const modest = deriveSpendLogs(madePayload([madeLog(), madeLog(), madeLog()]), {
  ...AXES,
  ledgerRequests: 300,
});
check(modest.sampledShare !== null && near(modest.sampledShare, 0.01), 'the completeness figure is sample ÷ ledger requests');
check(
  deriveSpendLogs(madePayload([madeLog()]), AXES).sampledShare === null,
  'with no ledger count there is no share at all — an unknown denominator is not a full one',
);
check(
  deriveSpendLogs(madePayload([madeLog()]), { ...AXES, ledgerRequests: 0 }).sampledShare === null,
  'and a zero ledger count yields null rather than an infinite share',
);
const over = deriveSpendLogs(madePayload([madeLog(), madeLog()]), { ...AXES, ledgerRequests: 1 });
check(
  over.sampledShare !== null && over.sampledShare === 1,
  'a sample larger than the ledger clamps at 100% — the two layers are pruned separately and may disagree',
);

// ---- unattributed requests, and a multi-valued axis

const mixed = deriveSpendLogs(
  madePayload([
    madeLog(),
    madeLog({ teamId: null }),
    madeLog({ user: null, teamId: 'team-support' }),
  ]),
  AXES,
);
check(
  mixed.unattributedRequests === 1 && mixed.attributedRequests === 2 && mixed.sampleRequests === 3,
  'a request with no key on one axis is counted as unattributed, never bucketed as "other"',
);
check(
  near(mixed.sampleSpend, 0.03),
  'and its spend still counts towards the sample — the row happened, it is only unfiled',
);

const tagged = deriveSpendLogs(
  madePayload([madeLog({ tags: ['chat', 'pilot', 'eu'] })]),
  { rowDimension: 'tag', columnDimension: 'model' },
);
const tagCellSpend = [...tagged.cells.values()].reduce((sum, cell) => sum + cell.spend, 0);
check(
  tagged.rows.length === 3 && tagged.attributedRequests === 1,
  'one request carrying three tags contributes to three rows and is still one request',
);
check(
  tagCellSpend > tagged.sampleSpend,
  `so the cells legitimately sum past the sample ($${tagCellSpend.toFixed(2)} of $${tagged.sampleSpend.toFixed(2)}) — a fact about tags, not a bug`,
);

// =====================================================================
// 5 · latency
// =====================================================================

console.log('\n5 · latency, the one thing no aggregate carries');

const timed = deriveSpendLogs(
  madePayload([100, 200, 300, 400, 5_000].map((durationMs) => madeLog({ durationMs }))),
  AXES,
);
check(
  timed.latency.p50Ms === 300 && timed.latency.p95Ms === 5_000 && timed.latency.p99Ms === 5_000,
  'percentiles are nearest-rank over the sample, so a tail of one still shows at p95',
);
check(timed.latency.timed === 5 && timed.latency.untimed === 0, 'and every request in it was timed');

const partly = deriveSpendLogs(
  madePayload([madeLog({ durationMs: 500 }), madeLog({ durationMs: null })]),
  AXES,
);
check(
  partly.latency.timed === 1 && partly.latency.untimed === 1 && partly.latency.p50Ms === 500,
  'an untimed request is excluded from the percentiles and counted beside them, never read as 0ms',
);
const untimed = deriveSpendLogs(madePayload([madeLog({ durationMs: null })]), AXES);
check(
  untimed.latency.p50Ms === null && untimed.latency.p95Ms === null,
  'a sample nothing in which is timed reports no latency rather than zero',
);

// =====================================================================
// 6 · the deployment split
// =====================================================================

console.log('\n6 · which deployment served it');

const pool: GatewaySpendLog[] = [];
for (let index = 0; index < 60; index++) {
  pool.push(madeLog({ deploymentId: 'dep-payg', durationMs: 400, status: 'success' }));
}
for (let index = 0; index < 40; index++) {
  pool.push(
    madeLog({
      deploymentId: 'dep-ptu',
      durationMs: 1_200,
      status: index < 12 ? 'failure' : 'success',
    }),
  );
}
pool.push(madeLog({ modelGroup: 'azure/gpt-4o-mini', deploymentId: 'dep-mini' }));
pool.push(madeLog({ deploymentId: null }));
pool.push(madeLog({ deploymentId: 'dep-thin', modelGroup: 'bedrock/nova' }));

const split = deriveSpendLogs(madePayload(pool), AXES);
check(
  split.unjoinableRequests === 1,
  'a request whose deployment the proxy did not name is counted as unjoinable, not filed under a shared null',
);
check(
  split.deployments.every((row) => row.deploymentId !== null),
  'so no deployment row stands for "the proxy sets no model_id" — that is a property of the proxy, not a pool',
);
check(
  split.deployments.reduce((sum, row) => sum + row.requests, 0) + split.unjoinableRequests ===
    split.sampleRequests,
  'every request in the sample is either attributed to a deployment or counted as unjoinable',
);
check(
  split.splits.length === 1 && split.splits[0]?.model === 'azure/gpt-4o',
  'only an alias the sample saw served by more than one deployment is a split',
);

const gpt4o = split.splits[0];
const ptu = gpt4o?.rows.find((row) => row.deploymentId === 'dep-ptu');
const payg = gpt4o?.rows.find((row) => row.deploymentId === 'dep-payg');
check(
  ptu !== undefined && near(ptu.failureRate, 0.3) && payg !== undefined && payg.failureRate === 0,
  'the failing pool carries its own failure rate — the alias-level number the aggregates report averages it away',
);
check(
  gpt4o !== null && gpt4o?.failureSpread !== null && near(gpt4o?.failureSpread ?? 0, 0.3),
  'and the split reports the spread between its deployments, which is the finding',
);
check(
  gpt4o?.latencyRatio !== null && near(gpt4o?.latencyRatio ?? 0, 3),
  'along with how much slower the worse one is at p95',
);
check(
  ptu?.siblings === 2 && payg?.siblings === 2,
  'each row knows how many deployments the sample saw behind its alias',
);

const thin = split.deployments.find((row) => row.deploymentId === 'dep-thin');
check(
  thin !== undefined && !thin.material,
  `a deployment under the ${DEPLOYMENT_MIN_REQUESTS}-request floor is marked immaterial — 1 call gives a rate of 0% or 100% and neither is a finding`,
);

const oneSided = deriveSpendLogs(
  madePayload([
    ...Array.from({ length: 30 }, () => madeLog({ deploymentId: 'dep-payg' })),
    madeLog({ deploymentId: 'dep-new' }),
  ]),
  AXES,
);
check(
  oneSided.splits[0]?.failureSpread === null && oneSided.splits[0]?.latencyRatio === null,
  'a split with only one material deployment compares nothing rather than comparing against noise',
);

// =====================================================================
// 7 · the mock, through the page's own derivation
// =====================================================================

console.log('\n7 · the mock sample, read the way the page reads it');

const asRead = (row: GatewaySpendLogRecord): GatewaySpendLog => {
  const { spendNano, ...rest } = row;
  return { ...rest, spend: Number(spendNano) / 1e9 };
};

const client = new MockGatewayClient();
const to = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const from = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);

const page = await client.fetchSpendLogs(from, to, 1_200);
const usage = await client.fetchUsage(from, to);
const daily: GatewayDailyPoint[] = usage.daily.map((day) => ({
  date: day.date,
  spend: Number(day.spendNano) / 1e9,
  requests: day.requests,
  successfulRequests: day.successfulRequests,
  failedRequests: day.failedRequests,
  promptTokens: day.promptTokens,
  completionTokens: day.completionTokens,
  totalTokens: day.totalTokens,
  cacheReadTokens: day.cacheReadTokens,
  cacheCreationTokens: day.cacheCreationTokens,
}));

const payload: GatewaySpendLogs = {
  from,
  to,
  rows: page.rows.map(asRead),
  available: page.available,
  truncated: page.truncated,
  fetchedAt: new Date().toISOString(),
};

const mockWindow = spendLogWindow(daily);
const view = deriveSpendLogs(payload, {
  ...AXES,
  ledgerRequests: ledgerRequestsIn(daily, mockWindow),
});

check(view.answered && view.available && !view.isEmpty, 'the mock sample reads as answered, available and non-empty');
check(view.truncated, 'and as truncated — which is what makes every dollar below a floor');

const windowSpend = daily.reduce((sum, day) => sum + day.spend, 0);
check(
  view.sampleSpend < windowSpend,
  `the sample's spend stays under the ledger's ($${view.sampleSpend.toFixed(2)} of $${windowSpend.toFixed(2)})`,
);
check(
  view.sampledShare !== null && view.sampledShare > 0 && view.sampledShare < 0.2,
  `and it reports itself as a small slice of the window's requests (${((view.sampledShare ?? 0) * 100).toFixed(2)}%)`,
);

check(
  view.rows.length > 0 && view.columns.length > 0 && view.cells.size > 0,
  'team × model draws a matrix — the question the daily aggregates cannot be asked at all',
);
const drawn = [...view.cells.values()].reduce((sum, cell) => sum + cell.spend, 0);
check(
  drawn <= view.sampleSpend + 1e-9,
  'and the drawn cells never sum past the sample on single-valued axes',
);
check(
  view.rows.every((row) => row.spend > 0) && view.columns.every((column) => column.spend > 0),
  'every axis key the matrix draws carries spend',
);

check(
  view.latency.p50Ms !== null &&
    view.latency.p95Ms !== null &&
    view.latency.p99Ms !== null &&
    view.latency.p50Ms < view.latency.p95Ms &&
    view.latency.p95Ms <= view.latency.p99Ms,
  `the latency distribution is ordered (p50 ${view.latency.p50Ms}ms, p95 ${view.latency.p95Ms}ms, p99 ${view.latency.p99Ms}ms)`,
);
check(view.latency.untimed === 0, 'and the mock times every request, as a proxy carrying request_duration_ms does');

// ---- the finding the layer exists for

const health = await client.fetchHealth();
const failingPool = health.find(
  (deployment) => !deployment.healthy && deployment.backend === 'azure/gpt-4o',
);
const gpt4oSplit = view.splits.find((entry) => entry.model === 'azure/gpt-4o');
check(
  gpt4oSplit !== undefined && gpt4oSplit.rows.length === 2,
  'the multi-deployment alias reads as a split in the view, not as one row',
);
const onPool = gpt4oSplit?.rows.find((row) => row.deploymentId === failingPool?.id);
check(
  onPool !== undefined && onPool.requests > 0 && onPool.spend > 0,
  `the pool /health reports as refusing is carrying real traffic and real dollars ($${(onPool?.spend ?? 0).toFixed(2)}) — which is the join no aggregate can make`,
);
check(
  gpt4oSplit?.latencyRatio !== null && (gpt4oSplit?.latencyRatio ?? 0) > 1.3,
  `and it is measurably slower at p95 (${(gpt4oSplit?.latencyRatio ?? 0).toFixed(1)}×)`,
);
check(
  view.unjoinableRequests === 0,
  'every request in the mock names its deployment, so nothing is unjoinable here',
);

// ---- switching the axes re-reads the same rows

const byProvider = deriveSpendLogs(payload, { rowDimension: 'api_key', columnDimension: 'provider' });
check(
  byProvider.sampleRequests === view.sampleRequests && near(byProvider.sampleSpend, view.sampleSpend),
  'switching the axes re-cuts the same sample rather than fetching another one',
);
check(
  byProvider.columns.length > 1 && byProvider.rows.length > 1,
  'and the joint key holds on any pair of dimensions, since every row carries all of them',
);

// =====================================================================

console.log(`\n${failures.length === 0 ? 'all checks passed' : `${failures.length} FAILED`}`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
