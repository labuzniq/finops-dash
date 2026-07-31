/**
 * Invariant check for the hang-counter *view* — the card that says how many
 * calls ran past the proxy's own alerting threshold, over the layer
 * `verify-gateway-slow-responses.ts` already pins.
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-slow-responses-view.ts
 *
 * Two halves.
 *
 * The **pure** half runs `deriveGatewaySlowResponses` over constructed payloads:
 * the three silences (unread, refused, grouped-nothing — and only the last says
 * anything about the gateway), the window read off the trimmed spine, both badge
 * gates from both sides with the reason string that names which one said no, the
 * ledger comparison left unclamped, and the join to
 * `gateway_deployment_health`. That join is where this view differs from the
 * latency one and is the reason the harness exists: this route groups on
 * `api_base` **alone**, so a deployment with no URL is not named at all and every
 * one of them lands in a single bucket. A bucket is not an endpoint, so it takes
 * no verdict — `unkeyed`, which must never read as `unread` and must never be
 * matched against health rows that merely happen to lack a base too.
 *
 * The **mock** half drives `MockGatewayClient` for both sides of the join and
 * checks the three planted shapes: the refusing PTU pool is the one badged key,
 * the two-day regional incident averages away below the badge, and the whole
 * Bedrock fleet arrives as the unattributable bucket. It also checks the one
 * number the layer must never divide by — the ledger's request count for the
 * same days, which the route's own denominator is deliberately short of.
 *
 * Like its siblings it sits outside apps/api's tsconfig `include`: a harness,
 * not part of the API build.
 */
import {
  SLOW_RESPONSE_ELEVATED_RATIO,
  SLOW_RESPONSE_MAX_WINDOW_DAYS,
  SLOW_RESPONSE_MIN_COUNT,
  UNKEYED_DEPLOYMENT,
  slowResponseDeploymentKey,
} from '@dash/shared';
import type {
  GatewayDailyPoint,
  GatewayDeployment,
  GatewayHealth,
  GatewaySlowResponses,
} from '@dash/shared';
import {
  deriveGatewaySlowResponses,
  slowResponseBadgeReason,
  slowResponseWindow,
} from '../../web/src/lib/metrics/gatewaySlowResponses.js';
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

const DATES = ['2026-07-25', '2026-07-26', '2026-07-27', '2026-07-28', '2026-07-29'];
const WEU = 'https://nocturne-weu.openai.azure.com/';
const NEU = 'https://nocturne-neu.openai.azure.com/';
const PTU = 'https://nocturne-neu-ptu.openai.azure.com/';
const EUS = 'https://nocturne-eus.openai.azure.com/';
const THIN = 'https://nocturne-jpe.openai.azure.com/';

/*
 * The fixture is built so the gateway rate (0.533%) is not itself dragged by the
 * key the badge test is about — iteration 42's lesson, and it applies to a share
 * exactly as it did to a median. Five shapes, one per branch of the badge:
 *
 *   WEU  100,000 / 300    0.300%  below the gateway — the interval says no
 *   NEU   80,000 / 250    0.313%  same
 *   EUS  200,000 / 1,200  0.600%  measurably above and 1.13× — the ratio says no
 *   PTU   10,000 / 400    4.000%  7.5× on 400 hangs — badged
 *   THIN       3 / 2     66.667%  two hangs — under the materiality floor
 *   (bucket) 40,000 / 140 0.350%  the unaddressable GROUP BY bucket
 */
const payload = (overrides: Partial<GatewaySlowResponses> = {}): GatewaySlowResponses => ({
  from: DATES[0]!,
  to: DATES[DATES.length - 1]!,
  models: ['azure/gpt-4o', 'azure/gpt-4o-mini', 'bedrock/claude'],
  skippedModels: [],
  rows: [
    { model: 'azure/gpt-4o', key: WEU, total: 60_000, slow: 180 },
    // The same endpoint under a second alias: the route answers per alias, so
    // these are disjoint counts of one deployment's traffic and must be summed.
    { model: 'azure/gpt-4o-mini', key: WEU, total: 40_000, slow: 120 },
    { model: 'azure/gpt-4o-mini', key: NEU, total: 80_000, slow: 250 },
    { model: 'azure/gpt-4o', key: EUS, total: 200_000, slow: 1_200 },
    { model: 'azure/gpt-4o', key: PTU, total: 10_000, slow: 400 },
    { model: 'azure/gpt-4o', key: THIN, total: 3, slow: 2 },
    { model: 'bedrock/claude', key: UNKEYED_DEPLOYMENT, total: 40_000, slow: 140 },
  ],
  available: true,
  fetchedAt: '2026-07-31T08:00:00.000Z',
  ...overrides,
});

