/**
 * Invariant check for the request-log layer — the gateway's only joint-keyed
 * source.
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-logs.ts
 *
 * Two halves, for the two things that can be wrong here.
 *
 * The **pure** half constructs the rows a generator cannot produce — a request
 * with no team, one carrying three tags, one whose alias is only in `model` —
 * and pins the rules that make a cross-tab honest: an unattributed request is
 * counted rather than dropped, a multi-valued axis makes the cells sum to more
 * than the sample (and that is correct), and nothing here invents a share.
 *
 * The **mock** half drives `MockGatewayClient.fetchSpendLogs` and checks the
 * three facts this layer exists for, none of which any aggregate row carries:
 * the deployment that served a request (which is what joins usage to
 * `/health`), its latency, and every dimension on one row. It also pins the
 * rule that keeps the layer safe — the sample is a *floor*, provably smaller
 * than the same window's aggregate spend, and it says when it was truncated.
 *
 * Like its siblings it sits outside apps/api's tsconfig `include`: a harness,
 * not part of the API build.
 */
import {
  crossTabSpendLogs,
  spendLogDimensionKeys,
  spendLogLatencyPercentile,
  SPEND_LOG_ROW_CAP,
} from '@dash/shared';
import type { GatewaySpendLog } from '@dash/shared';
import { MockGatewayClient } from '../src/gateway/mock.js';
import type { GatewaySpendLogRecord } from '../src/gateway/types.js';

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
    teamAlias: 'Platform Engineering',
    endUser: null,
    tags: ['coding-assistant'],
    mcpTool: null,
    sessionId: null,
    agentId: null,
    spend: 1,
    promptTokens: 1_000,
    completionTokens: 200,
    totalTokens: 1_200,
    cacheHit: null,
    status: 'success',
    ...over,
  };
}

/** The read model the route hands a browser, from what the client returns. */
const asRead = (row: GatewaySpendLogRecord): GatewaySpendLog => {
  const { spendNano, ...rest } = row;
  return { ...rest, spend: Number(spendNano) / 1e9 };
};

// =====================================================================
// 1 · which keys a request contributes to a dimension
// =====================================================================

console.log('\n1 · a request maps to zero, one or many keys per dimension');

check(
  spendLogDimensionKeys(madeLog(), 'model')[0] === 'azure/gpt-4o',
  'the model dimension takes the alias asked for, not the deployment model called',
);
check(
  spendLogDimensionKeys(madeLog({ modelGroup: null }), 'model')[0] === 'gpt-4o-eu2',
  'and falls back to the called model on a proxy that never renamed anything',
);
check(
  spendLogDimensionKeys(madeLog({ teamId: null }), 'team').length === 0,
  'a request made outside a team contributes no team key — that is not a zero',
);
check(
  spendLogDimensionKeys(madeLog({ user: '' }), 'user').length === 0,
  'an empty identity string is no identity rather than a key named ""',
);
check(
  spendLogDimensionKeys(madeLog({ tags: ['batch', 'eu', 'q3'] }), 'tag').length === 3,
  'tags are a list: one request legitimately sits in three tag buckets',
);
check(
  spendLogDimensionKeys(madeLog({ mcpTool: 'github/search_issues' }), 'mcp_server')[0] === 'github',
  'mcp_server is the namespaced tool name cut at the first slash',
);
check(
  spendLogDimensionKeys(madeLog({ mcpTool: 'jira' }), 'mcp_server')[0] === 'jira',
  'a tool name with no namespace separator is the server itself',
);
check(
  spendLogDimensionKeys(madeLog(), 'mcp_server').length === 0,
  'a request that touched no MCP server contributes nothing to the subset dimension',
);

// =====================================================================
// 2 · the cross-tab — the join no aggregate can express
// =====================================================================

console.log('\n2 · cross-tab reconciliation over constructed rows');

const sample: GatewaySpendLog[] = [
  madeLog({ requestId: '1', teamId: 'team-a', modelGroup: 'azure/gpt-4o', spend: 4 }),
  madeLog({ requestId: '2', teamId: 'team-a', modelGroup: 'azure/gpt-4o', spend: 2 }),
  madeLog({ requestId: '3', teamId: 'team-a', modelGroup: 'bedrock/claude', spend: 1 }),
  madeLog({ requestId: '4', teamId: 'team-b', modelGroup: 'bedrock/claude', spend: 8, status: 'failure' }),
  // No team at all: the service key that acts on nobody's behalf.
  madeLog({ requestId: '5', teamId: null, modelGroup: 'azure/gpt-4o', spend: 16 }),
];

