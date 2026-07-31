/**
 * Invariant check for the latency layer — the proxy's own aggregation over its
 * request log, and the only reading of speed that covers a whole window.
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-latency.ts
 *
 * Two halves, for the two things that can be wrong here.
 *
 * The **pure** half pins the arithmetic and the two rules the unit forces: the
 * key rule (`latencyDeploymentKey` reproduces LiteLLM's own collapse of a
 * deployment onto its `api_base`, both branches and the `/openai/` cut) and the
 * badge rule (a materiality ratio gated on days observed, because this payload
 * carries no counts and therefore supports no significance test at all).
 *
 * The **mock** half drives `MockGatewayClient.fetchModelLatency` and checks the
 * claim the layer exists for, which is again a claim about the *other* cards:
 * the reserved-throughput pool behind `azure/gpt-4o` is measurably slower here
 * while the alias in front of it bills and fails ordinarily — so the same
 * deployment `/health` calls failing and the exception log calls rate-limited
 * is slow on a third, independent payload.
 *
 * Like its siblings it sits outside apps/api's tsconfig `include`: a harness,
 * not part of the API build.
 */
import {
  latencyDeploymentKey,
  summarizeGatewayLatency,
  tokensPerSecond,
  LATENCY_ELEVATED_RATIO,
  LATENCY_MIN_DAYS,
} from '@dash/shared';
import type { GatewayLatency } from '@dash/shared';
import { MockGatewayClient } from '../src/gateway/mock.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
};

const close = (a: number, b: number, epsilon = 1e-9): boolean => Math.abs(a - b) < epsilon;

// ----------------------------------------------------------------- pure half

console.log('\nthe deployment key');

check(
  latencyDeploymentKey('azure/gpt-4o', 'https://nocturne-weu.openai.azure.com/') ===
    'https://nocturne-weu.openai.azure.com/',
  'a deployment with a URL is keyed by the URL — the proxy reports the base, not the model',
);
check(
  latencyDeploymentKey('bedrock/anthropic.claude-haiku-4-v1:0', null) ===
    'bedrock/anthropic.claude-haiku-4-v1:0',
  'a deployment with no URL is keyed by its backend model string (Bedrock addresses by region)',
);
check(
  latencyDeploymentKey('azure/gpt-4o', 'https://x.openai.azure.com/openai/deployments/gpt-4o') ===
    'https://x.openai.azure.com',
  'and everything from /openai/ onwards is cut, exactly as the proxy cuts it',
);
check(
  latencyDeploymentKey('azure/gpt-4o', 'nocturne-weu.internal') === 'azure/gpt-4o',
  'a base that is not a URL is not a key — LiteLLM tests for "https://", not for a value',
);
check(
  latencyDeploymentKey('azure/gpt-4o', 'https://one.openai.azure.com/') ===
    latencyDeploymentKey('azure/gpt-4o-mini', 'https://one.openai.azure.com/'),
  'two models behind one endpoint collapse onto one key — the collapse is upstream and cannot be undone',
);

console.log('\nthe unit');

check(
  close(tokensPerSecond(0.008) ?? 0, 125),
  'seconds per token inverts to tokens per second, which is the only transformation that adds no claim',
);
check(tokensPerSecond(0) === null, 'and a zero rate inverts to nothing rather than to infinity');

console.log('\nroll-up');

const payload = (series: GatewayLatency['series']): GatewayLatency => ({
  from: '2026-06-01',
  to: '2026-06-05',
  models: ['azure/gpt-4o'],
  skippedModels: ['azure/o4-mini'],
  series,
  apiBases: ['https://weu/'],
  available: true,
  fetchedAt: '2026-07-01T00:00:00.000Z',
});

const constructed = summarizeGatewayLatency(
  payload([
    {
      model: 'azure/gpt-4o',
      key: 'https://weu/',
      points: [
        { date: '2026-06-02', secondsPerToken: 0.006 },
        { date: '2026-06-01', secondsPerToken: 0.004 },
        { date: '2026-06-03', secondsPerToken: 0.008 },
      ],
    },
    {
      model: 'azure/gpt-4o',
      key: 'https://ptu/',
      points: [
        { date: '2026-06-01', secondsPerToken: 0.02 },
        { date: '2026-06-02', secondsPerToken: 0.02 },
        { date: '2026-06-03', secondsPerToken: 0.02 },
      ],
    },
  ]),
);