// ----------------------------------------------------------------- pure half

console.log('\nthe three silences');

const unread = deriveGatewaySlowResponses(null);
check(
  !unread.answered && !unread.available && !unread.empty && unread.rows.length === 0,
  'a read nobody pressed is unanswered — not an available route, not an empty one',
);
check(
  unread.window === null && unread.slowShare === null,
  'and it invents neither a window nor a hang rate to reassure anybody with',
);

const refused = deriveGatewaySlowResponses(payload({ available: false, rows: [] }));
check(
  refused.answered && !refused.available && !refused.empty,
  'a refused route is answered-and-unavailable and never reported as empty — disable_spend_logs is a configuration, not a gateway where nothing hung',
);
check(
  refused.window !== null && refused.models.length === 3,
  'and it still says which window and which aliases were asked about',
);

const nothing = deriveGatewaySlowResponses(payload({ rows: [] }));
check(
  nothing.answered && nothing.available && nothing.empty && nothing.observedKeys === 0,
  'a route that answered and grouped nothing is empty — cache hits are excluded upstream and the log is pruned on its own schedule, so silence is not health',
);

console.log('\nthe window is the tail of the spine, not the range picker');

const spine = [
  ...Array.from({ length: 30 }, (_, index) =>
    day(`2026-06-${String(index + 1).padStart(2, '0')}`, 100),
  ),
  ...DATES.map((date) => day(date, 100)),
];
const window = slowResponseWindow(spine);
check(
  window !== null && window.days === SLOW_RESPONSE_MAX_WINDOW_DAYS,
  `a 35-day spine is read ${SLOW_RESPONSE_MAX_WINDOW_DAYS} days at a time — the route's own cap`,
);
check(
  window?.to === DATES[DATES.length - 1],
  'and it ends on the last *reported* day, never on today — the aggregates end yesterday and the picker does not',
);
const shortWindow = slowResponseWindow(DATES.map((date) => day(date, 100)));
check(
  shortWindow?.from === DATES[0] && shortWindow.days === DATES.length,
  'a spine shorter than the cap is asked for whole, clamped to its own first day',
);
check(
  slowResponseWindow([]) === null,
  'and an empty spine asks for nothing — there is no traffic on screen to have hung',
);

console.log('\nthe roll-up: per key, because counts of requests may be added');

const view = deriveGatewaySlowResponses(payload());
check(
  view.observedKeys === 6,
  `six deployment keys out of seven rows — the two aliases behind one endpoint are one row (${view.observedKeys})`,
);
const weu = view.rows.find((row) => row.key === WEU);
check(
  weu !== undefined && weu.total === 100_000 && weu.slow === 300 && weu.models.length === 2,
  'and that row carries both aliases with their counts summed — one endpoint answering two aliases returns two disjoint counts of the same traffic',
);
check(
  view.total === 430_003 && view.slow === 2_292,
  `the gateway figures are the sweep's own totals (${view.slow} of ${view.total}), never the ledger's`,
);
check(
  view.slowShare !== null && close(view.slowShare, 2_292 / 430_003),
  `and the gateway hang rate is taken against that denominator (${((view.slowShare ?? 0) * 100).toFixed(3)}%)`,
);
check(
  view.rows.every((row, index) => index === 0 || row.slow <= (view.rows[index - 1]?.slow ?? 0)),
  'rows rank by hangs first — the endpoint carrying the most of them is the one somebody acts on',
);
check(
  view.mostHangs?.key === EUS && view.worstShare !== null && close(view.worstShare, 2 / 3),
  'the row with the most hangs and the highest hang *share* are different rows, and both are named — a busy endpoint and a bad one are not the same finding',
);
check(
  close(
    view.rows.reduce((sum, row) => sum + (row.shareOfSlow ?? 0), 0),
    1,
  ),
  'every hang counted is attributed to exactly one key — the shares of the sweep sum to one',
);

console.log('\nthe badge, and the two gates that guard opposite regimes');

const ptu = view.rows.find((row) => row.key === PTU);
check(
  ptu?.elevated === true && ptu.ratioToGateway !== null && ptu.ratioToGateway >= SLOW_RESPONSE_ELEVATED_RATIO,
  `a key ${ptu?.ratioToGateway?.toFixed(1)}× the gateway rate over ${ptu?.slow} hangs is badged`,
);
check(
  view.elevatedKeys === 1,
  `exactly one key clears both gates (${view.elevatedKeys}) — a badge that fired on everything above the mean would fire on half the table`,
);
const thin = view.rows.find((row) => row.key === THIN);
check(
  thin !== undefined && !thin.elevated && thin.slowShare !== null && thin.slowShare > 0.5,
  'the *highest* hang share in the window is not badged: two of three calls is not evidence of anything',
);
check(
  slowResponseBadgeReason(thin!, view.slowShare).includes(`under the ${SLOW_RESPONSE_MIN_COUNT}`),
  'and the card names the floor that rejected it rather than leaving the row looking clean',
);
const eus = view.rows.find((row) => row.key === EUS);
check(
  eus !== undefined && !eus.elevated && slowResponseBadgeReason(eus, view.slowShare).includes('under the 1.5×'),
  'a key measurably above the gateway rate but only 1.13× it is rejected on materiality, and says so — at these volumes significance alone flags everything above the mean',
);
check(
  weu !== undefined &&
    !weu.elevated &&
    slowResponseBadgeReason(weu, view.slowShare).includes('inside the noise'),
  'while a key *below* the gateway rate is rejected by the interval, which is a different sentence',
);