const tab = crossTabSpendLogs(sample, 'team', 'model');

check(tab.sampleRequests === 5, 'every row of the sample is counted, attributed or not');
check(
  tab.attributedRequests === 4 && tab.unattributedRequests === 1,
  'a request missing a key on one axis is unattributed, never bucketed as "other"',
);
check(
  near(tab.sampleSpend, 31),
  'sample spend covers the unattributed rows too — it describes the sample, not the attributed part',
);
check(
  near(
    tab.cells.reduce((sum, cell) => sum + cell.spend, 0),
    15,
  ),
  'the cells account for exactly the attributed spend, and the missing $16 is visible as unattributed',
);
check(
  near(tab.rows.find((row) => row.key === 'team-a')?.spend ?? 0, 7) &&
    near(tab.columns.find((column) => column.key === 'azure/gpt-4o')?.spend ?? 0, 6),
  'both axes total their own attributed rows',
);
check(
  tab.cells.find((cell) => cell.row === 'team-a' && cell.column === 'azure/gpt-4o')?.requests === 2,
  'two requests of one team on one model collapse into one cell',
);
check(
  tab.cells.find((cell) => cell.row === 'team-b')?.failed === 1,
  'failures are carried per cell — a joint failure rate is a question only this layer can answer',
);
check(
  tab.cells[0]?.spend === 8 && tab.rows[0]?.key === 'team-b',
  'rows and cells are ranked by spend, dearest first',
);

const multiTag = crossTabSpendLogs(
  [
    madeLog({ requestId: 'm', tags: ['batch', 'eu'], spend: 10 }),
    madeLog({ requestId: 'n', tags: ['batch'], spend: 5 }),
  ],
  'tag',
  'model',
);
check(
  multiTag.attributedRequests === 2 && multiTag.cells.length === 2,
  'a request carrying two tags contributes to both cells — the cells count contributions, not requests',
);
check(
  near(
    multiTag.cells.reduce((sum, cell) => sum + cell.spend, 0),
    25,
  ) && near(multiTag.sampleSpend, 15),
  'so the cells legitimately sum past the sample on a multi-valued axis, which is the overlap invariant at row level',
);

const noneAttributed = crossTabSpendLogs([madeLog({ user: null })], 'user', 'model');
check(
  noneAttributed.rows.length === 0 &&
    noneAttributed.unattributedRequests === 1 &&
    near(noneAttributed.sampleSpend, 1),
  'a sample nothing can be attributed in is an empty table with its spend still reported',
);
check(
  crossTabSpendLogs([], 'team', 'model').sampleRequests === 0,
  'an empty sample cross-tabs to nothing rather than throwing',
);

// =====================================================================
// 3 · latency — the one measure no SpendMetrics field carries
// =====================================================================

console.log('\n3 · latency percentiles');

const timed = [100, 200, 300, 400, 500].map((durationMs, index) =>
  madeLog({ requestId: `t${index}`, durationMs }),
);
check(spendLogLatencyPercentile(timed, 50) === 300, 'the median is the nearest-rank middle value');
check(spendLogLatencyPercentile(timed, 95) === 500, 'p95 of five samples is the slowest of them');
check(spendLogLatencyPercentile(timed, 0) === 100, 'p0 is the fastest rather than an index error');
check(
  spendLogLatencyPercentile([madeLog({ durationMs: null })], 95) === null,
  'a sample nobody timed has no percentile — null, never zero',
);
check(spendLogLatencyPercentile([], 50) === null, 'and neither has an empty one');

// =====================================================================
// 4 · the mock source — the three facts this layer exists for
// =====================================================================

console.log('\n4 · the mock request log');

const client = new MockGatewayClient();
const to = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const from = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);

const page = await client.fetchSpendLogs(from, to, 600);
const rows = page.rows.map(asRead);

check(page.available && rows.length > 0, `the mock answers a window of requests (${rows.length} rows)`);
check(page.truncated, 'and says the sample is truncated — a mock day is tens of thousands of requests');
check(
  rows.every((row) => row.startTime >= `${from}T00:00:00.000Z` && row.startTime <= `${to}T23:59:59.999Z`),
  'every request falls inside the window asked for',
);
check(
  rows.every((row) => row.durationMs !== null && row.durationMs > 0),
  'every request is timed — latency exists only at this resolution',
);
check(
  rows.every(
    (row) =>
      row.apiKey !== null &&
      row.teamId !== null &&
      row.modelGroup !== null &&
      row.provider !== null &&
      row.tags.length > 0,
  ),
  'every request carries every dimension at once, which is the whole point of the layer',
);

