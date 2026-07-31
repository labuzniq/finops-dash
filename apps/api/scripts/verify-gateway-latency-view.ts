/**
 * Invariant check for the latency *view* — the card that says how slowly the
 * backends answered, over the layer `verify-gateway-latency.ts` already pins.
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-latency-view.ts
 *
 * Two halves.
 *
 * The **pure** half runs `deriveGatewayLatency` over constructed payloads. It
 * checks the three silences (unread, refused, measured-nothing — and only the
 * last is about the gateway), the window read off the trimmed spine, the badge
 * gates in both directions, and the join to `gateway_deployment_health`. That
 * join is where this view differs from the exception one and is the reason the
 * harness exists: `/model/metrics` keys a row by its `api_base` *alone*, so
 * several deployments behind one endpoint collapse onto one key upstream, and a
 * reading that finds one of them failing and another fine describes neither.
 * `mixed` is that state, and it must never read as `failing` or as `healthy`.
 *
 * The **mock** half drives `MockGatewayClient` for both sides of the join and
 * checks the claim the card exists to make: the reserved-throughput pool the
 * health reading finds refusing is measurably slower than its sibling behind
 * the same alias, badged, and named by two independent reads — while the alias
 * itself stays ordinary on every spend- or failure-shaped surface.
 *
 * Like its siblings it sits outside apps/api's tsconfig `include`: a harness,
 * not part of the API build.
 */
import {
  LATENCY_ELEVATED_RATIO,
  LATENCY_MAX_WINDOW_DAYS,
  LATENCY_MIN_DAYS,
  latencyDeploymentKey,
  tokensPerSecond,
} from '@dash/shared';
import type {
  GatewayDailyPoint,
  GatewayDeployment,
  GatewayHealth,
  GatewayLatency,
} from '@dash/shared';
import {
  deriveGatewayLatency,
  latencyBadgeReason,
  latencyWindow,
} from '../../web/src/lib/metrics/gatewayLatency.js';
import { MockGatewayClient } from '../src/gateway/mock.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
};
const close = (a: number, b: number, epsilon = 1e-9): boolean => Math.abs(a - b) < epsilon;

// ----------------------------------------------------------------- fixtures

const day = (date: string, requests: number): GatewayDailyPoint => ({
  date,
  spend: requests * 0.002,
  promptTokens: requests * 900,
  completionTokens: requests * 300,
  totalTokens: requests * 1200,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  requests,
  successfulRequests: requests,
  failedRequests: 0,
  apiRequests: requests,
});

/** A key's readings: one point per date, all at the same rate unless overridden. */
const series = (
  model: string,
  key: string,
  dates: readonly string[],
  secondsPerToken: number | readonly number[],
) => ({
  model,
  key,
  points: dates.map((date, index) => ({
    date,
    secondsPerToken:
      typeof secondsPerToken === 'number' ? secondsPerToken : secondsPerToken[index]!,
  })),
});

const DATES = ['2026-07-25', '2026-07-26', '2026-07-27', '2026-07-28', '2026-07-29'];

const healthRow = (
  backend: string,
  apiBase: string | null,
  healthy: boolean,
  error: string | null = null,
): GatewayDeployment => ({
  id: `dep-${backend}-${apiBase ?? 'none'}`,
  backend,
  model: null,
  provider: backend.split('/')[0] ?? null,
  apiBase,
  healthy,
  error,
  errorStatus: healthy ? null : 429,
  checkedAt: '2026-07-30T02:00:00.000Z',
});

const health = (deployments: GatewayDeployment[]): GatewayHealth => ({
  deployments,
  checkedAt: '2026-07-30T02:00:00.000Z',
});

const WEU = 'https://nocturne-weu.openai.azure.com/';
const PTU = 'https://nocturne-neu-ptu.openai.azure.com/';

const payload = (overrides: Partial<GatewayLatency> = {}): GatewayLatency => ({
  from: DATES[0]!,
  to: DATES[DATES.length - 1]!,
  models: ['azure/gpt-4o', 'bedrock/claude'],
  skippedModels: [],
  series: [
    // The baseline pair: two ordinary keys, so the median is not itself dragged
    // by the outlier the fixture is about (iteration 42's lesson, in the view).
    series('azure/gpt-4o', WEU, DATES, 0.02),
    series('bedrock/claude', 'bedrock/claude', DATES, 0.022),
    series('azure/gpt-4o-mini', 'https://nocturne-neu.openai.azure.com/', DATES, 0.021),
    series('bedrock/nova', 'bedrock/nova', DATES, 0.023),
    // Materially slower, on enough days to mean it.
    series('azure/gpt-4o', PTU, DATES, 0.06),
    // Slow, but seen twice — under the evidence gate.
    series('azure/gpt-4o', 'https://nocturne-eus.openai.azure.com/', DATES.slice(0, 2), 0.09),
  ],
  apiBases: [WEU, PTU],
  available: true,
  fetchedAt: '2026-07-31T08:00:00.000Z',
  ...overrides,
});