console.log('\nthe ledger comparison, which is a disagreement and never a denominator');

const withLedger = deriveGatewaySlowResponses(payload(), { ledgerRequests: 500_000 });
check(
  withLedger.ledgerRequests === 500_000 &&
    withLedger.ledgerShare !== null &&
    close(withLedger.ledgerShare, 430_003 / 500_000),
  'the ledger count travels beside the route\'s own total as a ratio between two tables',
);
check(
  close(withLedger.slowShare ?? 0, view.slowShare ?? 0) &&
    withLedger.rows.every((row, index) => close(row.slowShare ?? 0, view.rows[index]?.slowShare ?? -1)),
  'and not one figure on the card moves when it is supplied — nothing here is divided by the ledger',
);
const overLedger = deriveGatewaySlowResponses(payload(), { ledgerRequests: 400_000 });
check(
  (overLedger.ledgerShare ?? 0) > 1,
  'a route that grouped more rows than the ledger counted reads over 100% — unclamped, because two independently pruned tables may disagree in either direction',
);
check(
  deriveGatewaySlowResponses(payload(), { ledgerRequests: null }).ledgerShare === null,
  'and a window the spine does not cover reports no ratio rather than a zero',
);

console.log('\nthe join to tonight\'s health reading, and the state this key forces');

const joined = deriveGatewaySlowResponses(payload(), {
  health: health([
    healthRow('azure/gpt-4o', WEU, true),
    healthRow('azure/gpt-4o-mini', WEU, true),
    healthRow('azure/gpt-4o', PTU, false, 'litellm.RateLimitError: provisioned throughput exceeded'),
    // A deployment the reading carries with no api_base of its own. It must
    // *not* land in the proxy's unnamed bucket: two unrelated absences are not
    // a match, and treating them as one would file a Bedrock fleet's hangs
    // under whichever deployment this proxy failed to give a URL.
    healthRow('bedrock/claude-3-5-sonnet', null, false, 'litellm.APIConnectionError: refused'),
  ]),
});
const joinedPtu = joined.rows.find((row) => row.key === PTU);
const joinedWeu = joined.rows.find((row) => row.key === WEU);
const joinedBucket = joined.rows.find((row) => row.key === UNKEYED_DEPLOYMENT);
const joinedNeu = joined.rows.find((row) => row.key === NEU);
check(
  joinedPtu?.health === 'failing' && (joinedPtu.healthError ?? '').includes('RateLimitError'),
  'the hanging key the reading finds failing is the same deployment twice, with the proxy\'s own error text under it',
);
check(
  joinedWeu?.health === 'healthy' && joinedWeu.behindKey === 2,
  'a base fronting two deployments the reading agrees about is healthy, and the row says how many are behind it',
);
check(
  joinedNeu?.health === 'unread' && joinedNeu.behindKey === 0,
  'a key the reading does not name is unread — not healthy: an absent row is silence',
);
check(
  joinedBucket?.health === 'unkeyed' && joinedBucket.behindKey === 0,
  'and the GROUP BY bucket takes no verdict at all — it is not an endpoint, so there is nothing to look up rather than nothing said',
);
check(
  joined.unkeyedRows === 1 && joined.joinedKeys === 2 && joined.failingJoined === 1,
  'the bucket is counted as neither joined nor unread, so "keys the reading names" stays a statement about endpoints',
);

const mixed = deriveGatewaySlowResponses(payload(), {
  health: health([
    healthRow('azure/gpt-4o', WEU, false, 'litellm.APIConnectionError: connection refused'),
    healthRow('azure/gpt-4o-mini', WEU, true),
  ]),
});
check(
  mixed.rows.find((row) => row.key === WEU)?.health === 'mixed' && mixed.mixedJoins === 1,
  'a base whose deployments the reading disagrees about is mixed — the collapse is upstream, so the hang count belongs to neither of them',
);
check(
  mixed.failingJoined === 0,
  'and a mixed key is counted as neither failing nor healthy, because attributing it would be picking one',
);

