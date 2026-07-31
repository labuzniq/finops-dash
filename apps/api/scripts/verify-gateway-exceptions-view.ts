/**
 * Invariant check for the exception *view* — the card that says why calls
 * failed, over the layer verify-gateway-exceptions.ts already pins.
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-exceptions-view.ts
 *
 * Two halves.
 *
 * The **pure** half runs `deriveGatewayExceptions` over constructed payloads: a
 * read nobody has pressed, a route the proxy refuses, and a route that answered
 * with nothing are three different silences and only the last one is about the
 * gateway; the shares are shares of what was *recorded* and the one figure that
 * touches the ledger is deliberately unclamped; and the join to
 * `gateway_deployment_health` runs one way, with an absent health row reported
 * as unread rather than as healthy.
 *
 * The **mock** half drives `MockGatewayClient` for both sides of that join and
 * checks the claim the card exists to make: the reserved-throughput pool the
 * health reading finds failing is the same deployment the exception log names,
 * it is rate limits and almost nothing else, and the exception total disagrees
 * with the ledger's failures for the same days — which is the disagreement the
 * card is built to show rather than to reconcile.
 *
 * Like its siblings it sits outside apps/api's tsconfig `include`: a harness,
 * not part of the API build.
 */
import {
  classifyGatewayException,
  deploymentExceptionKey,
  EXCEPTION_MAX_WINDOW_DAYS,
} from '@dash/shared';
import type {
  GatewayDailyPoint,
  GatewayDeployment,
  GatewayExceptions,
  GatewayHealth,
} from '@dash/shared';
import {
  deriveGatewayExceptions,
  exceptionWindow,
  ledgerFailuresIn,
} from '../../web/src/lib/metrics/gatewayExceptions.js';
import { MockGatewayClient } from '../src/gateway/mock.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
};
const close = (a: number, b: number, epsilon = 1e-9): boolean => Math.abs(a - b) < epsilon;

// ----------------------------------------------------------------- fixtures

const day = (date: string, requests: number, failed: number): GatewayDailyPoint => ({
  date,
  spend: requests * 0.002,
  promptTokens: requests * 900,
  completionTokens: requests * 300,
  totalTokens: requests * 1200,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  requests,
  successfulRequests: requests - failed,
  failedRequests: failed,
  apiRequests: requests,
});

const deployment = (
  key: string,
  model: string,
  counts: Record<string, number>,
  reportedTotal?: number,
) => {
  const exceptions = Object.entries(counts).map(([type, count]) => ({
    type,
    class: classifyGatewayException(type),
    count,
  }));
  return {
    deployment: key,
    model,
    exceptions,
    total: exceptions.reduce((sum, entry) => sum + entry.count, 0),
    reportedTotal: reportedTotal ?? exceptions.length,
  };
};

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

const payload = (
  overrides: Partial<GatewayExceptions> = {},
): GatewayExceptions => ({
  from: '2026-07-01',
  to: '2026-07-30',
  models: ['azure/gpt-4o', 'bedrock/claude'],
  skippedModels: [],
  deployments: [
    deployment('azure/gpt-4o-https://weu.openai.azure.com/', 'azure/gpt-4o', {
      RateLimitError: 600,
      Timeout: 40,
    }),
    deployment('azure/gpt-4o-https://ptu.openai.azure.com/', 'azure/gpt-4o', {
      RateLimitError: 300,
    }),
    deployment('bedrock/claude', 'bedrock/claude', {
      ServiceUnavailableError: 50,
      AuthenticationError: 10,
    }),
  ],
  available: true,
  fetchedAt: '2026-07-31T08:00:00.000Z',
  ...overrides,
});

// ----------------------------------------------------------------- pure half

console.log('\nthe three silences');

const unread = deriveGatewayExceptions(null, { ledgerFailures: 900 });
check(
  !unread.answered && !unread.available && !unread.empty && unread.total === 0,
  'a read nobody pressed is unanswered — not an available route, not an empty one',
);
check(
  unread.ledgerFailures === 900 && unread.recordedShare === null,
  'and it carries the ledger figure it was given without inventing a comparison against nothing',
);

const refused = deriveGatewayExceptions(payload({ available: false, deployments: [] }));
check(
  refused.answered && !refused.available && !refused.empty,
  'a refused route is answered-and-unavailable, and is never reported as empty — disable_error_logs is a configuration, not a clean gateway',
);
check(
  refused.window !== null && refused.models.length === 2,
  'and it still says which window and which aliases were asked about',
);

const nothing = deriveGatewayExceptions(payload({ deployments: [] }), { ledgerFailures: 412 });
check(
  nothing.answered && nothing.available && nothing.empty && nothing.total === 0,
  'a route that answered and recorded nothing is empty — "no errors recorded", which is a different claim from no errors',
);
check(
  nothing.ledgerFailures === 412 && nothing.classes.length === 0,
  'and the ledger figure survives it, so the card can say what the other table counted over the same days',
);