// ----------------------------------------------------------------- pure half

console.log('\nthe three silences');

const unread = deriveGatewayLatency(null);
check(
  !unread.answered && !unread.available && !unread.empty && unread.rows.length === 0,
  'a read nobody pressed is unanswered — not an available route, not an empty one',
);
check(
  unread.window === null && unread.medianSecondsPerToken === null,
  'and it invents neither a window nor a median to compare a gateway against',
);

const refused = deriveGatewayLatency(payload({ available: false, series: [] }));
check(
  refused.answered && !refused.available && !refused.empty,
  'a refused route is answered-and-unavailable and never reported as empty — disable_spend_logs is a configuration, not a fast gateway',
);
check(
  refused.window !== null && refused.models.length === 2,
  'and it still says which window and which aliases were asked about',
);

const nothing = deriveGatewayLatency(payload({ series: [] }));
check(
  nothing.answered && nothing.available && nothing.empty && nothing.observedKeys === 0,
  'a route that answered and measured nothing is empty — the query excludes cache hits and needs completion tokens, so silence is not instant',
);

console.log('\nthe window is the tail of the spine, not the range picker');

const spine = [
  ...Array.from({ length: 40 }, (_, index) =>
    day(`2026-06-${String(index + 1).padStart(2, '0')}`, 100),
  ).slice(0, 30),
  ...DATES.map((date) => day(date, 100)),
];
const window = latencyWindow(spine);
check(
  window !== null && window.days === LATENCY_MAX_WINDOW_DAYS,
  `a 35-day spine is read ${LATENCY_MAX_WINDOW_DAYS} days at a time — the route's own cap`,
);
check(
  window?.to === DATES[DATES.length - 1],
  'and it ends on the last *reported* day, never on today — the aggregates end yesterday and the picker does not',
);
const shortWindow = latencyWindow(DATES.map((date) => day(date, 100)));
check(
  shortWindow?.from === DATES[0] && shortWindow.days === DATES.length,
  'a spine shorter than the cap is asked for whole, clamped to its own first day',
);
check(latencyWindow([]) === null, 'and an empty spine asks for nothing — there is no traffic to have been slow');

console.log('\nthe roll-up, and the one unit change this layer allows');

const view = deriveGatewayLatency(payload());
check(view.observedKeys === 6, `every (alias, key) pair that reported is a row (${view.observedKeys})`);
check(
  view.rows.every(
    (row, index) =>
      index === 0 || row.meanSecondsPerToken <= (view.rows[index - 1]?.meanSecondsPerToken ?? 0),
  ),
  'rows rank slowest first',
);
check(
  view.slowest?.key === 'https://nocturne-eus.openai.azure.com/',
  'and the slowest key is named whether or not it cleared the badge gates',
);
check(
  view.medianSecondsPerToken !== null && close(view.medianSecondsPerToken, (0.022 + 0.023) / 2),
  'the gateway figure is a median of the key means, never a sum — rates do not add',
);
check(
  view.medianTokensPerSecond !== null &&
    close(view.medianTokensPerSecond, tokensPerSecond(view.medianSecondsPerToken ?? 1) ?? 0),
  'and its reciprocal is the only re-reading on the card, because it is the only one that adds no claim',
);
const ptuRow = view.rows.find((row) => row.key === PTU);
check(
  ptuRow !== undefined && close(ptuRow.msPerToken, ptuRow.meanSecondsPerToken * 1000),
  'milliseconds per token is a unit change on the same rate — nothing multiplies it by a token count',
);
check(
  view.daily.length === DATES.length &&
    view.daily.every((entry) => entry.medianSecondsPerToken > 0),
  'the daily strip carries one median per day the proxy reported',
);
const thinDay = view.daily.find((entry) => entry.date === DATES[4]);
const fullDay = view.daily.find((entry) => entry.date === DATES[0]);
check(
  thinDay?.keys === 5 && fullDay?.keys === 6,
  'a day where fewer keys reported carries its own key count',
);
check(
  thinDay !== undefined && close(thinDay.coverage, 5 / 6) && fullDay !== undefined && close(fullDay.coverage, 1),
  'and coverage is that count over the keys that reported anywhere — a thin day is a thin reading, never a fast one',
);
check(
  thinDay !== undefined && close(thinDay.medianSecondsPerToken, 0.022),
  'the day median is taken across the keys that reported *that day* and the absent key is not filled in with the gateway figure',
);

console.log('\nthe badge, which is a materiality claim and nothing more');

