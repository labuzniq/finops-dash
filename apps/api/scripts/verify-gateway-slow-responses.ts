/**
 * Invariant check for the slow-response layer — the proxy's count of calls that
 * ran past its own alerting threshold, and the only wall-clock reading the
 * gateway will aggregate.
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-slow-responses.ts
 *
 * Two halves, for the two things that can be wrong here.
 *
 * The **pure** half pins the key rule (`slowResponseDeploymentKey` reproduces
 * LiteLLM's own `api_base or ""` grouping, including the `/openai/` cut and the
 * unnamed bucket that has no equivalent on either sibling route), the roll-up
 * arithmetic, and the two badge gates — this is the one live read that carries
 * its own denominator, so it is also the one that can afford a significance test
 * beside the materiality ratio.
 *
 * The **mock** half drives `MockGatewayClient.fetchModelSlowResponses` and
 * checks the claims the layer exists for: the refusing reserved pool hangs and
 * is badged, the two-day regional incident hangs and averages away below the
 * badge, and the whole Bedrock fleet arrives as one unnamed row because the
 * proxy grouped it that way.
 *
 * Like its siblings it sits outside apps/api's tsconfig `include`: a harness,
 * not part of the API build.
 */
import {
  slowResponseDeploymentKey,
  summarizeGatewaySlowResponses,
  wilsonScoreLowerBound,
  SLOW_RESPONSE_CONFIDENCE_Z,
  SLOW_RESPONSE_ELEVATED_RATIO,
  SLOW_RESPONSE_MIN_COUNT,
  UNKEYED_DEPLOYMENT,
} from '@dash/shared';
import type { GatewaySlowResponseRecord, GatewaySlowResponses } from '@dash/shared';
import { MockGatewayClient } from '../src/gateway/mock.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
};

const close = (a: number, b: number, epsilon = 1e-9): boolean => Math.abs(a - b) < epsilon;

const payload = (rows: GatewaySlowResponseRecord[], available = true): GatewaySlowResponses => ({
  from: '2026-07-01',
  to: '2026-07-31',
  models: [...new Set(rows.map((row) => row.model))],
  skippedModels: [],
  rows,
  available,
  fetchedAt: '2026-07-31T06:00:00.000Z',
});

// ----------------------------------------------------------------- pure half

console.log('\nthe deployment key');

check(
  slowResponseDeploymentKey('https://nocturne-weu.openai.azure.com/') ===
    'https://nocturne-weu.openai.azure.com/',
  'an endpoint is keyed by its own URL — the proxy groups on api_base and nothing else',
);
check(
  slowResponseDeploymentKey('https://x.openai.azure.com/openai/deployments/gpt-4o') ===
    'https://x.openai.azure.com',
  'and everything from /openai/ onwards is cut, exactly as the route cuts it',
);
check(
  slowResponseDeploymentKey(null) === UNKEYED_DEPLOYMENT &&
    slowResponseDeploymentKey('') === UNKEYED_DEPLOYMENT &&
    slowResponseDeploymentKey('   ') === UNKEYED_DEPLOYMENT,
  'a deployment with no base is the unnamed bucket — there is no fallback to a model string here',
);
check(
  slowResponseDeploymentKey('nocturne-weu.internal') === 'nocturne-weu.internal',
  'a base that is not a URL is still the key: this route tests for a value, not for "https://"',
);

console.log('\nthe roll-up');

const shared = summarizeGatewaySlowResponses(
  payload([
    { model: 'azure/gpt-4o', key: 'https://one.example/', total: 1_000, slow: 3 },
    { model: 'azure/gpt-4o-mini', key: 'https://one.example/', total: 3_000, slow: 5 },
    { model: 'bedrock/claude', key: UNKEYED_DEPLOYMENT, total: 6_000, slow: 12 },
  ]),
);

