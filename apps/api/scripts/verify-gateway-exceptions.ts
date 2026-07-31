/**
 * Invariant check for the exception layer — the only source that says *why* a
 * call failed.
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-exceptions.ts
 *
 * Two halves, for the two things that can be wrong here.
 *
 * The **pure** half pins the classification and the roll-up: LiteLLM's own
 * exception names map to who owns the fault, an unknown name is `other` rather
 * than a near-match, the class shares reconcile to the window's total, and the
 * total is *ours* rather than the proxy's `total_exceptions` — which counts
 * distinct classes upstream and would silently understate every deployment by
 * three orders of magnitude.
 *
 * The **mock** half drives `MockGatewayClient.fetchModelExceptions` and checks
 * the claim the layer exists for, which is a claim about the *other* cards: the
 * refusing reserved-throughput pool behind `azure/gpt-4o` produces thousands of
 * rate limits while the alias's own failure rate in the ledger stays ordinary,
 * so no spend- or failure-shaped surface can see it. It also pins the one rule
 * that keeps this layer from being read as a failure count — the exception
 * totals and the ledger's `failed_requests` are two tables and do not agree.
 *
 * Like its siblings it sits outside apps/api's tsconfig `include`: a harness,
 * not part of the API build.
 */
import {
  classifyGatewayException,
  deploymentExceptionKey,
  summarizeGatewayExceptions,
  GATEWAY_EXCEPTION_CLASSES,
  GATEWAY_EXCEPTION_CLASS_INFO,
} from '@dash/shared';
import type { GatewayExceptions } from '@dash/shared';
import { MockGatewayClient } from '../src/gateway/mock.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
};

const close = (a: number, b: number, epsilon = 1e-9): boolean => Math.abs(a - b) < epsilon;

// ----------------------------------------------------------------- pure half

console.log('\nclassification');

check(
  classifyGatewayException('RateLimitError') === 'rate-limit' &&
    classifyGatewayException('AuthenticationError') === 'auth' &&
    classifyGatewayException('PermissionDeniedError') === 'auth' &&
    classifyGatewayException('BudgetExceededError') === 'budget' &&
    classifyGatewayException('Timeout') === 'timeout' &&
    classifyGatewayException('ServiceUnavailableError') === 'backend' &&
    classifyGatewayException('APIConnectionError') === 'backend' &&
    classifyGatewayException('BadRequestError') === 'request' &&
    classifyGatewayException('ContentPolicyViolationError') === 'content',
  'every LiteLLM exception class maps to the party that can act on it',
);
check(
  classifyGatewayException('ContextWindowExceededError') === 'request',
  'a context-window overflow is the caller\'s fault, not a capacity one — it is a 400',
);
check(
  classifyGatewayException('litellm.RateLimitError') === 'rate-limit' &&
    classifyGatewayException('openai.APIConnectionError') === 'backend',
  'a prefixed class name is the same fault — the proxy is inconsistent about it',
);
check(
  classifyGatewayException('QuantumFluxError') === 'other' &&
    classifyGatewayException('') === 'other' &&
    classifyGatewayException('   ') === 'other',
  'an unrecognised class is "other" under its own name, never a near-match',
);
check(
  GATEWAY_EXCEPTION_CLASSES.every(
    (name) => (GATEWAY_EXCEPTION_CLASS_INFO[name]?.owner ?? '') !== '',
  ),
  'every class names an owner — that is what the classification is for',
);

console.log('\nroll-up');

const payload = (deployments: GatewayExceptions['deployments']): GatewayExceptions => ({
  from: '2026-06-01',
  to: '2026-06-30',
  models: ['azure/gpt-4o'],
  skippedModels: [],
  deployments,
  available: true,
  fetchedAt: '2026-07-01T00:00:00.000Z',
});

const constructed = summarizeGatewayExceptions(
  payload([
    {
      deployment: 'azure/gpt-4o-https://ptu/',
      model: 'azure/gpt-4o',
      exceptions: [
        { type: 'Timeout', class: 'timeout', count: 20 },
        { type: 'RateLimitError', class: 'rate-limit', count: 4_000 },
      ],
      total: 4_020,
      // The proxy's own figure, reproduced: two classes, four thousand faults.
      reportedTotal: 2,
    },
    {
      deployment: 'bedrock/claude',
      model: 'bedrock/claude',
      exceptions: [
        { type: 'RateLimitError', class: 'rate-limit', count: 60 },
        { type: 'BadRequestError', class: 'request', count: 120 },
      ],
      total: 180,
      reportedTotal: 2,
    },
  ]),
);