check(
  ptuRow?.elevated === true &&
    ptuRow.ratioToMedian !== null &&
    ptuRow.ratioToMedian >= LATENCY_ELEVATED_RATIO,
  `a key ${LATENCY_ELEVATED_RATIO}× the median on enough days is badged (${ptuRow?.ratioToMedian?.toFixed(2)}×)`,
);
const thinRow = view.rows.find((row) => row.key === 'https://nocturne-eus.openai.azure.com/');
check(
  thinRow !== undefined && thinRow.days < LATENCY_MIN_DAYS && !thinRow.elevated,
  `the slowest key of all is *not* badged on ${thinRow?.days} days — one slow afternoon is not a slow deployment`,
);
check(
  latencyBadgeReason(thinRow!).includes(`under the ${LATENCY_MIN_DAYS}`),
  'and the card says which gate stopped it, rather than leaving the row looking clean',
);
const baseline = view.rows.find((row) => row.key === WEU);
check(
  baseline !== undefined &&
    !baseline.elevated &&
    latencyBadgeReason(baseline).includes(`under the ${LATENCY_ELEVATED_RATIO}×`),
  'a key under the ratio is rejected on materiality and says so — the proxy averaged the counts away, so there is no significance test to run',
);
check(
  view.elevatedKeys === 1,
  `exactly one key is materially slower than this gateway (${view.elevatedKeys})`,
);

console.log('\nthe join to tonight/s health reading, and the state this key forces');

const joined = deriveGatewayLatency(payload(), {
  health: health([
    healthRow('azure/gpt-4o', WEU, true),
    healthRow('azure/gpt-4o-mini', WEU, true),
    healthRow('azure/gpt-4o', PTU, false, 'litellm.RateLimitError: provisioned throughput exceeded'),
  ]),
});
const joinedPtu = joined.rows.find((row) => row.key === PTU);
const joinedWeu = joined.rows.find((row) => row.key === WEU);
const joinedBedrock = joined.rows.find((row) => row.key === 'bedrock/claude');
check(
  joinedPtu?.health === 'failing' && (joinedPtu.healthError ?? '') !== '',
  'the slow key the reading finds failing is the same deployment twice, with the proxy\'s own error text under it',
);
check(
  joinedWeu?.health === 'healthy' && joinedWeu.behindKey === 2,
  'a base fronting two deployments the reading agrees about is healthy, and the row says how many are behind it',
);
check(
  joinedBedrock?.health === 'unread' && joinedBedrock.behindKey === 0,
  'a key the reading does not name is unread — not healthy: an absent row is silence, and silence is not health',
);
check(
  joined.joinedKeys === 2 && joined.failingJoined === 1 && joined.mixedJoins === 0,
  'the counts follow the rows rather than the reading — two keys named, one of them failing',
);

const mixed = deriveGatewayLatency(payload(), {
  health: health([
    healthRow('azure/gpt-4o', WEU, false, 'litellm.APIConnectionError: connection refused'),
    healthRow('azure/gpt-4o-mini', WEU, true),
  ]),
});
const mixedRow = mixed.rows.find((row) => row.key === WEU);
check(
  mixedRow?.health === 'mixed' && mixedRow.behindKey === 2,
  'a base whose deployments the reading disagrees about is mixed — the collapse is upstream, so the slow number belongs to neither of them',
);
check(
  mixed.failingJoined === 0 && mixed.mixedJoins === 1,
  'and a mixed key is counted as neither failing nor healthy, because attributing it would be picking one',
);

const allFailing = deriveGatewayLatency(payload(), {
  health: health([
    healthRow('azure/gpt-4o', WEU, false, 'litellm.APIConnectionError: connection refused'),
    healthRow('azure/gpt-4o-mini', WEU, false, 'litellm.APIConnectionError: connection refused'),
  ]),
});
check(
  allFailing.rows.find((row) => row.key === WEU)?.health === 'failing',
  'while a base whose deployments are *all* failing is failing — mixed is disagreement, not multiplicity',
);

const stripped = deriveGatewayLatency(payload(), {
  health: health([healthRow('azure/gpt-4o', null, false, 'refused')]),
});
check(
  stripped.rows.find((row) => row.key === WEU)?.health === 'unread',
  'a proxy running health_check_details: false strips api_base, so the key cannot be rebuilt and the row stays unread rather than being guessed at',
);

console.log('\nwhat the cap left out');

const capped = deriveGatewayLatency(
  payload({ models: ['azure/gpt-4o'], skippedModels: ['azure/o4-mini', 'bedrock/nova'] }),
);
check(
  capped.skippedModels.length === 2 && capped.models.length === 1,
  'an alias the sweep did not reach survives the derivation — unmeasured, and the card says so rather than reading as fast',
);

// ----------------------------------------------------------------- mock half

console.log('\nagainst the mock proxy');