check(shared.rows.length === 2, 'two aliases behind one endpoint roll up to one key, not two rows');
const endpoint = shared.rows.find((row) => row.key === 'https://one.example/');
check(
  endpoint !== undefined && endpoint.total === 4_000 && endpoint.slow === 8,
  'and their counts are summed — these are disjoint request counts, which unlike a rate may be added',
);
check(
  endpoint !== undefined &&
    endpoint.models.length === 2 &&
    endpoint.models.includes('azure/gpt-4o') &&
    endpoint.models.includes('azure/gpt-4o-mini'),
  'with both aliases kept beside the row, so a reader can see whose traffic the key covers',
);
check(
  shared.total === 10_000 && shared.slow === 20 && close(shared.slowShare ?? 0, 0.002),
  'the gateway-wide share is the sweep’s own slow over its own total, never the ledger’s requests',
);
check(
  endpoint !== undefined && close(endpoint.ratioToGateway ?? 0, 0.002 / 0.002),
  'a key at the gateway rate reads a ratio of exactly one',
);
check(
  shared.rows[0]?.key === UNKEYED_DEPLOYMENT,
  'and the ranking is by hangs first — the number somebody acts on, not the share',
);

console.log('\nthe two badge gates');

// A busy key materially worse than a large, calm gateway: both gates pass.
const badged = summarizeGatewaySlowResponses(
  payload([
    { model: 'a', key: 'https://calm/', total: 400_000, slow: 800 },
    { model: 'b', key: 'https://hanging/', total: 20_000, slow: 200 },
  ]),
);
const hanging = badged.rows.find((row) => row.key === 'https://hanging/');
check(
  hanging !== undefined && hanging.elevated,
  'a key five times the gateway rate over twenty thousand calls is badged — significant and material',
);
check(
  badged.rows.find((row) => row.key === 'https://calm/')?.elevated === false,
  'and the key that is most of the denominator is not badged against itself',
);

// Thin evidence: three requests, one hang. 33% against a 0.2% gateway — a
// ratio of 166 and no case to answer.
const thin = summarizeGatewaySlowResponses(
  payload([
    { model: 'a', key: 'https://calm/', total: 500_000, slow: 1_000 },
    { model: 'b', key: 'https://thin/', total: 3, slow: 1 },
  ]),
);
const thinRow = thin.rows.find((row) => row.key === 'https://thin/');
check(
  thinRow !== undefined && (thinRow.ratioToGateway ?? 0) > SLOW_RESPONSE_ELEVATED_RATIO,
  'one hang out of three calls clears the materiality ratio by two orders of magnitude',
);
check(
  thinRow !== undefined && thinRow.slow < SLOW_RESPONSE_MIN_COUNT && !thinRow.elevated,
  'and is not badged: the minimum-count floor is what stops a ratio over a handful of calls',
);

// The opposite regime: certainly worse, and by nothing anyone can act on.
const certain = summarizeGatewaySlowResponses(
  payload([
    { model: 'a', key: 'https://calm/', total: 2_000_000, slow: 4_000 },
    { model: 'b', key: 'https://barely/', total: 400_000, slow: 1_000 },
  ]),
);
const barely = certain.rows.find((row) => row.key === 'https://barely/');
check(
  barely !== undefined &&
    wilsonScoreLowerBound(barely.slow, barely.total, SLOW_RESPONSE_CONFIDENCE_Z) >
      (certain.slowShare ?? 1),
  'across four hundred thousand calls a 0.25% rate is certainly above a 0.21% gateway',
);
check(
  barely !== undefined && (barely.ratioToGateway ?? 0) < SLOW_RESPONSE_ELEVATED_RATIO && !barely.elevated,
  'and it is still not badged — significance without materiality flags roughly everything above the mean',
);

console.log('\nthe silences');