console.log('\nroll-up and the shares this layer is allowed to draw');

const view = deriveGatewayExceptions(payload(), { ledgerFailures: 1200 });
check(view.total === 1000, `every recorded exception is counted (${view.total})`);
check(
  close(
    view.classes.reduce((sum, row) => sum + row.share, 0),
    1,
  ),
  'the class shares are shares of what was recorded and sum to one',
);
check(
  view.dominant?.class === 'rate-limit' && view.dominant.owner === 'capacity',
  'the dominant class names the party that can act on it — the whole point of the taxonomy',
);
check(
  close(view.dominant?.share ?? 0, 0.9),
  'and its share is of the recorded exceptions, never of traffic (90%)',
);
check(
  view.classes.every((row) => row.owner !== '' && row.label !== '') &&
    view.classes.every((row) =>
      row.types.every((type, index) => index === 0 || type.count <= (row.types[index - 1]?.count ?? 0)),
    ),
  'every class carries its owner and its own exception types, largest first',
);
check(
  view.deployments.every(
    (row, index) => index === 0 || row.total <= (view.deployments[index - 1]?.total ?? 0),
  ) && view.deployments[0]?.total === 640,
  'deployments rank by what they recorded, heaviest first',
);
check(
  view.deployments[0]?.dominantClass === 'rate-limit' &&
    close(view.deployments[0]?.dominantShare ?? 0, 600 / 640),
  'and each one names the class carrying most of its own exceptions',
);

console.log('\nthe ledger comparison, which is not a coverage figure');

check(
  view.recordedShare !== null && close(view.recordedShare, 1000 / 1200),
  'exceptions recorded over failures counted is reported when both are known',
);
const overRecorded = deriveGatewayExceptions(payload(), { ledgerFailures: 400 });
check(
  (overRecorded.recordedShare ?? 0) > 1,
  'and it is never clamped: a retried call failing twice logs two exceptions against one failed request, so past 100% is a real reading',
);
check(
  deriveGatewayExceptions(payload(), { ledgerFailures: 0 }).recordedShare === null &&
    deriveGatewayExceptions(payload()).recordedShare === null,
  'with no ledger figure — or a window the ledger recorded no failures in — there is no ratio rather than an infinite one',
);

console.log('\nthe join to the health reading, which runs one way only');

const health: GatewayHealth = {
  deployments: [
    healthRow('azure/gpt-4o', 'https://ptu.openai.azure.com/', false, 'Rate limit reached'),
    healthRow('azure/gpt-4o', 'https://weu.openai.azure.com/', true),
  ],
  checkedAt: '2026-07-30T02:00:00.000Z',
};
const joined = deriveGatewayExceptions(payload(), { health });
const ptu = joined.deployments.find((row) => row.deployment.includes('ptu'));
const weu = joined.deployments.find((row) => row.deployment.includes('weu'));
const bedrock = joined.deployments.find((row) => row.model === 'bedrock/claude');
check(
  ptu?.health === 'failing' && ptu.healthError === 'Rate limit reached',
  'a deployment the reading found failing is flagged as failing, with the proxy\'s own error text beside its exceptions',
);
check(weu?.health === 'healthy', 'the sibling the reading found healthy is flagged as healthy');
check(
  bedrock?.health === 'unread' && bedrock.healthError === null,
  'a deployment the reading does not name is unread — silence is never drawn as health',
);
check(
  joined.joinedDeployments === 2 && joined.failingJoined === 1,
  'and the counts the card leads with follow the join rather than the row count',
);

const strippedHealth: GatewayHealth = {
  deployments: [healthRow('bedrock/claude', null, false, 'Read timeout')],
  checkedAt: '2026-07-30T02:00:00.000Z',
};
const stripped = deriveGatewayExceptions(payload(), { health: strippedHealth });
check(
  stripped.deployments.find((row) => row.model === 'bedrock/claude')?.health === 'failing',
  'a deployment with no api_base keys on its backend alone, which is how Bedrock and a details-stripped proxy both report',
);
check(
  deriveGatewayExceptions(payload(), { health: { deployments: [], checkedAt: null } })
    .deployments.every((row) => row.health === 'unread'),
  'a reading nobody has taken leaves every row unread rather than marking the gateway healthy',
);

console.log('\nthe window, taken off the spine rather than off the picker');

const spine: GatewayDailyPoint[] = [];
for (let index = 0; index < 60; index += 1) {
  const date = new Date(Date.UTC(2026, 4, 1 + index)).toISOString().slice(0, 10);
  spine.push(day(date, 1000, index === 3 ? 90 : 10));
}
const windowOf60 = exceptionWindow(spine);
check(
  windowOf60?.to === spine[spine.length - 1]?.date && windowOf60?.days === EXCEPTION_MAX_WINDOW_DAYS,
  `a long spine is read from its own last day back ${EXCEPTION_MAX_WINDOW_DAYS} days, not from today`,
);
const shortSpine = spine.slice(0, 5);
const windowOf5 = exceptionWindow(shortSpine);
check(
  windowOf5?.from === shortSpine[0]?.date && windowOf5?.to === shortSpine[4]?.date,
  'a spine shorter than the cap is read whole rather than reaching before it',
);
check(exceptionWindow([]) === null, 'and an empty spine asks for nothing — there are no failures on screen to explain');