const client = new MockGatewayClient();
const to = '2026-07-30';
const from = '2026-07-01';
const usage = await client.fetchUsage(from, to);
const aliases = [
  ...new Set(
    usage.breakdowns.filter((row) => row.dimension === 'model').map((row) => row.key),
  ),
];
const page = await client.fetchModelLatency(from, to, aliases);
const snapshot = await client.fetchHealth();

/** The same grouping `getGatewayLatency` does — one series per (alias, key). */
const grouped = new Map<string, { model: string; key: string; points: { date: string; secondsPerToken: number }[] }>();
for (const row of page.rows) {
  const id = `${row.model} ${row.key}`;
  const existing = grouped.get(id);
  if (existing === undefined) {
    grouped.set(id, {
      model: row.model,
      key: row.key,
      points: [{ date: row.date, secondsPerToken: row.secondsPerToken }],
    });
  } else {
    existing.points.push({ date: row.date, secondsPerToken: row.secondsPerToken });
  }
}

const mockPayload: GatewayLatency = {
  from,
  to,
  models: aliases,
  skippedModels: [],
  series: [...grouped.values()],
  apiBases: page.apiBases,
  available: page.available,
  fetchedAt: new Date().toISOString(),
};
const mockHealth: GatewayHealth = {
  deployments: snapshot.map((row) => ({ ...row, model: null, checkedAt: '2026-07-31T02:00:00.000Z' })),
  checkedAt: '2026-07-31T02:00:00.000Z',
};

const mockView = deriveGatewayLatency(mockPayload, { health: mockHealth });
check(
  mockView.answered && mockView.available && !mockView.empty && mockView.observedKeys > 0,
  `the mock measures ${mockView.observedKeys} deployment keys the card can draw`,
);
check(
  mockView.medianSecondsPerToken !== null && mockView.medianTokensPerSecond !== null,
  `with a gateway median of ${((mockView.medianSecondsPerToken ?? 0) * 1000).toFixed(1)} ms/tok (${(mockView.medianTokensPerSecond ?? 0).toFixed(0)} tok/s)`,
);

const refusingKey = latencyDeploymentKey('azure/gpt-4o', PTU);
const refusing = mockView.rows.find((row) => row.key === refusingKey);
const sibling = mockView.rows.find((row) => row.model === 'azure/gpt-4o' && row.key !== refusingKey);
check(
  refusing !== undefined &&
    sibling !== undefined &&
    refusing.meanSecondsPerToken > sibling.meanSecondsPerToken,
  `the refusing pool is measurably slower than its sibling behind the same alias (${((refusing?.meanSecondsPerToken ?? 0) * 1000).toFixed(1)} vs ${((sibling?.meanSecondsPerToken ?? 0) * 1000).toFixed(1)} ms/tok)`,
);
check(
  refusing?.health === 'failing' && (refusing.healthError ?? '').includes('RateLimitError'),
  'and tonight\'s health reading names the same key, with the quota error under it — two independent reads, one deployment',
);
check(
  sibling?.health !== 'failing',
  'while the sibling is not failing, which is exactly why the alias reads as ordinary on every other card',
);
check(
  mockView.rows.some((row) => row.elevated),
  `at least one key is materially slower than this gateway (${mockView.elevatedKeys})`,
);
check(
  mockView.rows.every((row) => row.days > 0 && row.best.secondsPerToken <= row.worst.secondsPerToken),
  'every row carries its own fastest and slowest day, so a key that is always slow is distinguishable from one that spiked',
);
check(
  mockView.daily.every((entry) => entry.keys > 0 && entry.keys <= mockView.observedKeys),
  'no day claims more reporting keys than the window has',
);

const repeat = deriveGatewayLatency(
  {
    ...mockPayload,
    series: [...(await (async () => {
      const again = await client.fetchModelLatency(from, to, aliases);
      const map = new Map<string, { model: string; key: string; points: { date: string; secondsPerToken: number }[] }>();
      for (const row of again.rows) {
        const id = `${row.model} ${row.key}`;
        const existing = map.get(id);
        if (existing === undefined) {
          map.set(id, { model: row.model, key: row.key, points: [{ date: row.date, secondsPerToken: row.secondsPerToken }] });
        } else {
          existing.points.push({ date: row.date, secondsPerToken: row.secondsPerToken });
        }
      }
      return map.values();
    })())],
  },
  { health: mockHealth },
);
check(
  repeat.rows.length === mockView.rows.length &&
    repeat.rows.every((row, index) =>
      close(row.meanSecondsPerToken, mockView.rows[index]?.meanSecondsPerToken ?? -1),
    ),
  'the same window asked twice derives the same card — the reading is deterministic, so a re-read is evidence rather than noise',
);

console.log(
  failures.length === 0
    ? '\nall checks passed\n'
    : `\n${failures.length} FAILED:\n${failures.map((line) => `  - ${line}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