const slow = constructed.rows[0];
const fast = constructed.rows[1];
check(
  slow?.key === 'https://ptu/' && fast?.key === 'https://weu/',
  'rows rank slowest first',
);
check(
  fast !== undefined && close(fast.meanSecondsPerToken, 0.006),
  'a row mean is the mean of the daily means, unweighted — the payload carries no request counts to weight by',
);
check(
  fast?.worst.date === '2026-06-03' && fast?.best.date === '2026-06-01',
  'and it carries its own worst and best day, so a steady drag reads differently from a spike',
);
check(
  fast !== undefined && fast.points[0]?.date === '2026-06-01',
  'points are sorted by date whatever order the proxy answered in',
);
check(
  close(constructed.medianSecondsPerToken ?? 0, 0.013),
  'the gateway median is the median of the row means (two rows: their midpoint)',
);
check(
  slow !== undefined && close(slow.ratioToMedian ?? 0, 0.02 / 0.013),
  'each row reports its ratio to that median, which is the only comparison this payload supports',
);
check(
  constructed.daily.length === 3 &&
    constructed.daily[0]?.date === '2026-06-01' &&
    close(constructed.daily[0]?.medianSecondsPerToken ?? 0, 0.012) &&
    constructed.daily[0]?.keys === 2,
  'the daily reading is a median across the keys that reported, never a sum — rates do not add',
);
check(
  constructed.skippedModels.length === 1,
  'the aliases the cap left out survive the roll-up: unread is not clean',
);

console.log('\nthe badge');

const badged = summarizeGatewayLatency(
  payload([
    // Materially slower, on enough days.
    {
      model: 'a',
      key: 'slow',
      points: ['2026-06-01', '2026-06-02', '2026-06-03'].map((date) => ({
        date,
        secondsPerToken: 0.02,
      })),
    },
    // Materially slower, on one day only.
    { model: 'a', key: 'brief', points: [{ date: '2026-06-01', secondsPerToken: 0.02 }] },
    // Slower, and not by enough.
    {
      model: 'a',
      key: 'near',
      points: ['2026-06-01', '2026-06-02', '2026-06-03'].map((date) => ({
        date,
        secondsPerToken: 0.0105,
      })),
    },
    // The rest of the gateway. Three of them, because a median taken over four
    // rows two of which are the outliers is dragged by the very rows the badge
    // is meant to find — which is the argument for a median in the first place.
    ...['base-1', 'base-2', 'base-3'].map((key) => ({
      model: 'a',
      key,
      points: ['2026-06-01', '2026-06-02', '2026-06-03'].map((date) => ({
        date,
        secondsPerToken: 0.01,
      })),
    })),
  ]),
);
const badgeOf = (key: string): boolean =>
  badged.rows.find((row) => row.key === key)?.elevated ?? false;

check(badgeOf('slow'), `a key ${LATENCY_ELEVATED_RATIO}x the median on enough days is badged`);
check(
  !badgeOf('brief'),
  `the same rate on fewer than ${LATENCY_MIN_DAYS} days is not — one slow afternoon is not a slow deployment`,
);
check(
  !badgeOf('near') && (badged.rows.find((row) => row.key === 'near')?.ratioToMedian ?? 0) > 1,
  'and a key above the median but under the ratio reports the ratio and no badge',
);

console.log('\nsilence');