const unread = summarizeGatewaySlowResponses(payload([], false));
check(
  !unread.available && !unread.empty && unread.rows.length === 0,
  'a refused route is not an empty one: available false never reads as "nothing hung"',
);
const answered = summarizeGatewaySlowResponses(payload([], true));
check(
  answered.available && answered.empty,
  'a route that answered with no rows is empty and available — the two silences stay apart',
);
check(
  summarizeGatewaySlowResponses(
    payload([{ model: 'a', key: 'https://idle/', total: 0, slow: 0 }]),
  ).rows.length === 0,
  'a key the route grouped nothing under is dropped rather than rendered as a 0% row over no calls',
);

// --------------------------------------------------------------- mock half

console.log('\nagainst the mock proxy');

const mock = new MockGatewayClient();
const shift = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const from = shift(-30);
const to = shift(-1);

const aliases = [
  'azure/gpt-4o',
  'azure/gpt-4o-mini',
  'azure/o4-mini',
  'azure_ai/mistral-large',
  'azure_ai/phi-4',
  'bedrock/anthropic.claude-sonnet-4-v1:0',
  'bedrock/anthropic.claude-haiku-4-v1:0',
  'bedrock/amazon.nova-pro-v1:0',
];

const page = await mock.fetchModelSlowResponses(from, to, aliases);
const summary = summarizeGatewaySlowResponses({
  from,
  to,
  models: aliases,
  skippedModels: [],
  rows: page.rows,
  available: page.available,
  fetchedAt: new Date().toISOString(),
});

check(page.available && page.rows.length > 0, 'the mock answers the route with rows');
check(
  page.rows.every((row) => row.slow <= row.total),
  'no key reports more hangs than requests — the SQL cannot, and neither may the generator',
);

const ptuKey = 'https://nocturne-neu-ptu.openai.azure.com/';
const ptu = summary.rows.find((row) => row.key === ptuKey);
check(ptu !== undefined, 'the reserved pool is its own key: a second endpoint behind one alias');
check(
  ptu !== undefined && ptu.elevated,
  'and it is badged — the deployment /health calls failing queues before it gives up',
);
check(
  ptu !== undefined && (ptu.ratioToGateway ?? 0) >= SLOW_RESPONSE_ELEVATED_RATIO * 2,
  'by a margin, not by a hair: the pool is several times the gateway rate',
);

const unnamed = summary.rows.find((row) => row.key === UNKEYED_DEPLOYMENT);
check(
  unnamed !== undefined && unnamed.models.length === 3,
  'every Bedrock alias lands in one unnamed row — the proxy grouped them and nothing here can split them',
);
check(
  unnamed !== undefined && !unnamed.elevated,
  'and the two-day incident inside it averages away below the badge, exactly as it does on the reliability card',
);

const weu = summary.rows.find((row) => row.key === 'https://nocturne-weu.openai.azure.com/');
check(
  weu !== undefined && weu.models.includes('azure/o4-mini') && !weu.elevated,
  'the reasoning deployment is diluted into the endpoint it shares and is not a finding',
);

const usage = await mock.fetchUsage(from, to);
const ledgerRequests = usage.daily.reduce((sum, day) => sum + day.requests, 0);
check(
  summary.total > 0 && summary.total < ledgerRequests,
  'the sweep’s denominator is short of the ledger’s requests — cache hits are excluded upstream',
);
check(
  summary.slowShare !== null && summary.slowShare > 0 && summary.slowShare < 0.02,
  'and the gateway-wide hang share is a small fraction, as it is on a working proxy',
);

const repeat = await mock.fetchModelSlowResponses(from, to, aliases);
check(
  JSON.stringify(repeat.rows) === JSON.stringify(page.rows),
  'asking twice for one window answers identically — this route is read, not sampled',
);
check(
  (await mock.fetchModelSlowResponses(from, to, ['azure/never-configured'])).rows.length === 0,
  'an alias the proxy never routed reports nothing, which is not the same as nothing hanging',
);
check(
  (await mock.fetchModelSlowResponses(from, to, [])).rows.length === 0,
  'and asking about no aliases fetches nothing rather than everything',
);

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('gateway slow responses: all checks passed');