check(
  ledgerFailuresIn(spine, windowOf5) === 90 + 10 * 4,
  'the ledger figure counts only the days inside the window',
);
check(
  ledgerFailuresIn(spine, null) === null &&
    ledgerFailuresIn(spine, { from: '2020-01-01', to: '2020-01-05', days: 5 }) === null,
  'and a window the spine does not cover yields no figure rather than zero',
);

console.log('\nan alias the cap left out');

const capped = deriveGatewayExceptions(
  payload({ models: ['azure/gpt-4o'], skippedModels: ['bedrock/claude', 'azure/o4-mini'] }),
);
check(
  capped.skippedModels.length === 2 && capped.models.length === 1,
  'the skipped aliases survive the derivation — a capped read that says nothing reads as a clean gateway',
);

// ----------------------------------------------------------------- mock half

console.log('\nagainst the mock proxy');

const mock = new MockGatewayClient();
const iso = (date: Date): string => date.toISOString().slice(0, 10);
const shift = (days: number): string => {
  const cursor = new Date();
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return iso(cursor);
};
const to = shift(-1);
const from = shift(-30);

const usage = await mock.fetchUsage(from, to);
const aliases = [
  ...new Set(usage.breakdowns.filter((row) => row.dimension === 'model').map((row) => row.key)),
];
const page = await mock.fetchModelExceptions(from, to, aliases);
const readings = await mock.fetchHealth();

const live: GatewayExceptions = {
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
};

const mockHealth: GatewayHealth = {
  deployments: readings.map((row) => ({
    id: row.id,
    backend: row.backend,
    model: null,
    provider: row.provider,
    apiBase: row.apiBase,
    healthy: row.healthy,
    error: row.error,
    errorStatus: row.errorStatus,
    checkedAt: new Date().toISOString(),
  })),
  checkedAt: new Date().toISOString(),
};

const ledgerFailures = usage.daily.reduce((sum, point) => sum + point.failedRequests, 0);
const mockView = deriveGatewayExceptions(live, { ledgerFailures, health: mockHealth });

check(
  mockView.answered && mockView.available && !mockView.empty && mockView.total > 0,
  `the mock records exceptions the card can draw (${mockView.total} over ${mockView.deployments.length} deployments)`,
);
check(
  mockView.joinedDeployments > 0 &&
    mockView.joinedDeployments <= mockView.deployments.length,
  `the health reading names ${mockView.joinedDeployments} of them — the join only this layer's key makes possible`,
);

// The finding the card exists for: two sources agreeing about a deployment no
// spend- or failure-shaped surface can see.
const refusingKey = deploymentExceptionKey(
  'azure/gpt-4o',
  'https://nocturne-neu-ptu.openai.azure.com/',
);
const refusing = mockView.deployments.find((row) => row.deployment === refusingKey);
check(
  refusing?.health === 'failing' && refusing.dominantClass === 'rate-limit',
  'the pool the health reading finds failing is the same one the exception log names, and it is a quota',
);
check(
  (refusing?.dominantShare ?? 0) > 0.9 && (refusing?.healthError ?? '') !== '',
  'with its own error text from the reading beside its classes — two independent sources, one fault',
);
check(
  mockView.deployments.some((row) => row.model === 'azure/gpt-4o' && row.health === 'healthy'),
  'while the sibling behind the same alias is healthy, which is why the alias itself looks ordinary everywhere else',
);

check(
  mockView.classes.some((row) => row.class === 'auth') &&
    mockView.classes.some((row) => row.class === 'budget'),
  'the two classes that appear on no other surface at all are both here',
);
check(
  mockView.classes.every((row) => row.owner !== ''),
  'and every class the mock produces maps to an owner rather than to "unclassified"',
);

check(
  mockView.recordedShare !== null && !close(mockView.recordedShare, 1, 0.02),
  `the exception total and the ledger's failures disagree on purpose (${mockView.total} vs ${ledgerFailures}, ${((mockView.recordedShare ?? 0) * 100).toFixed(1)}%)`,
);
check(
  mockView.deployments.some((row) => row.reportedTotal < row.total),
  'and the proxy\'s own total_exceptions disagrees with both — the card labels it as a count of classes',
);

const spineWindow = exceptionWindow(usage.daily.map((point) => ({ ...point })) as GatewayDailyPoint[]);
check(
  spineWindow !== null && spineWindow.days <= EXCEPTION_MAX_WINDOW_DAYS,
  'the window derived from a real spine stays inside the route\'s own cap',
);

console.log(
  failures.length === 0
    ? '\nall checks passed\n'
    : `\n${failures.length} FAILED:\n${failures.map((line) => `  - ${line}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