const unread = summarizeGatewayLatency({ ...payload([]), available: false });
check(
  !unread.available && !unread.empty && unread.rows.length === 0,
  'a refused route is not an empty one — available false is never "the gateway was fast"',
);
check(
  summarizeGatewayLatency(payload([])).empty,
  'a route that answered and reported nothing is empty, which is a different silence',
);
check(
  summarizeGatewayLatency(
    payload([{ model: 'a', key: 'k', points: [{ date: '2026-06-01', secondsPerToken: 0 }] }]),
  ).rows.length === 0,
  'a zero or negative rate is dropped rather than ranked as instant',
);
check(
  summarizeGatewayLatency(payload([{ model: 'a', key: 'k', points: [] }])).medianSecondsPerToken ===
    null,
  'and with nothing observed there is no median to take ratios against',
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
// whatever today is.
const to = shift(-1);
const from = shift(-31);

const usage = await mock.fetchUsage(from, to);
const aliases = [
  ...new Set(usage.breakdowns.filter((row) => row.dimension === 'model').map((row) => row.key)),
];
const page = await mock.fetchModelLatency(from, to, aliases);

const seriesOf = (rows: typeof page.rows): GatewayLatency['series'] => {
  const map = new Map<string, GatewayLatency['series'][number]>();
  for (const row of rows) {
    const id = `${row.model} ${row.key}`;
    const existing = map.get(id);
    if (existing === undefined) {
      map.set(id, {
        model: row.model,
        key: row.key,
        points: [{ date: row.date, secondsPerToken: row.secondsPerToken }],
      });
    } else existing.points.push({ date: row.date, secondsPerToken: row.secondsPerToken });
  }
  return [...map.values()];
};

const summary = summarizeGatewayLatency({
  from,
  to,
  models: aliases,
  skippedModels: [],
  series: seriesOf(page.rows),
  apiBases: page.apiBases,
  available: page.available,
  fetchedAt: new Date().toISOString(),
});

check(
  page.available && summary.observedKeys > 0,
  `the mock reports latency (${summary.observedKeys} deployment keys, ${page.rows.length} readings)`,
);
check(
  summary.rows.every((row) => aliases.includes(row.model)),
  'every row is attributed to the alias the read asked about — the row itself carries only the key',
);
check(
  summary.rows.every((row) => (row.tokensPerSecond ?? 0) > 40 && (row.tokensPerSecond ?? 0) < 400),
  'and every rate reads as a plausible generation speed rather than as an outage',
);

// The finding this layer adds: a deployment that is slow behind an alias that
// is unremarkable everywhere else.
const ptuKey = latencyDeploymentKey('azure/gpt-4o', 'https://nocturne-neu-ptu.openai.azure.com/');
const ptu = summary.rows.find((row) => row.key === ptuKey);
const sibling = summary.rows.find(
  (row) => row.model === 'azure/gpt-4o' && row.key !== ptuKey,
);
check(
  ptu !== undefined &&
    sibling !== undefined &&
    ptu.meanSecondsPerToken > sibling.meanSecondsPerToken * 1.7,
  'the refusing reserved pool is measurably slower than the sibling behind the same alias',
);
check(
  ptu?.elevated === true,
  'and it is the deployment the badge lands on',
);

const aliasRows = usage.breakdowns.filter(
  (row) => row.dimension === 'model' && row.key === 'azure/gpt-4o',
);
const gatewayRequests = usage.daily.reduce((sum, day) => sum + day.requests, 0);
const gatewayRate = usage.daily.reduce((sum, day) => sum + day.failedRequests, 0) / gatewayRequests;
const aliasRate =
  aliasRows.reduce((sum, row) => sum + row.failedRequests, 0) /
  aliasRows.reduce((sum, row) => sum + row.requests, 0);
check(
  aliasRate < gatewayRate * 1.5 && aliasRows.every((row) => row.spendNano > 0n),
  'while the alias in front of it bills every day and fails ordinarily — three payloads, one deployment',
);

// The reasoning model: genuinely slower, deliberately under the gate.
const reasoning = summary.rows.find((row) => row.model === 'azure/o4-mini');
check(
  reasoning !== undefined &&
    (reasoning.ratioToMedian ?? 0) > 1 &&
    reasoning.elevated === false,
  'the reasoning deployment is slower than the median and not badged — which is what makes the badge a finding',
);

// The incident, read as slowness rather than only as failures.
const incidentDay = (() => {
  for (const row of summary.rows) {
    if (!row.model.startsWith('bedrock/')) continue;
    const worstDay = Number(row.worst.date.slice(8, 10));
    if (worstDay === 17 || worstDay === 18) return true;
  }
  return false;
})();
check(
  incidentDay,
  'a Bedrock deployment\'s worst day is one of the incident days — a failing region answers late as well',
);

// Both branches of the key rule are live in one payload.
check(
  summary.rows.some((row) => row.key.startsWith('https://')) &&
    summary.rows.some((row) => row.key.startsWith('bedrock/')),
  'the payload exercises both key branches at once: an Azure base and a Bedrock model string',
);
check(
  page.apiBases.length > 0 && page.apiBases.every((base) => base.startsWith('https://')),
  'and all_api_bases carries only the deployments that have one, as evidence beside the rows',
);

const repeat = await mock.fetchModelLatency(from, to, aliases);
check(
  JSON.stringify(repeat.rows) === JSON.stringify(page.rows),
  'asking twice for one window answers identically — this route is read, not sampled',
);
const overlap = await mock.fetchModelLatency(shift(-8), shift(-6), aliases);
const overlapping = overlap.rows.find(
  (row) => row.model === 'azure/gpt-4o' && row.date === shift(-7) && row.key === ptuKey,
);
const original = page.rows.find(
  (row) => row.model === 'azure/gpt-4o' && row.date === shift(-7) && row.key === ptuKey,
);
check(
  overlapping !== undefined &&
    original !== undefined &&
    close(overlapping.secondsPerToken, original.secondsPerToken),
  'and a narrower window answers the same numbers for the days it shares — the readings are date-keyed, not window-keyed',
);

check(
  (await mock.fetchModelLatency(from, to, ['azure/never-configured'])).rows.length === 0,
  'an alias the proxy never routed reports nothing, which is not the same as instant',
);
check(
  (await mock.fetchModelLatency(from, to, [])).rows.length === 0,
  'and asking about no aliases fetches nothing rather than everything',
);

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('gateway latency: all checks passed');