const again = await client.fetchSpendLogs(from, to, 600);
check(
  again.rows.length === page.rows.length && again.rows[0]?.requestId === page.rows[0]?.requestId,
  'the same window answers the same requests — the stream is seeded off the window, not the clock',
);
const shorter = await client.fetchSpendLogs(to, to, 600);
check(
  shorter.rows[0]?.requestId !== page.rows[0]?.requestId,
  'a different window is a different sample rather than the same rows re-dated',
);

const capped = await client.fetchSpendLogs(from, to, 12);
check(capped.rows.length <= 12 && capped.truncated, 'the caller may lower the cap, and truncation is reported');
check(SPEND_LOG_ROW_CAP >= 1_000, 'the ceiling is a drill-down sample rather than a full pull');

// ---- the join no other table can make: request → deployment → health

const health = await client.fetchHealth();
const healthIds = new Set(health.map((deployment) => deployment.id));
const servedIds = new Set(rows.map((row) => row.deploymentId).filter((id): id is string => id !== null));

check(
  [...servedIds].every((id) => healthIds.has(id)),
  'every deployment a request names is a deployment /health knows about',
);

const aliasIds = new Set(
  rows.filter((row) => row.modelGroup === 'azure/gpt-4o').map((row) => row.deploymentId),
);
check(
  aliasIds.size === 2,
  `the multi-deployment alias splits its traffic across both of its deployments (${aliasIds.size})`,
);
const failingPool = health.find((deployment) => !deployment.healthy && deployment.backend === 'azure/gpt-4o');
check(
  failingPool !== undefined && servedIds.has(failingPool.id),
  'and one of them is the pool /health reports as refusing — the finding no aggregate row can reach',
);
const onPool = rows.filter((row) => row.deploymentId === failingPool?.id);
const offPool = rows.filter(
  (row) => row.modelGroup === 'azure/gpt-4o' && row.deploymentId !== failingPool?.id,
);
const meanLatency = (sample: GatewaySpendLog[]): number =>
  sample.reduce((sum, row) => sum + (row.durationMs ?? 0), 0) / Math.max(1, sample.length);
check(
  meanLatency(onPool) > meanLatency(offPool),
  `the throttled pool is measurably slower on the same alias (${Math.round(meanLatency(onPool))}ms vs ${Math.round(meanLatency(offPool))}ms)`,
);

// ---- the sample is a floor, and provably not the ledger

const usage = await client.fetchUsage(from, to);
const windowSpend = usage.daily.reduce((sum, day) => sum + Number(day.spendNano) / 1e9, 0);
const sampleSpend = rows.reduce((sum, row) => sum + row.spend, 0);
check(
  sampleSpend < windowSpend,
  `the sample's spend is a fraction of the window's ($${sampleSpend.toFixed(2)} of $${windowSpend.toFixed(2)}) — it is evidence, never the bill`,
);

// ---- the joint question the aggregates cannot be asked

const joint = crossTabSpendLogs(rows, 'team', 'model');
const teams = new Set(usage.breakdowns.filter((row) => row.dimension === 'team').map((row) => row.key));
const models = new Set(usage.breakdowns.filter((row) => row.dimension === 'model').map((row) => row.key));
check(
  teams.size > 1 && models.size > 1,
  'the aggregate reports both dimensions independently, and that is all it reports',
);
check(
  joint.cells.length > Math.max(teams.size, models.size),
  `the sample answers team x model in ${joint.cells.length} cells, which no combination of ${teams.size} team rows and ${models.size} model rows can produce`,
);
check(
  joint.unattributedRequests === 0,
  'and the mock attributes every request, so the whole sample lands in the table',
);

const p95 = spendLogLatencyPercentile(rows, 95);
const p50 = spendLogLatencyPercentile(rows, 50);
check(
  p50 !== null && p95 !== null && p95 >= p50,
  `the sample has a latency distribution (p50 ${p50}ms, p95 ${p95}ms) — a number the gateway page has never had`,
);

// -------------------------------------------------------------------- done

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('gateway request logs: all checks passed');