const stripped = deriveGatewaySlowResponses(payload(), {
  health: health([healthRow('azure/gpt-4o', null, false, 'refused')]),
});
check(
  stripped.rows.find((row) => row.key === WEU)?.health === 'unread' &&
    stripped.rows.find((row) => row.key === UNKEYED_DEPLOYMENT)?.health === 'unkeyed',
  'a proxy running health_check_details: false strips every api_base, so no row is guessed at in either direction',
);

console.log('\nwhat the cap left out');

const capped = deriveGatewaySlowResponses(
  payload({ models: ['azure/gpt-4o'], skippedModels: ['azure/o4-mini', 'bedrock/nova'] }),
);
check(
  capped.skippedModels.length === 2 && capped.models.length === 1,
  'an alias the sweep did not reach survives the derivation — unswept, and the card says so rather than reading as healthy',
);

// ----------------------------------------------------------------- mock half

console.log('\nagainst the mock proxy');

const client = new MockGatewayClient();
const from = '2026-07-01';
const to = '2026-07-30';
const usage = await client.fetchUsage(from, to);
const aliases = [
  ...new Set(usage.breakdowns.filter((row) => row.dimension === 'model').map((row) => row.key)),
];
const page = await client.fetchModelSlowResponses(from, to, aliases);
const snapshot = await client.fetchHealth();

const ledgerRequests = usage.daily.reduce((sum, point) => sum + point.requests, 0);
const mockPayload: GatewaySlowResponses = {
  from,
  to,
  models: aliases,
  skippedModels: [],
  rows: page.rows,
  available: page.available,
  fetchedAt: new Date().toISOString(),
};
const mockHealth: GatewayHealth = {
  deployments: snapshot.map((row) => ({
    ...row,
    model: null,
    checkedAt: '2026-07-31T02:00:00.000Z',
  })),
  checkedAt: '2026-07-31T02:00:00.000Z',
};

const mockView = deriveGatewaySlowResponses(mockPayload, { ledgerRequests, health: mockHealth });
check(
  mockView.answered && mockView.available && !mockView.empty && mockView.observedKeys > 0,
  `the mock groups ${mockView.observedKeys} deployment keys the card can draw, at ${((mockView.slowShare ?? 0) * 100).toFixed(2)}% gateway-wide`,
);
check(
  mockView.ledgerShare !== null && mockView.ledgerShare < 1,
  `the route's own denominator is short of the ledger's requests for the same days (${((mockView.ledgerShare ?? 0) * 100).toFixed(1)}%) — cache hits are excluded upstream, which is why nothing here divides by the ledger`,
);

const ptuKey = slowResponseDeploymentKey('https://nocturne-neu-ptu.openai.azure.com/');
const mockPtu = mockView.rows.find((row) => row.key === ptuKey);
check(
  mockPtu?.elevated === true,
  `the refusing PTU pool is badged (${((mockPtu?.slowShare ?? 0) * 100).toFixed(2)}%, ${mockPtu?.ratioToGateway?.toFixed(1)}× the gateway)`,
);
check(
  mockPtu?.health === 'failing' && (mockPtu.healthError ?? '') !== '',
  'and tonight\'s health reading names the same endpoint — a third independent payload about one deployment, after the error log and the latency aggregate',
);
check(
  mockView.elevatedKeys === 1,
  `it is the only badged key (${mockView.elevatedKeys}) — the two-day regional incident averages away over a month, exactly as it does on the reliability card`,
);

const bucket = mockView.rows.find((row) => row.key === UNKEYED_DEPLOYMENT);
check(
  bucket !== undefined && bucket.health === 'unkeyed' && bucket.models.length > 1,
  `every Bedrock deployment of every alias arrives as one unattributable bucket (${bucket?.models.length} aliases, ${bucket?.slow} hangs) — the route's coarsest trap, reproduced rather than repaired`,
);
check(
  mockView.rows.every((row) => row.slow <= row.total && row.total > 0),
  'no key reports more hangs than requests, and a row with no requests is dropped rather than reported as an infinite share',
);

const repeat = deriveGatewaySlowResponses(
  { ...mockPayload, rows: (await client.fetchModelSlowResponses(from, to, aliases)).rows },
  { ledgerRequests, health: mockHealth },
);
check(
  repeat.rows.length === mockView.rows.length &&
    repeat.rows.every((row, index) => row.slow === mockView.rows[index]?.slow),
  'the same window asked twice derives the same card — the reading is deterministic, so a re-read is evidence rather than noise',
);

console.log(
  failures.length === 0
    ? '\nall checks passed\n'
    : `\n${failures.length} FAILED:\n${failures.map((line) => `  - ${line}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