check(constructed.total === 4_200, `the window's total is the sum of ours (${constructed.total})`);
check(
  constructed.deployments.every((row) => row.total !== row.reportedTotal),
  'and it is nothing like total_exceptions, which counts classes rather than exceptions',
);
check(
  constructed.classes.reduce((sum, entry) => sum + entry.count, 0) === constructed.total &&
    close(constructed.classes.reduce((sum, entry) => sum + entry.share, 0), 1),
  'the class roll-up partitions the window exactly — shares sum to one',
);
check(
  constructed.classes[0]?.class === 'rate-limit' && constructed.classes[0]?.count === 4_060,
  'a class spanning two deployments is added across them and ranks first',
);
check(
  constructed.classes[0]?.deployments === 2,
  'and reports how many deployments produced it, since one bad pool is not a fleet-wide fault',
);
check(
  constructed.deployments[0]?.deployment === 'azure/gpt-4o-https://ptu/' &&
    constructed.deployments[0]?.dominantClass === 'rate-limit' &&
    close(constructed.deployments[0]?.dominantShare ?? 0, 4_000 / 4_020),
  'deployments rank by their own total, each with the class that dominates it',
);
check(
  constructed.deployments[1]?.dominantClass === 'request',
  'a deployment whose faults are mostly the caller\'s says so — same table, different job',
);
check(
  constructed.deployments.every(
    (row) => row.exceptions[0] !== undefined &&
      row.exceptions.every((entry, index) => index === 0 || entry.count <= (row.exceptions[index - 1]?.count ?? 0)),
  ),
  'each deployment\'s classes are ordered largest first',
);

const emptyWindow = summarizeGatewayExceptions(payload([]));
check(
  emptyWindow.total === 0 && emptyWindow.empty && emptyWindow.classes.length === 0,
  'a window with no exceptions recorded is empty rather than broken',
);
const refused = summarizeGatewayExceptions({ ...payload([]), available: false });
check(
  !refused.empty && !refused.available,
  'a refused route is not an empty one — "no errors recorded" is a claim it cannot make',
);

// ----------------------------------------------------------------- mock half

console.log('\nagainst the mock proxy');

const mock = new MockGatewayClient();
const today = new Date();
const iso = (date: Date): string => date.toISOString().slice(0, 10);
const shift = (days: number): string => {
  const cursor = new Date(today);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return iso(cursor);
};

// A month back from yesterday: long enough to contain the 17th/18th incident
// and both batch days whatever today is.
const to = shift(-1);
const from = shift(-31);

const usage = await mock.fetchUsage(from, to);
const aliases = [
  ...new Set(usage.breakdowns.filter((row) => row.dimension === 'model').map((row) => row.key)),
];
const page = await mock.fetchModelExceptions(from, to, aliases);
const summary = summarizeGatewayExceptions({
  from,
  to,
  models: aliases,
  skippedModels: [],
  deployments: page.rows.map((row) => ({
    deployment: row.deployment,
    model: row.model,
    exceptions: row.exceptions.map((entry) => ({
      type: entry.type,
      class: classifyGatewayException(entry.type),
      count: entry.count,
    })),
    total: row.exceptions.reduce((sum, entry) => sum + entry.count, 0),
    reportedTotal: row.reportedTotal,
  })),
  available: page.available,
  fetchedAt: new Date().toISOString(),
});

check(page.available && summary.total > 0, `the mock records exceptions (${summary.total})`);
check(
  summary.deployments.every((row) => aliases.includes(row.model)),
  'every row is attributed to the alias the read asked about',
);

// The finding this layer exists for: a deployment failing behind an alias that
// bills and fails normally.
const ptuKey = deploymentExceptionKey(
  'azure/gpt-4o',
  'https://nocturne-neu-ptu.openai.azure.com/',
);
const ptu = summary.deployments.find((row) => row.deployment === ptuKey);
check(
  ptu !== undefined && ptu.dominantClass === 'rate-limit' && (ptu.dominantShare ?? 0) > 0.9,
  'the refusing reserved-throughput pool is here, and it is rate limits and almost nothing else',
);

const gatewayRequests = usage.daily.reduce((sum, day) => sum + day.requests, 0);
const gatewayFailures = usage.daily.reduce((sum, day) => sum + day.failedRequests, 0);
const gatewayRate = gatewayFailures / gatewayRequests;
const aliasRows = usage.breakdowns.filter(
  (row) => row.dimension === 'model' && row.key === 'azure/gpt-4o',
);
const aliasRequests = aliasRows.reduce((sum, row) => sum + row.requests, 0);
const aliasRate = aliasRows.reduce((sum, row) => sum + row.failedRequests, 0) / aliasRequests;
check(
  aliasRate < gatewayRate * 1.5,
  `and the alias in front of it is unremarkable in the ledger (${(aliasRate * 100).toFixed(2)}% vs ${(gatewayRate * 100).toFixed(2)}%, below the reliability card's 1.5x gate)`,
);
check(
  (ptu?.total ?? 0) > 0 && aliasRows.every((row) => row.spendNano > 0n),
  'while it bills normally every day — which is the whole reason no other card can see it',
);

// The contrast case: a deployment the reliability card *can* see, where this
// layer adds the reason rather than the finding.
const throttled = summary.deployments.find((row) => row.model === 'azure/o4-mini');
const throttledRows = usage.breakdowns.filter(
  (row) => row.dimension === 'model' && row.key === 'azure/o4-mini',
);
const throttledRate =
  throttledRows.reduce((sum, row) => sum + row.failedRequests, 0) /
  throttledRows.reduce((sum, row) => sum + row.requests, 0);
check(
  throttled?.dominantClass === 'rate-limit' && throttledRate > gatewayRate * 1.5,
  'the throttled deployment is elevated in the ledger *and* named as a quota here',
);

// The two classes that exist nowhere else on the page.
const authClass = summary.classes.find((entry) => entry.class === 'auth');
check(
  (authClass?.count ?? 0) > 0 &&
    summary.deployments.some(
      (row) => row.model === 'azure_ai/phi-4' && row.exceptions.some((e) => e.class === 'auth'),
    ),
  'a rotated credential shows up as an auth class on the deployment that carries it',
);
const budgetClass = summary.classes.find((entry) => entry.class === 'budget');
check(
  (budgetClass?.count ?? 0) > 0,
  'and a cap the proxy enforces shows up as the one class the gateway itself caused',
);

// The incident, read as a cause rather than as a bigger number.
const bedrock = summary.deployments.filter((row) => row.model.startsWith('bedrock/'));
check(
  bedrock.length > 0 && bedrock.every((row) => row.dominantClass === 'backend'),
  'the incident days come back as backend faults, not as more of the ordinary mix',
);

const quiet = await mock.fetchModelExceptions(shift(-8), shift(-6), aliases);
const quietSummary = summarizeGatewayExceptions({
  from: shift(-8),
  to: shift(-6),
  models: aliases,
  skippedModels: [],
  deployments: quiet.rows.map((row) => ({
    deployment: row.deployment,
    model: row.model,
    exceptions: row.exceptions.map((entry) => ({
      type: entry.type,
      class: classifyGatewayException(entry.type),
      count: entry.count,
    })),
    total: row.exceptions.reduce((sum, entry) => sum + entry.count, 0),
    reportedTotal: row.reportedTotal,
  })),
  available: quiet.available,
  fetchedAt: new Date().toISOString(),
});
check(
  quietSummary.total > 0 && quietSummary.total < summary.total,
  'a shorter window records fewer exceptions, and the same days always the same ones',
);

const repeat = await mock.fetchModelExceptions(from, to, aliases);
check(
  JSON.stringify(repeat.rows) === JSON.stringify(page.rows),
  'asking twice for one window answers identically — this route is read, not sampled',
);

check(
  (await mock.fetchModelExceptions(from, to, ['azure/never-configured'])).rows.length === 0,
  'an alias the proxy never routed records nothing, which is not the same as clean',
);
check(
  (await mock.fetchModelExceptions(from, to, [])).rows.length === 0,
  'and asking about no aliases fetches nothing rather than everything',
);

// The rule that keeps this layer from being read as a failure count.
check(
  summary.total !== gatewayFailures,
  `the exception total and the ledger's failures are two tables and disagree (${summary.total} vs ${gatewayFailures})`,
);
check(
  summary.deployments.some((row) => row.reportedTotal < row.total),
  'and the proxy\'s own total_exceptions disagrees with both — it is a count of classes',
);

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('gateway exceptions: all checks passed');
