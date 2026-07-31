/**
 * Contract check for the *live* gateway source, `LiteLlmGatewayClient`.
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-litellm-contract.ts
 *
 * Every other gateway verify script in this folder drives the *mock* source,
 * which never exercises a line of `litellm.ts`. This one stands up a throwaway
 * HTTP server that answers LiteLLM's published `SpendAnalyticsPaginatedResponse`
 * envelope and points the real client at it, so the wire-level behaviour —
 * pagination, auth, retries, optional-endpoint skipping, exponent-notation
 * spend, the no-double-counting rule for team/tag — is checked against a
 * server rather than against a reading of the docs.
 *
 * It cannot confirm that a real proxy *sends* these shapes; that is still the
 * open question in docs/litellm-gateway.md. What it does confirm is that the
 * client handles the documented shape, and it is the harness to replay a real
 * captured response through the day one exists: drop the JSON into a handler
 * and the assertions below become a conformance test of the proxy.
 *
 * It sits outside apps/api's tsconfig `include`, like its siblings — it is a
 * harness, not part of the API build.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  budgetCounterResets,
  budgetPeriodStart,
  budgetRemaining,
  budgetUtilization,
  classifyGatewayException,
  deploymentExceptionKey,
  latencyDeploymentKey,
  parseBudgetDuration,
  resolveDeploymentModel,
  resolveModelPrice,
  slowResponseDeploymentKey,
  summarizeDeploymentHealth,
  summarizeGatewayProbe,
  UNKEYED_DEPLOYMENT,
} from '@dash/shared';
import type {
  GatewayBudget,
  GatewayDeployment,
  GatewayModelPrice,
  GatewayProbeRoute,
} from '@dash/shared';
import { LiteLlmGatewayClient, eachDay } from '../src/gateway/litellm.js';
import type { GatewayBreakdownSnapshot, GatewaySnapshot } from '../src/gateway/types.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
};

// ------------------------------------------------------------- fake proxy

interface Captured {
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
  accept: string | undefined;
}

interface Reply {
  status: number;
  /** Object → JSON. String → sent verbatim, for malformed-body cases. */
  body: unknown;
}

type Handler = (captured: Captured, callIndex: number) => Reply;

interface Proxy {
  baseUrl: string;
  calls: Captured[];
  close: () => Promise<void>;
}

async function startProxy(handler: Handler): Promise<Proxy> {
  const calls: Captured[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const captured: Captured = {
      path: url.pathname,
      query: url.searchParams,
      authorization: req.headers.authorization,
      accept: typeof req.headers.accept === 'string' ? req.headers.accept : undefined,
    };
    const index = calls.length;
    calls.push(captured);

    const reply = handler(captured, index);
    const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(payload);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Runs `body` against a proxy and always closes it. */
async function withProxy<T>(handler: Handler, body: (proxy: Proxy) => Promise<T>): Promise<T> {
  const proxy = await startProxy(handler);
  try {
    return await body(proxy);
  } finally {
    await proxy.close();
  }
}

// ------------------------------------------------------- fixture builders

/** A `SpendMetrics` object; every field is optional on the wire. */
function metrics(over: Partial<Record<string, number>> = {}): Record<string, number> {
  return {
    spend: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_tokens: 0,
    successful_requests: 0,
    failed_requests: 0,
    api_requests: 0,
    ...over,
  };
}

function bucket(over: Partial<Record<string, number>>, metadata: Record<string, unknown> = {}) {
  return { metrics: metrics(over), metadata };
}

function envelope(results: unknown[], over: Partial<Record<string, unknown>> = {}) {
  return {
    results,
    metadata: { total_spend: 0, page: 1, total_pages: 1, has_more: false, ...over },
  };
}

const FROM = '2026-07-01';
const TO = '2026-07-05';

const find = (
  rows: GatewayBreakdownSnapshot[],
  dimension: string,
  key: string,
  date: string,
): GatewayBreakdownSnapshot | undefined =>
  rows.find((row) => row.dimension === dimension && row.key === key && row.date === date);

const client = (baseUrl: string) => new LiteLlmGatewayClient(baseUrl, 'sk-test-key');

// =====================================================================
// 1 · The documented happy path, across all three endpoints
// =====================================================================
//
// /user answers two pages, /team answers one, /tag is absent (404). The user
// endpoint alone contributes gateway-wide totals; team and tag contribute only
// their `entities` breakdown. Spend values are deliberately awkward: exponent
// notation, a sub-nanodollar, and one bucket repeated across pages.

console.log('\n1 · happy path — three endpoints, two pages, all dimensions');

const snapshot = await withProxy(
  (captured) => {
    if (captured.path === '/user/daily/activity') {
      const page = captured.query.get('page');
      if (page === '1') {
        return {
          status: 200,
          body: envelope(
            [
              {
                // Timestamped form — LiteLLM has emitted both.
                date: '2026-07-01T00:00:00',
                metrics: metrics({
                  spend: 12.5,
                  prompt_tokens: 1_000,
                  completion_tokens: 400,
                  total_tokens: 1_400,
                  cache_read_input_tokens: 250,
                  cache_creation_input_tokens: 60,
                  successful_requests: 98,
                  failed_requests: 2,
                  api_requests: 100,
                }),
                breakdown: {
                  models: {
                    'azure/gpt-4o': bucket({ spend: 12.4, api_requests: 90 }),
                    // Exponent notation — String() would hand this to parseNano verbatim.
                    'bedrock/claude-3-haiku': bucket({ spend: 1.095e-5, api_requests: 10 }),
                  },
                  providers: {
                    azure: bucket({ spend: 12.4, api_requests: 90 }),
                    bedrock: bucket({ spend: 1.095e-5, api_requests: 10 }),
                  },
                  api_keys: {
                    '9f2b1c0a4d': bucket(
                      { spend: 12.5, api_requests: 100 },
                      { key_alias: 'copilot-agents', team_id: 'team-platform' },
                    ),
                    // No metadata at all → label must be null, not the id echoed twice.
                    aa11bb22cc: bucket({ spend: 0 }),
                    // Empty key — dropped rather than stored as a row with no identity.
                    '': bucket({ spend: 99 }),
                  },
                  mcp_servers: { github: bucket({ spend: 0.5, api_requests: 7 }) },
                  entities: {
                    'u-101': bucket({ spend: 12.5, api_requests: 100 }, { user_email: 'ada@corp' }),
                  },
                },
              },
            ],
            { page: 1, total_pages: 2, has_more: true },
          ),
        };
      }
      return {
        status: 200,
        body: envelope(
          [
            {
              date: '2026-07-02',
              // Sub-nanodollar: documented to round to zero.
              metrics: metrics({ spend: 4e-10, api_requests: 1, successful_requests: 1 }),
              breakdown: {
                models: { 'azure/gpt-4o': bucket({ spend: 4e-10, api_requests: 1 }) },
              },
            },
            {
              // Same day *and* same bucket as page 1 — must accumulate, not replace.
              date: '2026-07-01',
              metrics: metrics({ spend: 0.5, api_requests: 5, successful_requests: 5 }),
              breakdown: {
                models: { 'azure/gpt-4o': bucket({ spend: 0.5, api_requests: 5 }) },
              },
            },
          ],
          { page: 2, total_pages: 2, has_more: false },
        ),
      };
    }

    if (captured.path === '/team/daily/activity') {
      return {
        status: 200,
        body: envelope([
          {
            date: '2026-07-01',
            // The same dollars, re-sliced. Adding these in would double-count.
            metrics: metrics({ spend: 12.5, api_requests: 100 }),
            breakdown: {
              // A team endpoint also reports models/providers; they must be
              // ignored, or every model row would count twice.
              models: { 'azure/gpt-4o': bucket({ spend: 12.4 }) },
              entities: {
                'team-platform': bucket(
                  { spend: 12.5, api_requests: 100 },
                  { team_alias: 'Platform' },
                ),
              },
            },
          },
        ]),
      };
    }

    // /tag — this proxy has no tags configured.
    return { status: 404, body: { detail: 'Not Found' } };
  },
  (proxy) => client(proxy.baseUrl).fetchUsage(FROM, TO),
);

const dims = new Set(snapshot.breakdowns.map((row) => row.dimension));
const day1 = snapshot.daily.find((row) => row.date === '2026-07-01');
const day2 = snapshot.daily.find((row) => row.date === '2026-07-02');

check(snapshot.daily.length === 2, `two reported days (got ${snapshot.daily.length})`);
check(
  snapshot.daily[0]?.date === '2026-07-01' && snapshot.daily[1]?.date === '2026-07-02',
  'days normalised to calendar dates and sorted ascending',
);
check(day1?.spendNano === 13_000_000_000n, `day totals accumulate across pages ($13.00 exact)`);
check(day1?.requests === 105 && day1?.failedRequests === 2, 'request counters accumulate');
check(day2?.spendNano === 0n, 'sub-nanodollar spend rounds to zero');
check(
  find(snapshot.breakdowns, 'model', 'bedrock/claude-3-haiku', '2026-07-01')?.spendNano === 10_950n,
  'exponent-notation spend (1.095e-05) parses to 10950 nano',
);
check(
  find(snapshot.breakdowns, 'model', 'azure/gpt-4o', '2026-07-01')?.spendNano === 12_900_000_000n,
  'one bucket split across pages accumulates',
);
check(
  find(snapshot.breakdowns, 'api_key', '9f2b1c0a4d', '2026-07-01')?.label === 'copilot-agents',
  'key_alias becomes the row label',
);
check(
  find(snapshot.breakdowns, 'api_key', 'aa11bb22cc', '2026-07-01')?.label === null,
  'a bucket with no known alias field gets a null label',
);
check(
  find(snapshot.breakdowns, 'user', 'u-101', '2026-07-01')?.label === 'ada@corp',
  'user_email becomes the user-dimension label',
);
check(
  find(snapshot.breakdowns, 'team', 'team-platform', '2026-07-01')?.label === 'Platform',
  'team_alias becomes the team-dimension label',
);
check(
  !snapshot.breakdowns.some((row) => row.key === ''),
  'empty-string breakdown keys are dropped',
);
check(
  [...dims].sort().join(',') === 'api_key,mcp_server,model,provider,team,user',
  `six dimensions filled, tag absent (got ${[...dims].sort().join(',')})`,
);

// The load-bearing one: the team endpoint reports the same money re-sliced.
const modelSpend = snapshot.breakdowns
  .filter((row) => row.dimension === 'model')
  .reduce((sum, row) => sum + row.spendNano, 0n);
const totalSpend = snapshot.daily.reduce((sum, row) => sum + row.spendNano, 0n);
check(totalSpend === 13_000_000_000n, 'team metrics never enter the gateway-wide totals');
check(
  modelSpend === 12_900_010_950n,
  `the team endpoint's own models breakdown is ignored (got ${modelSpend})`,
);

check(
  JSON.stringify(snapshot.dates) === JSON.stringify(eachDay(FROM, TO)),
  'dates cover the whole requested window, including days the proxy never reported',
);

// =====================================================================
// 2 · The request the client actually makes
// =====================================================================

console.log('\n2 · request shape — auth, params, endpoint order, page stop');

const calls = await withProxy(
  (captured) => {
    if (captured.path === '/user/daily/activity') {
      return { status: 200, body: envelope([{ date: '2026-07-01', metrics: metrics() }]) };
    }
    return { status: 404, body: {} };
  },
  async (proxy) => {
    await client(proxy.baseUrl).fetchUsage(FROM, TO);
    return proxy.calls;
  },
);

check(
  calls.map((call) => call.path).join(' ') ===
    '/user/daily/activity /team/daily/activity /tag/daily/activity',
  'user first (it owns the totals), then the two optional entity endpoints',
);
check(
  calls.every((call) => call.authorization === 'Bearer sk-test-key'),
  'every request carries the virtual key as a bearer token',
);
check(
  calls.every((call) => call.accept === 'application/json'),
  'every request asks for JSON',
);
const first = calls[0]?.query;
check(
  first?.get('start_date') === FROM &&
    first?.get('end_date') === TO &&
    first?.get('page') === '1' &&
    first?.get('page_size') === '100',
  'start_date / end_date / page / page_size are sent as documented',
);
check(
  calls.filter((call) => call.path === '/user/daily/activity').length === 1,
  'paging stops on has_more=false — one page fetched, not fifty',
);

// A proxy that leaves has_more true forever must still terminate.
const runawayCalls = await withProxy(
  (captured) => {
    if (captured.path !== '/user/daily/activity') return { status: 404, body: {} };
    return {
      status: 200,
      // has_more true, total_pages 1 — contradictory, as some proxies are.
      body: envelope([{ date: '2026-07-01', metrics: metrics() }], {
        has_more: true,
        total_pages: 1,
      }),
    };
  },
  async (proxy) => {
    await client(proxy.baseUrl).fetchUsage(FROM, TO);
    return proxy.calls.filter((call) => call.path === '/user/daily/activity').length;
  },
);
check(runawayCalls === 1, `a stuck has_more stops at the reported page count (${runawayCalls})`);

const emptyPageCalls = await withProxy(
  (captured) => {
    if (captured.path !== '/user/daily/activity') return { status: 404, body: {} };
    return { status: 200, body: envelope([], { has_more: true, total_pages: 99 }) };
  },
  async (proxy) => {
    await client(proxy.baseUrl).fetchUsage(FROM, TO);
    return proxy.calls.filter((call) => call.path === '/user/daily/activity').length;
  },
);
check(emptyPageCalls === 1, `an empty page ends paging even with 99 promised (${emptyPageCalls})`);

// =====================================================================
// 3 · Degraded proxies
// =====================================================================

console.log('\n3 · failure handling — absent optional routes, hard errors, retries');

for (const status of [401, 403, 404, 405, 501]) {
  const { result, attempts } = await withProxy(
    (captured) => {
      if (captured.path === '/user/daily/activity') {
        return { status: 200, body: envelope([{ date: '2026-07-01', metrics: metrics() }]) };
      }
      return { status, body: { detail: 'nope' } };
    },
    async (proxy) => {
      const outcome: GatewaySnapshot | Error = await client(proxy.baseUrl)
        .fetchUsage(FROM, TO)
        .catch((error: unknown) => error as Error);
      return {
        result: outcome,
        attempts: proxy.calls.filter((call) => call.path === '/team/daily/activity').length,
      };
    },
  );
  check(
    !(result instanceof Error) && result.daily.length === 1,
    `optional endpoints answering ${status} are skipped, not fatal`,
  );
  // 501 is both "absent" and a 5xx. Retrying it would burn the backoff and then
  // throw "unreachable" instead of skipping the dimension.
  check(attempts === 1, `${status} is answered once, not retried (${attempts} attempts)`);
}

// A genuinely transient 5xx still gets the backoff.
const transient = await withProxy(
  (captured, index) => {
    if (captured.path !== '/user/daily/activity') return { status: 404, body: {} };
    if (index === 0) return { status: 503, body: { detail: 'restarting' } };
    return { status: 200, body: envelope([{ date: '2026-07-01', metrics: metrics({ spend: 2 }) }]) };
  },
  async (proxy) => {
    const usage = await client(proxy.baseUrl).fetchUsage(FROM, TO);
    return {
      spendNano: usage.daily[0]?.spendNano,
      attempts: proxy.calls.filter((call) => call.path === '/user/daily/activity').length,
    };
  },
);
check(
  transient.attempts === 2 && transient.spendNano === 2_000_000_000n,
  `503 is still retried (${transient.attempts} attempts)`,
);

const requiredFailure = await withProxy(
  () => ({ status: 404, body: { detail: 'no such route' } }),
  async (proxy): Promise<unknown> =>
    client(proxy.baseUrl)
      .fetchUsage(FROM, TO)
      .then(() => null)
      .catch((error: unknown) => error),
);
check(
  requiredFailure instanceof Error &&
    requiredFailure.message.includes('/user/daily/activity responded 404'),
  'a missing *required* endpoint fails the sync with the status and body',
);

const badShape = await withProxy(
  (captured) => {
    if (captured.path !== '/user/daily/activity') return { status: 404, body: {} };
    return { status: 200, body: { results: [{ date: '2026-07-01', metrics: 'not-an-object' }] } };
  },
  async (proxy): Promise<unknown> =>
    client(proxy.baseUrl)
      .fetchUsage(FROM, TO)
      .then(() => null)
      .catch((error: unknown) => error),
);
check(
  badShape instanceof Error && badShape.message.includes('unexpected shape'),
  'a response that is not SpendAnalyticsPaginatedResponse fails loudly, not silently empty',
);

// 429 then 200 — the proxy's own rate limit must not fail a nightly sync.
const retried = await withProxy(
  (captured, index) => {
    if (captured.path !== '/user/daily/activity') return { status: 404, body: {} };
    if (index === 0) return { status: 429, body: { detail: 'rate limited' } };
    return {
      status: 200,
      body: envelope([{ date: '2026-07-01', metrics: metrics({ spend: 1 }) }]),
    };
  },
  async (proxy) => {
    const result = await client(proxy.baseUrl).fetchUsage(FROM, TO);
    return { result, attempts: proxy.calls.filter((c) => c.path.startsWith('/user')).length };
  },
);
check(
  retried.attempts === 2 && retried.result.daily[0]?.spendNano === 1_000_000_000n,
  `429 is retried and the retry's data is kept (${retried.attempts} attempts)`,
);

// =====================================================================
// 4 · A sparse proxy — the shape a quiet day actually arrives in
// =====================================================================
//
// LiteLLM omits counters and whole breakdown groups it has no rows for. Nothing
// there is nullable: absent means none happened.

console.log('\n4 · sparse responses — omitted counters and breakdown groups');

const sparse = await withProxy(
  (captured) => {
    if (captured.path !== '/user/daily/activity') return { status: 404, body: {} };
    return {
      status: 200,
      body: envelope([
        // No breakdown at all, and metrics carrying only what happened.
        { date: '2026-07-03', metrics: { spend: 0.25, api_requests: 3 } },
        // A breakdown with only one group present.
        {
          date: '2026-07-04',
          metrics: { spend: 0.75, api_requests: 9 },
          breakdown: { providers: { bedrock: { metrics: { spend: 0.75 } } } },
        },
      ]),
    };
  },
  (proxy) => client(proxy.baseUrl).fetchUsage(FROM, TO),
);

const sparseDay = sparse.daily.find((row) => row.date === '2026-07-03');
check(
  sparseDay?.spendNano === 250_000_000n && sparseDay?.totalTokens === 0,
  'omitted counters default to zero, not to a parse failure',
);
check(
  sparse.breakdowns.length === 1 && sparse.breakdowns[0]?.dimension === 'provider',
  'an absent breakdown group yields no rows rather than throwing',
);
check(
  sparse.breakdowns[0]?.requests === 0 && sparse.breakdowns[0]?.spendNano === 750_000_000n,
  'a bucket with no metadata and partial metrics still stores its spend',
);

// =====================================================================
// 5 · eachDay, which decides what the sync deletes
// =====================================================================

console.log('\n5 · eachDay — the window the sync replaces');

check(eachDay('2026-07-01', '2026-07-01').length === 1, 'a single-day window is one day');
check(eachDay('2026-02-27', '2026-03-02').join(',') === '2026-02-27,2026-02-28,2026-03-01,2026-03-02', 'month and non-leap February boundaries walk correctly');
check(eachDay('2024-02-27', '2024-03-01').length === 4, 'a leap-year February has its 29th');
check(eachDay('2026-07-05', '2026-07-01').length === 0, 'an inverted range yields nothing');
check(eachDay('2026-05-01', '2026-07-29').length === 90, 'a 90-day retention window is 90 days');

// =====================================================================
// 6 · The management side — /key/list and /team/list
// =====================================================================
//
// Budgets come from different routes with a different envelope: /key/list
// paginates on `size`/`total_pages` and may answer with bare token strings,
// /team/list answers a naked array. The rule this section exists to pin is that
// every limit is null-or-a-number and nothing is zero-filled — "uncapped" and
// "capped at nothing" are opposite states of the same field.

console.log('\n6 · budgets — /key/list and /team/list');

const keyRow = (over: Record<string, unknown>) => ({
  token: 'tok-1',
  key_alias: 'alias-1',
  spend: 1.5,
  max_budget: 100,
  budget_duration: '1mo',
  budget_reset_at: '2026-08-01T00:00:00.594000Z',
  ...over,
});

const budgets = await withProxy(
  (captured) => {
    if (captured.path === '/key/list') {
      const page = captured.query.get('page');
      if (page === '1') {
        return {
          status: 200,
          body: {
            keys: [
              keyRow({
                token: 'hash-copilot',
                key_alias: '  copilot-agents  ',
                spend: 1_234.567891234,
                // Uncapped: null must survive as null all the way to the row.
                max_budget: null,
                soft_budget: null,
                budget_duration: null,
                budget_reset_at: null,
                tpm_limit: 2_000_000,
                rpm_limit: 12_000,
              }),
              keyRow({
                token: 'hash-blocked',
                key_alias: '',
                spend: 1.095e-5,
                // Budgeted at nothing — 0 is a hard stop, not "no budget".
                max_budget: 0,
                soft_budget: 0,
                rpm_limit: 0,
                blocked: true,
                budget_reset_at: 'not a date',
              }),
              // A proxy that ignored return_full_object: no budget to read.
              'sk-bare-string-key',
              // Full object, no token: nothing to join to the api_key dimension.
              keyRow({ token: null, key_alias: 'orphan' }),
            ],
            total_pages: 2,
            current_page: 1,
          },
        };
      }
      return {
        status: 200,
        body: {
          keys: [
            keyRow({ token: 'hash-support', key_alias: 'support', spend: 900, max_budget: 2_400 }),
            // Same token again — one row must win, not two colliding on the PK.
            keyRow({ token: 'hash-support', key_alias: 'support-duplicate', spend: 99 }),
          ],
          total_pages: 2,
          current_page: 2,
        },
      };
    }

    if (captured.path === '/team/list') {
      return {
        status: 200,
        body: [
          {
            team_id: 'team-platform',
            team_alias: 'Platform Engineering',
            spend: 3_100.25,
            max_budget: 4_000,
            budget_duration: '1mo',
            budget_reset_at: '2026-08-01T00:00:00Z',
            blocked: false,
          },
          // No id — nothing to key a row on.
          { team_id: '', team_alias: 'ghost', spend: 5 },
        ],
      };
    }

    return { status: 404, body: {} };
  },
  async (proxy) => {
    const rows = await client(proxy.baseUrl).fetchBudgets();
    return { rows, calls: proxy.calls };
  },
);

const keyCall = budgets.calls.find((call) => call.path === '/key/list');
check(
  keyCall?.query.get('return_full_object') === 'true' && keyCall?.query.get('size') === '100',
  '/key/list is asked for full objects, 100 to a page',
);
check(
  keyCall?.authorization === 'Bearer sk-test-key',
  'the management routes carry the same bearer auth as the analytics ones',
);
check(
  budgets.calls.filter((call) => call.path === '/key/list').length === 2,
  'pagination follows total_pages on /key/list',
);

const budgetOf = (scope: string, key: string) =>
  budgets.rows.find((row) => row.scope === scope && row.key === key);

check(budgets.rows.length === 4, `bare strings and tokenless rows are dropped (${budgets.rows.length} rows)`);

const copilot = budgetOf('api_key', 'hash-copilot');
check(
  copilot?.maxBudgetNano === null && copilot?.softBudgetNano === null,
  'an uncapped key keeps null limits — never zero, which would read as the strictest budget',
);
check(copilot?.spendNano === 1_234_567_891_234n, 'nine-decimal spend lands exactly in nano');
check(copilot?.label === 'copilot-agents', 'key_alias is trimmed');
check(
  copilot?.tpmLimit === 2_000_000 && copilot?.rpmLimit === 12_000,
  'rate limits survive as numbers',
);
check(copilot?.resetAt === null && copilot?.budgetDuration === null, 'a never-resetting budget carries no reset');

const blocked = budgetOf('api_key', 'hash-blocked');
check(
  blocked?.maxBudgetNano === 0n && blocked?.rpmLimit === 0,
  'a zero cap stays zero — the opposite state from an absent one',
);
check(blocked?.blocked === true, 'blocked is carried, not derived from the budget');
check(blocked?.label === null, 'an empty alias is null, not an empty string');
check(blocked?.spendNano === 10_950n, 'exponent-notation spend parses on the management side too');
check(blocked?.resetAt === null, 'an unparseable reset timestamp is null, not an Invalid Date');

const support = budgetOf('api_key', 'hash-support');
check(
  budgets.rows.filter((row) => row.key === 'hash-support').length === 1 &&
    support?.label === 'support',
  'a token repeated across pages yields one row, first seen winning',
);

const platform = budgetOf('team', 'team-platform');
check(
  platform?.maxBudgetNano === 4_000_000_000_000n && platform?.label === 'Platform Engineering',
  '/team/list is read from a bare array, no pagination envelope',
);
check(
  platform?.resetAt?.toISOString() === '2026-08-01T00:00:00.000Z',
  'a reset timestamp parses to the instant it names',
);
check(
  budgets.rows.every((row) => row.key !== ''),
  'a team with no id is dropped rather than colliding on the primary key',
);
check(
  budgets.rows.every((row) => row.blocked === false || row.key === 'hash-blocked'),
  'blocked defaults to false when the proxy omits it',
);

// An analytics-only credential: management is refused, usage must not care.
const refused = await withProxy(
  (captured) => (captured.path === '/team/list' ? { status: 200, body: [] } : { status: 403, body: {} }),
  (proxy) => client(proxy.baseUrl).fetchBudgets(),
);
check(refused.length === 0, 'a refused /key/list yields no budgets rather than failing the sync');

const teamOnly = await withProxy(
  (captured) =>
    captured.path === '/team/list'
      ? { status: 200, body: [{ team_id: 't1', max_budget: 10 }] }
      : { status: 404, body: {} },
  (proxy) => client(proxy.baseUrl).fetchBudgets(),
);
check(
  teamOnly.length === 1 && teamOnly[0]?.scope === 'team',
  'an absent /key/list does not stop /team/list from answering',
);

const malformed = await withProxy(
  (captured) =>
    captured.path === '/key/list'
      ? { status: 200, body: { keys: [{ token: 'x', max_budget: 'lots' }] } }
      : { status: 404, body: {} },
  (proxy) =>
    client(proxy.baseUrl)
      .fetchBudgets()
      .then(() => 'resolved')
      .catch((error: unknown) => String(error)),
);
check(
  malformed.includes('unexpected shape'),
  'a budget field of the wrong type throws rather than syncing a silently wrong cap',
);

// =====================================================================
// 6b · The third management envelope — /tag/list
// =====================================================================
//
// Tags differ from keys and teams in three ways this section exists to pin:
//
//   1. a bare array with no pagination of any kind,
//   2. the limits one level down, on the joined `litellm_budget_table`, where a
//      key row spells them at the top level, and
//   3. a response that mixes configured tags with tags the proxy merely saw in
//      spend data — the second kind is usage, not governance.

console.log('\n6b · budgets — /tag/list');

const tags = await withProxy(
  (captured) => {
    if (captured.path === '/tag/list') {
      return {
        status: 200,
        body: [
          {
            name: '  coding-assistant  ',
            description: 'Agentic coding traffic',
            spend: 8_142.5,
            budget_id: 'budget-1',
            litellm_budget_table: {
              budget_id: 'budget-1',
              max_budget: 12_000,
              soft_budget: 9_600,
              budget_duration: '1mo',
              budget_reset_at: '2026-08-01T00:00:00.594000Z',
              tpm_limit: null,
              rpm_limit: 4_000,
            },
          },
          // Configured, capped at nothing: 0 is a block, exactly as on a key.
          {
            name: 'frozen',
            spend: 0,
            budget_id: 'budget-2',
            litellm_budget_table: { budget_id: 'budget-2', max_budget: 0, rpm_limit: 0 },
          },
          // Created but never capped. Governed (it is in the tag table) and
          // uncapped (nobody set a limit) — the two are different facts.
          { name: 'chat', description: 'Ad-hoc chat', spend: 412.75 },
          // Linked to a budget the endpoint did not include: everything the
          // payload does not carry stays null rather than being invented.
          { name: 'linked-only', spend: 10, budget_id: 'budget-3' },
          // Dynamic: seen in spend data, never created. No spend column, no
          // budget link — a usage row wearing a governance row's shape.
          {
            name: 'ad-hoc-experiment',
            description: 'This is a spend tag that was passed dynamically',
            models: null,
            created_at: '2026-06-01T00:00:00Z',
            updated_at: '2026-07-30T00:00:00Z',
          },
          { name: '', spend: 1 },
        ],
      };
    }
    return { status: 404, body: {} };
  },
  async (proxy) => {
    const rows = await client(proxy.baseUrl).fetchBudgets();
    return { rows, calls: proxy.calls };
  },
);

check(
  tags.calls.filter((call) => call.path === '/tag/list').length === 1,
  '/tag/list is asked once — it carries no pagination to follow',
);
check(
  tags.rows.every((row) => row.scope === 'tag'),
  'an absent /key/list and /team/list leave the tag rows answering alone',
);
check(
  tags.rows.length === 4,
  `dynamic and nameless rows are dropped, configured ones kept (${tags.rows.length} rows)`,
);

const tagOf = (key: string) => tags.rows.find((row) => row.key === key);

check(
  tags.rows.every((row) => row.key !== 'ad-hoc-experiment'),
  'a tag seen only in spend data is usage, not a governance object — it must not dilute the coverage denominator',
);
const coding = tagOf('coding-assistant');
check(coding !== undefined, 'the tag name is trimmed and used as the id');
check(
  coding?.maxBudgetNano === 12_000_000_000_000n && coding?.softBudgetNano === 9_600_000_000_000n,
  'caps are read from the joined litellm_budget_table, not from the tag row',
);
check(
  coding?.budgetDuration === '1mo' && coding?.resetAt?.toISOString() === '2026-08-01T00:00:00.594Z',
  'the duration and reset instant come from the nested budget too',
);
check(
  coding?.rpmLimit === 4_000 && coding?.tpmLimit === null,
  'a nested rate limit survives and its absent twin stays null',
);
check(coding?.spendNano === 8_142_500_000_000n, "the tag's own spend column is the counter, not the budget's");
check(
  coding?.label === null,
  'a tag has no alias — its name is its id, so echoing it as a label would print it twice',
);

const frozen = tagOf('frozen');
check(
  frozen?.maxBudgetNano === 0n && frozen?.rpmLimit === 0,
  'a tag capped at zero keeps 0 — blocked, which is the opposite of the uncapped tag next to it',
);
const chat = tagOf('chat');
check(
  chat?.maxBudgetNano === null && chat?.budgetDuration === null && chat?.resetAt === null,
  'a configured tag with no budget row is uncapped, with every limit null',
);
check(
  tagOf('linked-only')?.maxBudgetNano === null,
  'a budget_id the endpoint did not expand yields null limits rather than an invented cap',
);

const tagAbsent = await withProxy(
  (captured) =>
    captured.path === '/tag/list' || captured.path === '/user/list'
      ? { status: 404, body: {} }
      : captured.path === '/key/list'
        ? { status: 200, body: { keys: [keyRow({ token: 'k' })], total_pages: 1 } }
        : { status: 200, body: [] },
  (proxy) => client(proxy.baseUrl).fetchBudgets(),
);
check(
  tagAbsent.length === 1 && tagAbsent[0]?.scope === 'api_key',
  'an older proxy without tag management does not cost the key budgets — /tag/list is independently optional',
);

const tagMalformed = await withProxy(
  (captured) =>
    captured.path === '/tag/list'
      ? { status: 200, body: [{ name: 't', litellm_budget_table: { max_budget: 'lots' } }] }
      : { status: 404, body: {} },
  (proxy) =>
    client(proxy.baseUrl)
      .fetchBudgets()
      .then(() => 'resolved')
      .catch((error: unknown) => String(error)),
);
check(
  tagMalformed.includes('unexpected shape'),
  'a nested cap of the wrong type throws rather than syncing a silently wrong tag budget',
);

// The one rule the scope carries that the other two do not.
check(
  budgetCounterResets('api_key') && budgetCounterResets('team') && !budgetCounterResets('tag'),
  "the tag counter is the only one LiteLLM's reset job leaves climbing (BerriAI/litellm#27481)",
);

// =====================================================================
// 6c · The fourth governance route — /user/list
// =====================================================================
//
// Users are the scope this integration deliberately does not store all of, and
// three things about the route make that both necessary and easy to get wrong:
//
//   1. it pages on `page_size`, not on `size` — sending the wrong parameter is
//      accepted and ignored, which silently pins the read to 25 users;
//   2. the roster is the staff directory, so only rows carrying a limit are
//      governance and the rest are already on the page as usage; and
//   3. the limits may be inline or on a joined budget row, tag-style, and the
//      inline one is what the proxy enforces against this user.

console.log('\n6c · budgets — /user/list');

const users = await withProxy(
  (captured) => {
    if (captured.path === '/user/list') {
      const page = Number(captured.query.get('page') ?? '1');
      if (page === 1) {
        return {
          status: 200,
          body: {
            users: [
              // Capped inline, the ordinary shape.
              {
                user_id: 'sso|ana',
                user_email: '  ana.kovacs@corp.example  ',
                user_role: 'internal_user',
                spend: 312.4,
                max_budget: 400,
                soft_budget: 320,
                budget_duration: '1mo',
                budget_reset_at: '2026-08-01T00:00:00.594000Z',
                tpm_limit: null,
                rpm_limit: 600,
              },
              // Governed by a *shared* budget row: nothing inline, everything on
              // the join, exactly as a tag carries it.
              {
                user_id: 'sso|owen',
                user_email: 'owen.tanaka@corp.example',
                spend: 41,
                budget_id: 'budget-contractors',
                litellm_budget_table: {
                  budget_id: 'budget-contractors',
                  max_budget: 120,
                  budget_duration: '7d',
                  rpm_limit: 100,
                },
              },
              // Both, disagreeing: the inline cap is the enforced one.
              {
                user_id: 'sso|both',
                user_email: 'both@corp.example',
                spend: 5,
                max_budget: 50,
                budget_id: 'budget-contractors',
                litellm_budget_table: { budget_id: 'budget-contractors', max_budget: 120 },
              },
              // Rate-limited and uncapped — governed without a budget.
              { user_id: 'sso|kofi', user_email: 'kofi.weber@corp.example', spend: 88, rpm_limit: 60 },
              // Budgeted at exactly nothing: a block, not an absence.
              { user_id: 'sso|hugo', user_email: 'hugo.laurent@corp.example', spend: 0, max_budget: 0 },
              // The directory: a person, not a decision. Dropped.
              { user_id: 'sso|nina', user_email: 'nina.larsen@corp.example', spend: 240.1 },
              // Governed but unjoinable — a cap with no id to put it beside.
              { user_id: '   ', user_email: 'orphan@corp.example', max_budget: 10 },
            ],
            total: 9,
            page: 1,
            page_size: 100,
            total_pages: 2,
          },
        };
      }
      return {
        status: 200,
        body: {
          users: [
            {
              user_id: 'sso|etl',
              user_alias: 'ETL service account',
              spend: 954.25,
              max_budget: 900,
              budget_duration: '1mo',
            },
            { user_id: 'sso|quiet', user_email: 'quiet@corp.example' },
          ],
          total: 9,
          page: 2,
          page_size: 100,
          total_pages: 2,
        },
      };
    }
    return { status: 404, body: {} };
  },
  async (proxy) => {
    const rows = await client(proxy.baseUrl).fetchBudgets();
    return { rows, calls: proxy.calls };
  },
);

const userCalls = users.calls.filter((call) => call.path === '/user/list');
check(userCalls.length === 2, `/user/list is followed to its last page (${userCalls.length} pages)`);
check(
  userCalls[0]?.query.get('page_size') === '100' && userCalls[0]?.query.get('size') === null,
  '/user/list is paged on page_size — `size` is the key route’s parameter and is ignored here',
);
check(
  userCalls[0]?.query.get('page') === '1' && userCalls[1]?.query.get('page') === '2',
  'pages are walked in order off total_pages',
);
check(
  users.rows.every((row) => row.scope === 'user'),
  'an absent /key/list, /team/list and /tag/list leave the user rows answering alone',
);
check(
  users.rows.length === 6,
  `only governed, identified users are stored (${users.rows.length} of 9 answered)`,
);

const userOf = (key: string) => users.rows.find((row) => row.key === key);

check(
  users.rows.every((row) => row.key !== 'sso|nina' && row.key !== 'sso|quiet'),
  'a user carrying no limit at all is a person, not a governance object — storing them would put the directory in gateway_budget',
);
check(
  users.rows.every((row) => row.label !== 'orphan@corp.example'),
  'a capped user with no user_id cannot be joined to the usage dimension and is dropped, exactly as a key with no token is',
);

const ana = userOf('sso|ana');
check(
  ana?.maxBudgetNano === 400_000_000_000n && ana?.softBudgetNano === 320_000_000_000n,
  'inline caps are read from the user row',
);
check(
  ana?.label === 'ana.kovacs@corp.example',
  'user_email is the label, trimmed — a user_id is frequently an SSO subject nobody recognises',
);
check(
  ana?.spendNano === 312_400_000_000n && ana?.rpmLimit === 600 && ana?.tpmLimit === null,
  "the user's own counter and rate limits survive, and the absent one stays null",
);
check(
  ana?.budgetDuration === '1mo' && ana?.resetAt?.toISOString() === '2026-08-01T00:00:00.594Z',
  'the duration and reset instant are read the same way a key carries them',
);

const owen = userOf('sso|owen');
check(
  owen?.maxBudgetNano === 120_000_000_000n && owen?.budgetDuration === '7d' && owen?.rpmLimit === 100,
  'a user attached to a shared budget row gets its caps from the join, tag-style',
);
check(
  userOf('sso|both')?.maxBudgetNano === 50_000_000_000n,
  'where a user carries both, the inline cap wins — it is the one the proxy enforces against this user',
);
check(
  userOf('sso|kofi')?.maxBudgetNano === null && userOf('sso|kofi')?.rpmLimit === 60,
  'a rate-limited user with no budget is governed and uncapped — two different facts',
);
check(
  userOf('sso|hugo')?.maxBudgetNano === 0n,
  'a user budgeted at zero keeps 0: blocked, the opposite of the uncapped row next to it',
);
check(
  userOf('sso|etl')?.label === 'ETL service account',
  'user_alias is the fallback label when a service identity carries no email',
);

const userAbsent = await withProxy(
  (captured) =>
    captured.path === '/user/list'
      ? { status: 403, body: { detail: 'Only proxy admins may list users' } }
      : captured.path === '/key/list'
        ? { status: 200, body: { keys: [keyRow({ token: 'k' })], total_pages: 1 } }
        : { status: 200, body: [] },
  (proxy) => client(proxy.baseUrl).fetchBudgets(),
);
check(
  userAbsent.length === 1 && userAbsent[0]?.scope === 'api_key',
  'a credential refused user management still syncs key budgets — /user/list is independently optional',
);

const userMalformed = await withProxy(
  (captured) =>
    captured.path === '/user/list'
      ? { status: 200, body: { users: [{ user_id: 'u', max_budget: 'plenty' }] } }
      : { status: 404, body: {} },
  (proxy) =>
    client(proxy.baseUrl)
      .fetchBudgets()
      .then(() => 'resolved')
      .catch((error: unknown) => String(error)),
);
check(
  userMalformed.includes('unexpected shape'),
  'a cap of the wrong type throws rather than syncing a silently wrong user budget',
);

check(
  budgetCounterResets('user'),
  "the user counter is reset by the proxy — ResetBudgetJob walks LiteLLM_UserTable, so a pace projection over it means what it says",
);

// =====================================================================
// 6d · The model catalogue — GET /model/info
// =====================================================================
//
// A fourth envelope: `{"data": [...]}`, one entry per *deployment*, three
// nested objects each. What this section pins is everything that would be a
// silent wrong number rather than a crash — the per-token → per-million scale,
// the null-vs-zero rule inherited from budgets, and the collapse of several
// deployments onto one public alias, which is forced (the daily aggregates
// carry no deployment id) and therefore has to report a floor.

console.log('\n6d · the model catalogue — /model/info');

const deployment = (over: Record<string, unknown> = {}) => ({
  model_name: 'gpt-4o',
  litellm_params: { model: 'azure/gpt-4o-eastus', api_key: 'sk-should-never-reach-us' },
  model_info: {
    id: 'abc123',
    mode: 'chat',
    litellm_provider: 'azure',
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-6,
    cache_creation_input_token_cost: 3.125e-6,
    max_input_tokens: 128_000,
    max_output_tokens: 16_384,
  },
  ...over,
});

const catalogue = await withProxy(
  (captured) =>
    captured.path === '/model/info'
      ? {
          status: 200,
          body: {
            data: [
              deployment(),
              // Second deployment of the same alias, cheaper — reserved capacity
              // bought at a discount, with a smaller context window.
              deployment({
                litellm_params: { model: 'azure/gpt-4o-swedencentral' },
                model_info: {
                  mode: 'chat',
                  litellm_provider: 'azure',
                  input_cost_per_token: 1.75e-6,
                  output_cost_per_token: 7e-6,
                  max_input_tokens: 64_000,
                  max_output_tokens: 16_384,
                },
              }),
              // A model billed per second (Bedrock provisioned throughput): no
              // per-token price exists at all.
              deployment({
                model_name: 'claude-reserved',
                litellm_params: { model: 'bedrock/1-month-commitment/anthropic.claude-v2' },
                model_info: {
                  mode: 'chat',
                  litellm_provider: 'bedrock',
                  input_cost_per_second: 0.0455,
                  max_input_tokens: 100_000,
                },
              }),
              // Deliberately free — LiteLLM skips budget checks for these, so 0
              // is a configuration choice and must not read as "unknown".
              deployment({
                model_name: 'on-prem-llama',
                litellm_params: { model: 'ollama/llama3' },
                model_info: {
                  mode: 'chat',
                  input_cost_per_token: 0,
                  output_cost_per_token: 0,
                },
              }),
              // Exponent notation on a very cheap model, the same wire hazard
              // the activity routes carry.
              deployment({
                model_name: 'embed-small',
                litellm_params: { model: 'azure/text-embedding-3-small' },
                model_info: { mode: 'embedding', input_cost_per_token: 2e-8 },
              }),
              // Routing rules, not models: they price nothing and no usage key
              // can ever equal them.
              deployment({ model_name: '*', litellm_params: { model: 'azure/*' } }),
              deployment({ model_name: 'azure/*', litellm_params: { model: 'azure/*' } }),
            ],
          },
        }
      : { status: 404, body: {} },
  async (proxy) => ({ models: await client(proxy.baseUrl).fetchModels(), calls: proxy.calls }),
);

const modelOf = (name: string) => catalogue.models.find((entry) => entry.model === name);

check(
  catalogue.calls.length === 1 && catalogue.calls[0]?.path === '/model/info',
  'the catalogue is one unpaginated request — /model/info answers every deployment at once',
);
check(catalogue.models.length === 4, `seven deployments collapse to four models (${catalogue.models.length})`);
check(
  modelOf('*') === undefined && modelOf('azure/*') === undefined,
  'a wildcard row is a routing rule, not a model, and never enters the catalogue',
);
check(
  modelOf('gpt-4o')?.deployments === 2,
  'two deployments behind one public alias are one row, because the daily aggregates cannot split them',
);
check(
  modelOf('gpt-4o')?.inputPerMillionNano === 1_750_000_000n,
  'a per-token price becomes nano-dollars per million, and the collapsed row reports the cheapest deployment',
);
check(
  modelOf('gpt-4o')?.priceVaries === true,
  'a row whose deployments disagree on price says so — the number it carries is a floor',
);
check(
  modelOf('gpt-4o')?.maxInputTokens === 64_000,
  'the context window collapses to the smallest, which is the one every deployment behind the alias honours',
);
check(
  modelOf('gpt-4o')?.backend === 'azure/gpt-4o-eastus' &&
    modelOf('gpt-4o')?.model === 'gpt-4o',
  'the public alias and the backend routing string are both kept — they are different strings and a join has to try both',
);
check(
  modelOf('gpt-4o')?.cacheReadPerMillionNano === 1_250_000_000n &&
    modelOf('gpt-4o')?.cacheWritePerMillionNano === 3_125_000_000n,
  'the two cache prices survive — they are the only per-token rates the daily aggregate can never imply',
);
check(
  modelOf('claude-reserved')?.inputPerMillionNano === null &&
    modelOf('claude-reserved')?.outputPerMillionNano === null,
  'a model billed per second carries no per-token price, and is null rather than free',
);
check(
  modelOf('claude-reserved')?.priceVaries === false,
  'one deployment cannot disagree with itself, however little the proxy knows about it',
);
check(
  modelOf('on-prem-llama')?.inputPerMillionNano === 0n,
  'an explicit zero is a free model, which is the opposite state from an absent price',
);
check(
  modelOf('embed-small')?.inputPerMillionNano === 20_000_000n,
  'exponent notation survives the scale change (2e-8/token is $0.02/M)',
);
check(
  modelOf('embed-small')?.mode === 'embedding',
  'modality is carried, so a catalogue reader can tell a chat rate from an embedding one',
);
check(
  modelOf('gpt-4o')?.provider === 'azure' && modelOf('claude-reserved')?.provider === 'bedrock',
  'the provider is the same key the `provider` usage dimension carries',
);

// A deployment whose provider LiteLLM did not name — the prefix of the routing
// string is what the proxy itself falls back to.
const inferred = await withProxy(
  (captured) =>
    captured.path === '/model/info'
      ? {
          status: 200,
          body: {
            data: [
              {
                model_name: 'nova',
                litellm_params: { model: 'bedrock/amazon.nova-pro-v1:0' },
                model_info: { input_cost_per_token: 8e-7 },
              },
            ],
          },
        }
      : { status: 404, body: {} },
  (proxy) => client(proxy.baseUrl).fetchModels(),
);
check(
  inferred[0]?.provider === 'bedrock',
  'an unnamed provider is read off the routing string, exactly as LiteLLM does',
);

// A disagreement is not only about numbers: a priced deployment beside an
// unpriced one is the case where a single rate misleads most.
const mixed = await withProxy(
  (captured) =>
    captured.path === '/model/info'
      ? {
          status: 200,
          body: {
            data: [
              { model_name: 'shared', litellm_params: { model: 'azure/a' }, model_info: { input_cost_per_token: 1e-6 } },
              { model_name: 'shared', litellm_params: { model: 'azure/b' }, model_info: {} },
            ],
          },
        }
      : { status: 404, body: {} },
  (proxy) => client(proxy.baseUrl).fetchModels(),
);
check(
  mixed[0]?.priceVaries === true && mixed[0]?.inputPerMillionNano === 1_000_000_000n,
  'a priced deployment beside an unpriced one is a disagreement, not a price',
);

const catalogueAbsent = await withProxy(
  (captured) => (captured.path === '/model/info' ? { status: 404, body: {} } : { status: 200, body: [] }),
  (proxy) => client(proxy.baseUrl).fetchModels(),
);
check(
  catalogueAbsent.length === 0,
  'an older proxy without /model/info answers an empty catalogue rather than failing a usage sync',
);

const catalogueDenied = await withProxy(
  (captured) => (captured.path === '/model/info' ? { status: 403, body: {} } : { status: 200, body: [] }),
  (proxy) => client(proxy.baseUrl).fetchModels(),
);
check(
  catalogueDenied.length === 0,
  'an analytics-only credential refused /model/info loses the catalogue and nothing else',
);

const catalogueMalformed = await withProxy(
  (captured) =>
    captured.path === '/model/info'
      ? { status: 200, body: { data: [{ model_name: 'x', model_info: { input_cost_per_token: 'free' } }] } }
      : { status: 404, body: {} },
  (proxy) =>
    client(proxy.baseUrl)
      .fetchModels()
      .then(() => 'resolved')
      .catch((error: unknown) => String(error)),
);
check(
  typeof catalogueMalformed === 'string' && catalogueMalformed.includes('unexpected shape'),
  'a price of the wrong type throws rather than storing a catalogue with a hole in it',
);

// The pure join, which is the whole point of storing the alias and the backend.
const priceList: GatewayModelPrice[] = catalogue.models.map((entry) => ({
  model: entry.model,
  backend: entry.backend,
  provider: entry.provider,
  mode: entry.mode,
  inputPerMillion: entry.inputPerMillionNano === null ? null : Number(entry.inputPerMillionNano) / 1e9,
  outputPerMillion: entry.outputPerMillionNano === null ? null : Number(entry.outputPerMillionNano) / 1e9,
  cacheReadPerMillion: null,
  cacheWritePerMillion: null,
  maxInputTokens: entry.maxInputTokens,
  maxOutputTokens: entry.maxOutputTokens,
  deployments: entry.deployments,
  priceVaries: entry.priceVaries,
}));

check(
  resolveModelPrice(priceList, 'gpt-4o')?.model === 'gpt-4o',
  'a usage key that is the public alias resolves directly',
);
check(
  resolveModelPrice(priceList, 'azure/gpt-4o-eastus')?.model === 'gpt-4o',
  'a usage key recorded as the fully qualified backend still resolves',
);
check(
  resolveModelPrice(priceList, 'azure/gpt-4o')?.model === 'gpt-4o',
  "a key carrying a provider prefix falls back to the deployment name, as LiteLLM's own third pass does",
);
check(
  resolveModelPrice(priceList, 'gpt-4o-mini') === null,
  'a plausible-looking near-miss resolves to nothing rather than to the wrong price',
);
check(
  resolveModelPrice(priceList, 'unknown/model') === null && resolveModelPrice(priceList, '  ') === null,
  'a miss is null, so catalogue coverage stays a number a card can lead with',
);

// =====================================================================
// 7 · Budget arithmetic in @dash/shared
// =====================================================================
//
// These are pure and the UI will run on them, but they interpret LiteLLM's own
// duration grammar, so they belong next to the client that reads those fields.

// =====================================================================
// 6d · deployment health — /health
// =====================================================================
//
// The fifth envelope, and the only one that is not a table: two lists, and
// which list an entry is in *is* its state. Entries are that deployment's
// `litellm_params` with the secrets stripped, so what arrives is a routing
// string, maybe a base URL, maybe an id, and — on a failure — an error string
// and the upstream status.

console.log('\n6d · deployment health — /health');

const healthBody = {
  healthy_endpoints: [
    {
      model: 'azure/gpt-4o',
      model_id: 'dep-payg',
      api_base: 'https://nocturne-weu.openai.azure.com/',
      // A healthy entry can carry stray keys; an error on one is nonsense.
      error: 'left over from a previous sweep',
    },
    { model: 'bedrock/anthropic.claude-sonnet-4-v1:0', model_id: 'dep-bedrock', aws_region_name: 'eu-central-1' },
  ],
  unhealthy_endpoints: [
    {
      model: 'azure/gpt-4o',
      model_id: 'dep-ptu',
      api_base: 'https://nocturne-neu-ptu.openai.azure.com/',
      error: 'litellm.RateLimitError: AzureException - exceeded the provisioned throughput',
      exception_status: 429,
    },
    {
      model: 'azure_ai/phi-4',
      model_id: 'dep-phi',
      custom_llm_provider: 'azure_ai',
      // LiteLLM reports this one as a string on some provider SDKs.
      exception_status: '503',
      mode_error: 'model does not support the chat mode this check probed it with',
    },
    // No `model` at all — nothing identifies the deployment, so nothing can be
    // stored about it.
    { api_base: 'https://nowhere.example/', error: 'unnamed' },
  ],
  healthy_count: 2,
  unhealthy_count: 3,
};

const deployments = await withProxy(
  replier({ '/health': { status: 200, body: healthBody } }),
  async (proxy) => client(proxy.baseUrl).fetchHealth(),
);

const healthRow = (id: string) => deployments.find((row) => row.id === id);

check(
  deployments.length === 4,
  `every named deployment is one row, healthy or not (${deployments.length})`,
);
check(
  healthRow('dep-payg')?.healthy === true && healthRow('dep-ptu')?.healthy === false,
  'the list an entry arrived in is its state — there is no status field to read',
);
check(
  healthRow('dep-payg')?.backend === 'azure/gpt-4o' &&
    healthRow('dep-ptu')?.backend === 'azure/gpt-4o',
  'two deployments of one alias share a backend and stay two rows',
);
check(
  healthRow('dep-payg')?.provider === 'azure' && healthRow('dep-bedrock')?.provider === 'bedrock',
  'the provider is inferred from the routing string when the entry does not name one',
);
check(
  healthRow('dep-phi')?.provider === 'azure_ai',
  'and taken from custom_llm_provider when it does',
);
check(
  healthRow('dep-bedrock')?.apiBase === null,
  'a Bedrock deployment carries no api_base, and null there is a fact rather than a gap',
);
check(
  healthRow('dep-ptu')?.errorStatus === 429 && healthRow('dep-phi')?.errorStatus === 503,
  'exception_status is read whether the proxy sends it as a number or a string',
);
check(
  (healthRow('dep-ptu')?.error ?? '').includes('provisioned throughput'),
  "the proxy's own error text is carried through verbatim",
);
check(
  (healthRow('dep-phi')?.error ?? '').includes('chat mode'),
  'a mode_error is a failure too, and is the message when there is no other',
);
check(
  healthRow('dep-payg')?.error === null && healthRow('dep-payg')?.errorStatus === null,
  'a healthy row carries no error, whatever stray keys the entry had on it',
);
check(
  !deployments.some((row) => row.backend === ''),
  'an entry naming no deployment is dropped rather than stored as a blank row',
);

// `health_check_details: false` — a legitimate hardening choice, not a fault.

const minimal = await withProxy(
  replier({
    '/health': {
      status: 200,
      body: {
        healthy_endpoints: [{ model: 'azure/gpt-4o' }],
        unhealthy_endpoints: [{ model: 'bedrock/amazon.nova-pro-v1:0' }],
      },
    },
  }),
  async (proxy) => client(proxy.baseUrl).fetchHealth(),
);
check(
  minimal.length === 2 && minimal.filter((row) => !row.healthy).length === 1,
  'a details-stripped proxy still names every deployment and its state',
);
check(
  minimal.every((row) => row.apiBase === null && row.error === null),
  'and the URL and error text simply go missing, which is the setting doing its job',
);
check(
  minimal[0]?.id === 'azure/gpt-4o',
  'with no model_id the routing string is the id — one row per alias instead of per deployment',
);

// A deployment reported in both lists at once: a sweep that flapped. The
// unhealthy reading is the one worth keeping.

const flapping = await withProxy(
  replier({
    '/health': {
      status: 200,
      body: {
        healthy_endpoints: [{ model: 'azure/gpt-4o', model_id: 'dep-a' }],
        unhealthy_endpoints: [{ model: 'azure/gpt-4o', model_id: 'dep-a', error: 'timeout' }],
      },
    },
  }),
  async (proxy) => client(proxy.baseUrl).fetchHealth(),
);
check(
  flapping.length === 1 && flapping[0]?.healthy === false,
  'a deployment in both lists is one row, and it is the failing one',
);

// Optionality, and the one shape that must not be swallowed.

for (const status of [401, 403, 404, 405, 501]) {
  const absent = await withProxy(
    replier({ '/health': { status, body: { detail: 'no' } } }),
    async (proxy) => client(proxy.baseUrl).fetchHealth(),
  );
  check(absent.length === 0, `a ${status} from /health yields no deployments and no error`);
}

const malformedHealth = await withProxy(
  replier({ '/health': { status: 200, body: { healthy_endpoints: 'not a list' } } }),
  async (proxy) => {
    try {
      await client(proxy.baseUrl).fetchHealth();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  },
);
check(
  (malformedHealth ?? '').includes('unexpected shape'),
  'a 2xx body this client cannot read throws rather than reporting an empty gateway',
);

// The alias join, run backwards — /health reports routing strings and never
// public names.

const healthCatalogue: { model: string; backend: string | null }[] = [
  { model: 'gpt-4o', backend: 'azure/gpt-4o' },
  { model: 'bedrock/anthropic.claude-sonnet-4-v1:0', backend: 'bedrock/anthropic.claude-sonnet-4-v1:0' },
  { model: 'phi-4', backend: null },
];
check(
  resolveDeploymentModel(healthCatalogue, 'azure/gpt-4o') === 'gpt-4o',
  'a deployment resolves to the alias whose backend it is',
);
check(
  resolveDeploymentModel(healthCatalogue, 'bedrock/anthropic.claude-sonnet-4-v1:0') ===
    'bedrock/anthropic.claude-sonnet-4-v1:0',
  'and to itself on a proxy that never renamed anything',
);
check(
  resolveDeploymentModel(healthCatalogue, 'azure/gpt-4o-2024-11-20') === null,
  'a near miss is null — filing a deployment under an alias it does not serve is worse than not naming it',
);
check(resolveDeploymentModel(healthCatalogue, '   ') === null, 'and an empty routing string resolves to nothing');

// The alias-level reading, which is the whole point of the table.

const madeDeployment = (over: Partial<GatewayDeployment>): GatewayDeployment => ({
  id: 'x',
  backend: 'azure/gpt-4o',
  model: 'gpt-4o',
  provider: 'azure',
  apiBase: null,
  healthy: true,
  error: null,
  errorStatus: null,
  checkedAt: '2026-07-31T02:00:00.000Z',
  ...over,
});

const summary = summarizeDeploymentHealth(
  [
    madeDeployment({ id: 'a1', model: 'gpt-4o' }),
    madeDeployment({ id: 'a2', model: 'gpt-4o', healthy: false, error: 'quota' }),
    madeDeployment({ id: 'b1', model: 'nova-pro', provider: 'bedrock', healthy: false, error: 'no route' }),
    madeDeployment({ id: 'c1', model: 'phi-4', provider: 'azure_ai' }),
    madeDeployment({ id: 'd1', model: null, backend: 'azure/gpt-35-turbo' }),
  ],
  '2026-07-31T02:00:00.000Z',
);
const alias = (name: string | null) => summary.models.find((row) => row.model === name);

check(
  alias('gpt-4o')?.state === 'degraded',
  'an alias with one of two deployments failing is degraded — it still answers, on half the capacity',
);
check(
  alias('nova-pro')?.state === 'down',
  'an alias whose only deployment is failing has nowhere to fail over to',
);
check(alias('phi-4')?.state === 'up', 'and one with nothing failing is up');
check(
  summary.models[0]?.state === 'down' && summary.models.at(-1)?.state === 'up',
  'the ranking is worst first',
);
check(
  summary.down.length === 1 && summary.degraded.length === 1,
  'the two states worth a finding are separated out, and up is not one of them',
);
check(
  summary.unnamed === 1 && alias(null)?.deployments === 1,
  'a deployment the catalogue could not name is its own bucket, counted rather than merged',
);
check(
  summary.deployments === 5 && summary.unhealthy === 2,
  'the totals count deployments, never aliases — the two are different numbers on any load-balanced proxy',
);
const azure = summary.providers.find((row) => row.provider === 'azure');
check(
  azure?.deployments === 3 && azure?.unhealthy === 1,
  `a provider rollup counts deployments across aliases (${azure?.deployments} azure)`,
);
check(
  summary.providers[0]?.unhealthy === 1 && summary.providers.every((row) => row.deployments > 0),
  'providers rank by failures, so a whole cloud going dark sorts to the top',
);

const identical = summarizeDeploymentHealth(
  [
    madeDeployment({ id: 'r1', healthy: false, error: 'region unavailable' }),
    madeDeployment({ id: 'r2', healthy: false, error: 'region unavailable' }),
    madeDeployment({ id: 'r3', healthy: false, error: 'region unavailable' }),
  ],
  null,
);
check(
  identical.models[0]?.errors.length === 1 && identical.models[0]?.state === 'down',
  'three regions failing identically is one fault, reported once',
);
check(
  summarizeDeploymentHealth([], null).checkedAt === null &&
    summarizeDeploymentHealth([], null).models.length === 0,
  'no deployments summarises to nothing rather than to a healthy gateway',
);

// =====================================================================
// 6e · request logs — /spend/logs
// =====================================================================
//
// The sixth envelope and the loosest: a bare array of table rows on the
// documented route, or the same rows under `{"data": …}` on a newer proxy.
// Three things are load-bearing and none of them are in the other sections —
// `summarize=false` (the parameter defaults to *true* and answers daily
// aggregates, i.e. the wrong thing, successfully), per-row tolerance (a sample
// drops what it cannot read where a ledger payload throws), and the row cap
// being reported rather than hidden.

console.log('\n6e · request logs — /spend/logs');

const logRow = (over: Record<string, unknown> = {}) => ({
  request_id: 'chatcmpl-1',
  call_type: 'acompletion',
  api_key: 'hash-a',
  spend: 1.095e-5,
  prompt_tokens: 1_200,
  completion_tokens: 300,
  total_tokens: 1_500,
  startTime: '2026-07-01T09:15:00.594000Z',
  endTime: '2026-07-01T09:15:02.594000Z',
  model: 'gpt-4o-eu2',
  model_id: 'dep-ptu',
  model_group: 'azure/gpt-4o',
  custom_llm_provider: 'azure',
  api_base: 'https://nocturne-weu.openai.azure.com/',
  user: 'ana.kovacs@corp.example',
  team_id: 'team-platform',
  request_tags: ['coding-assistant', 'eu'],
  cache_hit: 'True',
  status: 'success',
  metadata: {
    user_api_key: 'hash-a',
    user_api_key_alias: 'copilot-agents',
    user_api_key_team_id: 'team-platform',
    user_api_key_team_alias: 'Platform Engineering',
    user_api_key_user_id: 'ana.kovacs@corp.example',
  },
  ...over,
});

const logsCall = await withProxy(
  replier({ '/spend/logs': { status: 200, body: [logRow()] } }),
  async (proxy) => {
    const page = await client(proxy.baseUrl).fetchSpendLogs('2026-07-01', '2026-07-02', 100);
    return { page, captured: proxy.calls[0] };
  },
);

check(
  logsCall.captured?.query.get('summarize') === 'false',
  'summarize=false is sent — the default answers daily aggregates, which is the wrong thing successfully',
);
check(
  logsCall.captured?.query.get('start_date') === '2026-07-01' &&
    logsCall.captured?.query.get('end_date') === '2026-07-02',
  'the window is sent as start_date/end_date, like every other route',
);
check(
  logsCall.captured?.authorization === 'Bearer sk-test-key',
  'the log route is authenticated like the rest',
);

const logged = logsCall.page.rows[0];
check(logsCall.page.available && !logsCall.page.truncated, 'a bare array is the documented answer and parses');
check(logged?.spendNano === 10_950n, 'exponent-notation spend survives at nano scale (1.095e-05 → 10950)');
check(
  logged?.modelGroup === 'azure/gpt-4o' && logged?.model === 'gpt-4o-eu2',
  'the alias asked for and the deployment model called are kept apart — the alias is what joins to usage',
);
check(
  logged?.deploymentId === 'dep-ptu',
  'model_id is carried: the only join between a request and gateway_deployment_health',
);
check(logged?.durationMs === 2_000, 'a duration is derived from the two timestamps when the column is absent');
check(
  logged?.keyAlias === 'copilot-agents' && logged?.teamAlias === 'Platform Engineering',
  'aliases come from metadata, which is the only place the proxy carries them',
);
check(
  logged?.tags.length === 2,
  'request_tags is a list — one request legitimately sits in several tag buckets',
);
check(logged?.cacheHit === true, 'cache_hit "True" is a boolean');

const logShapes = await withProxy(
  replier({
    '/spend/logs': {
      status: 200,
      body: {
        data: [
          // `request_duration_ms` wins over the timestamps where the proxy has it.
          logRow({ request_id: 'measured', request_duration_ms: 850 }),
          // No end time at all: nothing to derive a duration from, and null is
          // the honest answer rather than zero.
          logRow({ request_id: 'open', endTime: null }),
          // The identity columns empty and metadata carrying them, which is what
          // a proxy authenticating with a key but not resolving a user writes.
          logRow({ request_id: 'meta-only', user: '', team_id: '', api_key: '' }),
          // A tag list round-tripped through a text column.
          logRow({ request_id: 'text-tags', request_tags: '["batch"]' }),
          logRow({ request_id: 'junk-tags', request_tags: 'not json at all' }),
          // The third state of cache_hit: nobody recorded one.
          logRow({ request_id: 'no-cache-flag', cache_hit: null }),
          logRow({ request_id: 'cache-miss', cache_hit: 'False' }),
          // Unusable rows: no id, and a timestamp nothing can read.
          logRow({ request_id: '' }),
          logRow({ request_id: 'no-clock', startTime: null }),
        ],
      },
    },
  }),
  async (proxy) => client(proxy.baseUrl).fetchSpendLogs('2026-07-01', '2026-07-01', 100),
);

const shaped = (id: string) => logShapes.rows.find((row) => row.requestId === id);

check(logShapes.rows.length === 7, `a {"data": …} envelope parses too (${logShapes.rows.length} usable rows)`);
check(shaped('measured')?.durationMs === 850, 'request_duration_ms wins over the timestamp difference');
check(
  shaped('open')?.durationMs === null && shaped('open')?.endTime === null,
  'a request with no end time has an unknown duration, not a zero one',
);
check(
  shaped('meta-only')?.user === 'ana.kovacs@corp.example' &&
    shaped('meta-only')?.teamId === 'team-platform' &&
    shaped('meta-only')?.apiKey === 'hash-a',
  'the identity falls back to metadata when the columns are empty',
);
check(shaped('text-tags')?.tags[0] === 'batch', 'a JSON-string tag list is read as a list');
check(shaped('junk-tags')?.tags.length === 0, 'an unreadable tag list is no tags rather than a thrown read');
check(
  shaped('no-cache-flag')?.cacheHit === null && shaped('cache-miss')?.cacheHit === false,
  'cache_hit is tri-state: nobody recorded it is not the same as a miss',
);
check(
  shaped('no-clock') === undefined && logShapes.rows.every((row) => row.requestId !== ''),
  'a row with no id and one with no clock are dropped — a sample tolerates what a ledger would throw over',
);

const capped = await withProxy(
  replier({
    '/spend/logs': {
      status: 200,
      body: [logRow({ request_id: 'a' }), logRow({ request_id: 'b' }), logRow({ request_id: 'c' })],
    },
  }),
  async (proxy) => client(proxy.baseUrl).fetchSpendLogs('2026-07-01', '2026-07-01', 2),
);
check(
  capped.rows.length === 2 && capped.truncated,
  'the row cap is honoured and the read says it was truncated — a capped sample is a floor',
);

for (const status of [401, 403, 404, 501]) {
  const absent = await withProxy(
    replier({ '/spend/logs': { status, body: { detail: 'nope' } } }),
    async (proxy) => client(proxy.baseUrl).fetchSpendLogs('2026-07-01', '2026-07-01', 10),
  );
  check(
    !absent.available && absent.rows.length === 0,
    `${status} on /spend/logs is "this proxy keeps no logs" rather than a failure`,
  );
}

const emptyLogs = await withProxy(
  replier({ '/spend/logs': { status: 200, body: [] } }),
  async (proxy) => client(proxy.baseUrl).fetchSpendLogs('2026-07-01', '2026-07-01', 10),
);
check(
  emptyLogs.available && emptyLogs.rows.length === 0 && !emptyLogs.truncated,
  'an empty answer is available-and-empty, which is a different fact from a refused route',
);

let logsThrew = false;
try {
  await withProxy(
    replier({ '/spend/logs': { status: 200, body: { rows: 'nope' } } }),
    async (proxy) => client(proxy.baseUrl).fetchSpendLogs('2026-07-01', '2026-07-01', 10),
  );
} catch {
  logsThrew = true;
}
check(logsThrew, 'an envelope that is neither an array nor {data: […]} throws rather than reading as empty');

console.log('\n7 · budget arithmetic');

check(parseBudgetDuration('30d')?.unit === 'd', 'a plain duration parses');
check(parseBudgetDuration('1mo')?.unit === 'mo', 'months parse as months, not minutes');
check(parseBudgetDuration('monthly')?.value === 30, "LiteLLM's own alias table makes `monthly` 30d, not 1mo");
check(parseBudgetDuration('weekly')?.unit === 'd' && parseBudgetDuration('weekly')?.value === 7, '`weekly` is 7d');
check(parseBudgetDuration('') === null && parseBudgetDuration('0d') === null, 'nonsense durations are null, not a fake period');

const budget = (over: Partial<GatewayBudget> = {}): GatewayBudget => ({
  scope: 'api_key',
  key: 'k',
  label: null,
  spend: 50,
  maxBudget: 100,
  softBudget: null,
  budgetDuration: '1mo',
  resetAt: '2026-08-01T00:00:00.000Z',
  tpmLimit: null,
  rpmLimit: null,
  blocked: false,
  ...over,
});

check(budgetUtilization(budget()) === 50, 'utilisation is spend over cap');
check(budgetUtilization(budget({ spend: 130 })) === 130, 'an overrun reads above 100, not clamped');
check(budgetUtilization(budget({ maxBudget: null })) === null, 'an uncapped budget has no utilisation');
check(budgetUtilization(budget({ maxBudget: 0 })) === null, 'a zero cap has no percentage to report');
check(budgetRemaining(budget({ spend: 130 })) === -30, 'remaining goes negative on overrun');

check(
  budgetPeriodStart(budget()) === '2026-07-01T00:00:00.000Z',
  'a 1mo period resetting on 1 August began on 1 July',
);
check(
  budgetPeriodStart(budget({ resetAt: '2026-03-01T00:00:00.000Z' })) === '2026-02-01T00:00:00.000Z',
  'a February month is walked on the calendar, not as 30 nominal days',
);
check(
  budgetPeriodStart(budget({ resetAt: '2026-03-31T12:00:00.000Z' })) === '2026-02-28T12:00:00.000Z',
  'a 31st resetting monthly clamps to the shorter month rather than rolling into March',
);
check(
  budgetPeriodStart(budget({ budgetDuration: '7d', resetAt: '2026-07-06T00:00:00.000Z' })) ===
    '2026-06-29T00:00:00.000Z',
  'a 7d period is exactly seven days back',
);
check(
  budgetPeriodStart(budget({ resetAt: null })) === null &&
    budgetPeriodStart(budget({ budgetDuration: 'whenever' })) === null,
  'a period start needs both halves and a duration the proxy would accept',
);

// =====================================================================
// 8 · probe — the connection check
// =====================================================================
//
// The probe is the one client method whose *failures* are its output: a
// refused management route and a dead host are results with statuses on them,
// not exceptions. Three properties matter and none of them are visible from
// the sync's behaviour — one attempt per route (a sync retries, a probe must
// not), 401/403 kept apart from 404/405/501 (the sync folds them together
// because its only choice is to skip), and per-dimension key counts, which
// decide whether a breakdown card has anything to draw.

console.log('\n8 · probe — one attempt per route, statuses classified, warnings named');

const DAY = '2026-07-04';

function replier(replies: Record<string, Reply>): Handler {
  return (captured) => replies[captured.path] ?? { status: 404, body: { detail: 'unknown route' } };
}

const activityDay = (over: Record<string, unknown> = {}) =>
  envelope([
    {
      date: DAY,
      metrics: metrics({ spend: 12.5, api_requests: 400 }),
      breakdown: {
        models: { 'azure/gpt-4o': bucket({ spend: 8 }), 'bedrock/claude': bucket({ spend: 4.5 }) },
        providers: { azure: bucket({ spend: 8 }), bedrock: bucket({ spend: 4.5 }) },
        api_keys: { 'hash-a': bucket({ spend: 12.5 }) },
        mcp_servers: {},
        entities: { 'ada@corp': bucket({ spend: 12.5 }) },
        ...over,
      },
    },
  ]);

const healthy = await withProxy(
  replier({
    '/user/daily/activity': { status: 200, body: activityDay() },
    '/team/daily/activity': { status: 200, body: activityDay() },
    '/tag/daily/activity': { status: 200, body: activityDay() },
    '/key/list': {
      status: 200,
      body: { keys: [keyRow({ token: 'hash-a' }), 'bare-token-no-budget'], total_pages: 1 },
    },
    '/team/list': { status: 200, body: [{ team_id: 'platform', team_alias: 'Platform' }] },
    '/tag/list': {
      status: 200,
      body: [{ name: 'coding-assistant', spend: 1, litellm_budget_table: { max_budget: 10 } }],
    },
    '/user/list': {
      status: 200,
      body: {
        users: [
          { user_id: 'sso|ana', user_email: 'ana@corp.example', spend: 3, max_budget: 400 },
          // A person with no cap: answered by the route, counted in `rows`, and
          // not governance — the gap the probe's detail exists to spell.
          { user_id: 'sso|nina', user_email: 'nina@corp.example', spend: 9 },
        ],
        total: 2,
        total_pages: 1,
      },
    },
    '/model/info': {
      status: 200,
      body: {
        data: [
          {
            model_name: 'azure/gpt-4o',
            litellm_params: { model: 'azure/gpt-4o' },
            model_info: { input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5 },
          },
        ],
      },
    },
    '/health/readiness': {
      status: 200,
      body: { status: 'healthy', db: 'connected', litellm_version: '1.77.3' },
    },
  }),
  async (proxy) => ({ routes: await client(proxy.baseUrl).probe(DAY), calls: proxy.calls }),
);

const route = (path: string): GatewayProbeRoute | undefined =>
  healthy.routes.find((candidate) => candidate.path === path);

check(healthy.calls.length === 9, `one call per route, no retries (${healthy.calls.length})`);
check(
  healthy.calls.map((call) => call.path).join(' ') ===
    '/user/daily/activity /team/daily/activity /tag/daily/activity /key/list /team/list /tag/list /user/list /model/info /health/readiness',
  'routes are probed in dependency order, activity before management',
);
check(
  !healthy.calls.some((call) => call.path === '/health'),
  'the probe never calls /health — it would bill a test call per deployment per press',
);
check(
  healthy.calls[0]?.query.get('start_date') === DAY &&
    healthy.calls[0]?.query.get('end_date') === DAY,
  'the activity routes are asked about exactly one day',
);
check(
  healthy.routes.every((probed) => probed.status === 'ok'),
  'a proxy answering everything probes ok on every route',
);
check(
  route('/user/daily/activity')?.required === true &&
    healthy.routes.filter((probed) => probed.required).length === 1,
  'only the user activity route is required — everything else costs one dimension',
);

const coverage = route('/user/daily/activity')?.dimensions ?? [];
const keysFor = (dimension: string) =>
  coverage.find((entry) => entry.dimension === dimension)?.keys;
check(
  keysFor('model') === 2 && keysFor('provider') === 2 && keysFor('api_key') === 1,
  `distinct keys are counted per dimension (${keysFor('model')} models, ${keysFor('provider')} providers)`,
);
check(keysFor('user') === 1, 'the entities breakdown is counted as the route owns it');
check(
  route('/team/daily/activity')?.dimensions.length === 1 &&
    route('/team/daily/activity')?.dimensions[0]?.dimension === 'team',
  'a re-slicing route reports only its own entity dimension',
);
check(
  coverage.find((entry) => entry.dimension === 'mcp_server')?.expected === false &&
    coverage.every((entry) => entry.dimension === 'mcp_server' || entry.expected),
  'mcp_server is the one dimension an empty count is not a gap in',
);
check(
  (route('/key/list')?.detail ?? '').includes('only 1 identified'),
  `a proxy answering bare token strings is reported, not silently dropped (${route('/key/list')?.detail})`,
);

check(
  (route('/health/readiness')?.detail ?? '').includes('db connected') &&
    (route('/health/readiness')?.detail ?? '').includes('1.77.3'),
  `readiness reports the proxy's own state and version (${route('/health/readiness')?.detail})`,
);
check(
  route('/health/readiness')?.rows === null,
  'and no row count, because readiness has nothing to be empty of',
);

const healthySummary = summarizeGatewayProbe(healthy.routes);
check(healthySummary.usable, 'a fully answering proxy is usable');
check(
  healthySummary.warnings.length === 0,
  `and warns about nothing (${healthySummary.warnings.join(' | ')})`,
);

// A realistic analytics-only credential: usage works, teams and tags are not
// offered, key management is refused. The sync survives all three; the probe's
// job is to say what each one costs.

const restricted = await withProxy(
  replier({
    '/user/daily/activity': { status: 200, body: envelope([]) },
    '/team/daily/activity': { status: 501, body: { detail: 'not implemented' } },
    '/tag/daily/activity': { status: 404, body: { detail: 'no such route' } },
    '/key/list': { status: 403, body: { detail: 'Only proxy admins may list keys' } },
    '/team/list': { status: 401, body: { detail: 'invalid credentials' } },
    // Older proxy: tag management does not exist at all, which is a different
    // fix from the refused routes above and must classify differently.
    '/tag/list': { status: 404, body: { detail: 'Not Found' } },
    '/user/list': { status: 403, body: { detail: 'Only proxy admins may list users' } },
    '/model/info': { status: 403, body: { detail: 'Only proxy admins may view models' } },
    // Readiness needs no credential at all, so a restricted key does not
    // explain it away — a 503 here is the proxy itself, not this integration's
    // permissions, which is exactly why it is the route worth probing.
    '/health/readiness': { status: 503, body: { status: 'unhealthy', db: 'disconnected' } },
  }),
  async (proxy) => ({ routes: await client(proxy.baseUrl).probe(DAY), calls: proxy.calls }),
);

const restrictedRoute = (path: string): GatewayProbeRoute | undefined =>
  restricted.routes.find((candidate) => candidate.path === path);

check(
  restricted.calls.length === 9,
  `a refused or absent route is attempted once, never retried (${restricted.calls.length})`,
);
check(
  restrictedRoute('/tag/list')?.status === 'absent' && restrictedRoute('/key/list')?.status === 'denied',
  'an absent tag route and a refused key route are kept apart — one is fixable and the other is not',
);
check(
  restrictedRoute('/team/daily/activity')?.status === 'absent' &&
    restrictedRoute('/tag/daily/activity')?.status === 'absent',
  '501 and 404 both read as "this proxy does not offer that"',
);
check(
  restrictedRoute('/key/list')?.status === 'denied' &&
    restrictedRoute('/team/list')?.status === 'denied',
  '401 and 403 read as a permission problem, not as an absent route',
);
check(
  (restrictedRoute('/key/list')?.detail ?? '').includes('proxy admins'),
  "the proxy's own refusal message is carried through, not swallowed",
);
check(
  restrictedRoute('/user/daily/activity')?.status === 'empty' &&
    restrictedRoute('/user/daily/activity')?.rows === 0,
  'a 200 with no rows is "empty", which is not the same as broken',
);

check(
  restrictedRoute('/health/readiness')?.status === 'unreachable' &&
    restrictedRoute('/health/readiness')?.httpStatus === 503,
  'a proxy that cannot reach its own database is unreachable, not denied — readiness needs no key',
);

const restrictedSummary = summarizeGatewayProbe(restricted.routes);
check(
  restrictedSummary.usable,
  'a usage-only credential can still sync — every missing route is optional',
);
check(
  restrictedSummary.warnings.some((warning) => warning.includes('scoped to an entity')),
  'an empty required route says the idle-gateway and scoped-key readings are indistinguishable',
);
check(
  restrictedSummary.warnings.some((warning) => warning.includes('budget card will be empty')),
  'a refused /key/list warns in the dashboard\'s terms, not in HTTP',
);
check(
  // Five unanswered routes plus the empty-but-required user route: six gaps,
  // six statements. The count moves with the route table by design — a new
  // optional route that warned about nothing would be a route nobody misses.
  restrictedSummary.warnings.length === 9,
  `one statement per gap, no more (${restrictedSummary.warnings.length})`,
);

// The two ways the required route can genuinely fail.

const dead = await withProxy(
  replier({ '/user/daily/activity': { status: 500, body: { detail: 'boom' } } }),
  async (proxy) => client(proxy.baseUrl).probe(DAY),
);
check(
  dead[0]?.status === 'unreachable' && dead[0]?.httpStatus === 500,
  'a 5xx that is not an absent-route status reads as unreachable',
);
check(!summarizeGatewayProbe(dead).usable, 'and the gateway cannot sync at all');

const garbled = await withProxy(
  replier({
    '/user/daily/activity': { status: 200, body: 'this is not JSON' },
    '/team/daily/activity': { status: 200, body: { results: 'not an array' } },
  }),
  async (proxy) => client(proxy.baseUrl).probe(DAY),
);
check(
  garbled[0]?.status === 'malformed' && (garbled[0]?.detail ?? '').includes('not JSON'),
  'a 2xx body that is not JSON is malformed, not unreachable',
);
check(
  garbled[1]?.status === 'malformed' && (garbled[1]?.detail ?? '').includes('results'),
  'a 2xx body that parses but does not match the contract names the field',
);
check(!summarizeGatewayProbe(garbled).usable, 'an unreadable required route blocks the sync too');

// A route can answer 200, carry rows, and still leave a card blank.

const blankDimensions = await withProxy(
  replier({
    '/user/daily/activity': {
      status: 200,
      body: envelope([{ date: DAY, metrics: metrics({ spend: 1 }), breakdown: {} }]),
    },
  }),
  async (proxy) => client(proxy.baseUrl).probe(DAY),
);
const blankSummary = summarizeGatewayProbe(blankDimensions);
// Only /user answers here, so the other five routes 404 and warn as absent —
// the dimension-shaped warnings are the ones this case is about.
const blankDimensionWarnings = blankSummary.warnings.filter((warning) =>
  warning.includes('answered, but carried no'),
);
check(
  blankDimensions[0]?.status === 'ok' && blankDimensions[0]?.rows === 1,
  'rows with an empty breakdown still count as an answer',
);
check(
  blankSummary.usable && blankDimensionWarnings.length === 4,
  `each expected-but-empty dimension is named, and mcp_server is not (${blankDimensionWarnings.length})`,
);
check(
  !blankSummary.warnings.some((warning) => warning.toLowerCase().includes('mcp')),
  'a gateway with no MCP traffic is not reported as a fault',
);
check(
  summarizeGatewayProbe([]).usable === false,
  'no routes at all is not "usable" by default',
);

// ------------------------------------------- GET /model/metrics/exceptions
//
// The seventh envelope, and the only one whose *field names are data*: the
// per-class counts are spread onto the same object as the row's own fields.
// Two traps live in it — `total_exceptions` counts distinct classes rather
// than exceptions, and the route filters on one `model_group` per call with no
// wildcard, so a sweep is N requests and an alias nobody asked about is unread
// rather than clean.

const EXC_FROM = '2026-06-01';
const EXC_TO = '2026-06-30';

const exceptionsBody = (rows: Record<string, unknown>[]) => ({
  data: rows,
  exception_types: [
    ...new Set(
      rows.flatMap((row) =>
        Object.keys(row).filter((field) => field !== 'model' && field !== 'total_exceptions'),
      ),
    ),
  ],
});

// Alias-aware, because the route is: each call filters on one model_group and
// answers only that alias's deployments.
const exceptionRows: Record<string, Record<string, unknown>[]> = {
  'azure/gpt-4o': [
    {
      model: 'azure/gpt-4o-https://nocturne-neu-ptu.openai.azure.com/',
      // The proxy's own figure: two classes, four thousand exceptions.
      total_exceptions: 2,
      RateLimitError: 4_000,
      Timeout: 20,
      // A field a newer proxy might carry. Not a class, not a number, and
      // never coerced into one.
      api_base: 'https://nocturne-neu-ptu.openai.azure.com/',
      // A class the proxy counted none of. Dropped rather than stored as a
      // zero row nobody can act on.
      AuthenticationError: 0,
    },
    // A row naming no deployment is unusable and is dropped.
    { total_exceptions: 1, BadRequestError: 5 },
  ],
  'bedrock/claude': [{ model: 'bedrock/claude', total_exceptions: 1, ServiceUnavailableError: 12 }],
};

const sweep = await withProxy(
  (captured) =>
    captured.path === '/model/metrics/exceptions'
      ? {
          status: 200,
          body: exceptionsBody(
            exceptionRows[captured.query.get('_selected_model_group') ?? ''] ?? [],
          ),
        }
      : { status: 404, body: { detail: 'unknown route' } },
  async (proxy) => {
    const page = await client(proxy.baseUrl).fetchModelExceptions(EXC_FROM, EXC_TO, [
      'azure/gpt-4o',
      'bedrock/claude',
    ]);
    return { page, calls: [...proxy.calls] };
  },
);

check(
  sweep.calls.length === 2 &&
    sweep.calls.every((call) => call.path === '/model/metrics/exceptions'),
  `one call per alias, no wildcard call (${sweep.calls.length})`,
);
check(
  sweep.calls[0]?.query.get('_selected_model_group') === 'azure/gpt-4o' &&
    sweep.calls[1]?.query.get('_selected_model_group') === 'bedrock/claude',
  'each call names its own model group — the parameter the proxy filters on',
);
check(
  sweep.calls[0]?.query.get('startTime') === `${EXC_FROM}T00:00:00` &&
    sweep.calls[0]?.query.get('endTime') === `${EXC_TO}T23:59:59`,
  'the window is sent as datetimes, ending at the end of the last day',
);
check(
  sweep.calls.every((call) => call.authorization === 'Bearer sk-test-key'),
  'the sweep is authenticated like every other route',
);

const ptu = sweep.page.rows.find((row) => row.deployment.includes('neu-ptu'));
check(
  sweep.page.available && sweep.page.rows.length === 2,
  `a row with no model is dropped, the rest survive (${sweep.page.rows.length})`,
);
check(
  ptu?.deployment === 'azure/gpt-4o-https://nocturne-neu-ptu.openai.azure.com/',
  'combined_model_api_base is kept verbatim and never parsed back into parts',
);
check(
  ptu !== undefined && deploymentExceptionKey('azure/gpt-4o', 'https://nocturne-neu-ptu.openai.azure.com/') === ptu.deployment,
  'and the health row rebuilds the same key — the join runs that way round only',
);
check(
  ptu?.model === 'azure/gpt-4o',
  'the alias comes from the query, since the row carries only a deployment',
);
check(
  ptu?.exceptions.length === 2 &&
    ptu.exceptions.find((entry) => entry.type === 'RateLimitError')?.count === 4_000,
  'every remaining numeric key is read as an exception class with its count',
);
check(
  !(ptu?.exceptions.some((entry) => entry.type === 'api_base') ?? true),
  'a non-numeric extra field is ignored, never coerced into a class',
);
check(
  !(ptu?.exceptions.some((entry) => entry.type === 'AuthenticationError') ?? true),
  'a class the proxy counted zero of is dropped rather than stored as a zero',
);
check(
  ptu?.reportedTotal === 2 &&
    ptu.exceptions.reduce((sum, entry) => sum + entry.count, 0) === 4_020,
  'total_exceptions counts classes, not exceptions — the sum is ours and disagrees with it',
);
check(
  classifyGatewayException('RateLimitError') === 'rate-limit' &&
    classifyGatewayException('litellm.RateLimitError') === 'rate-limit' &&
    classifyGatewayException('BudgetExceededError') === 'budget' &&
    classifyGatewayException('ContextWindowExceededError') === 'request' &&
    classifyGatewayException('SomethingNewError') === 'other',
  'the class map reads LiteLLM\'s own exception names, prefixed or bare, and guesses at nothing',
);

const noAliases = await withProxy(
  replier({ '/model/metrics/exceptions': { status: 200, body: exceptionsBody([]) } }),
  async (proxy) => {
    const page = await client(proxy.baseUrl).fetchModelExceptions(EXC_FROM, EXC_TO, []);
    return { page, calls: proxy.calls.length };
  },
);
check(
  noAliases.calls === 0 && noAliases.page.available && noAliases.page.rows.length === 0,
  'no aliases fetches nothing rather than everything — there is no "all models" call',
);

const emptyAnswer = await withProxy(
  replier({ '/model/metrics/exceptions': { status: 200, body: exceptionsBody([]) } }),
  async (proxy) => client(proxy.baseUrl).fetchModelExceptions(EXC_FROM, EXC_TO, ['azure/gpt-4o']),
);
check(
  emptyAnswer.available && emptyAnswer.rows.length === 0,
  'a route that answers with no rows is available and recorded nothing — not refused',
);

for (const status of [401, 403, 404, 405, 501]) {
  const refused = await withProxy(
    replier({ '/model/metrics/exceptions': { status, body: { detail: 'no' } } }),
    async (proxy) => {
      const page = await client(proxy.baseUrl).fetchModelExceptions(EXC_FROM, EXC_TO, [
        'azure/gpt-4o',
        'bedrock/claude',
      ]);
      return { page, calls: proxy.calls.length };
    },
  );
  check(
    !refused.page.available && refused.page.rows.length === 0 && refused.calls === 1,
    `${status} stands the whole sweep down after one call, rather than asking per alias`,
  );
}

let threw = false;
try {
  await withProxy(
    replier({ '/model/metrics/exceptions': { status: 200, body: { data: 'not a list' } } }),
    async (proxy) => client(proxy.baseUrl).fetchModelExceptions(EXC_FROM, EXC_TO, ['azure/gpt-4o']),
  );
} catch (error) {
  threw = String(error).includes('unexpected shape');
}
check(threw, 'a malformed envelope throws rather than reporting a clean gateway');

// ------------------------------------------------------ GET /model/metrics
//
// The eighth envelope, and the second whose field names are data: one object
// per day carrying `date` plus one key per deployment. Four traps live in it —
// `_selected_model_group` defaults upstream to the literal "gpt-4-32k" so a
// call without it answers an empty gateway, the values are *seconds per
// completion token* rather than durations, the key is an `api_base` (so two
// models behind one endpoint collapse upstream), and the handler answers a bare
// `null` when its query matched nothing.

const LAT_FROM = '2026-06-01';
const LAT_TO = '2026-06-30';

const latencyRows: Record<string, unknown[]> = {
  'azure/gpt-4o': [
    {
      date: '2026-06-01',
      'https://nocturne-weu.openai.azure.com/': 0.0071,
      'https://nocturne-neu-ptu.openai.azure.com/': 0.0142,
      // A key a newer proxy might carry beside the deployments. Not a number,
      // so not a deployment.
      note: 'partial day',
      // AVG over an all-null group. Not measured, and never instant.
      'https://nocturne-eus.openai.azure.com/': null,
    },
    { date: '2026-06-02', 'https://nocturne-weu.openai.azure.com/': 0.0069 },
    // A row whose date this client cannot place cannot go on a spine.
    { date: 'Jun 03', 'https://nocturne-weu.openai.azure.com/': 0.5 },
  ],
  'bedrock/claude': [
    // No URL, so the key is the backend model string — the other branch of
    // latencyDeploymentKey, live in the same sweep.
    { date: '2026-06-01', 'bedrock/claude': 0.0043 },
  ],
};

const latencySweep = await withProxy(
  (captured) =>
    captured.path === '/model/metrics'
      ? {
          status: 200,
          body: {
            data: latencyRows[captured.query.get('_selected_model_group') ?? ''] ?? [],
            all_api_bases: ['https://nocturne-weu.openai.azure.com/'],
          },
        }
      : { status: 404, body: { detail: 'unknown route' } },
  async (proxy) => {
    const page = await client(proxy.baseUrl).fetchModelLatency(LAT_FROM, LAT_TO, [
      'azure/gpt-4o',
      'bedrock/claude',
    ]);
    return { page, calls: [...proxy.calls] };
  },
);

check(
  latencySweep.calls.length === 2 && latencySweep.calls.every((call) => call.path === '/model/metrics'),
  `one call per alias here too — the same model_group filter, the same absence of a wildcard (${latencySweep.calls.length})`,
);
check(
  latencySweep.calls[0]?.query.get('_selected_model_group') === 'azure/gpt-4o' &&
    latencySweep.calls[1]?.query.get('_selected_model_group') === 'bedrock/claude',
  'every call names its model group — omitting it would silently ask about the proxy\'s "gpt-4-32k" default',
);
check(
  latencySweep.calls[0]?.query.get('startTime') === `${LAT_FROM}T00:00:00` &&
    latencySweep.calls[0]?.query.get('endTime') === `${LAT_TO}T23:59:59`,
  'the window is sent as datetimes, ending at the end of the last day',
);

const weu = latencySweep.page.rows.filter(
  (row) => row.key === 'https://nocturne-weu.openai.azure.com/',
);
check(
  latencySweep.page.available && weu.length === 2,
  `each day's numeric key becomes one reading for that deployment (${weu.length})`,
);
check(
  weu[0]?.secondsPerToken === 0.0071 && weu[0]?.date === '2026-06-01',
  'the value is carried through unconverted — seconds per completion token, never a duration',
);
check(
  weu.every((row) => row.model === 'azure/gpt-4o'),
  'the alias comes from the query, since the row carries only a date and deployment keys',
);
check(
  !latencySweep.page.rows.some((row) => row.key === 'note'),
  'a non-numeric extra field is ignored, never coerced into a deployment',
);
check(
  !latencySweep.page.rows.some((row) => row.key.includes('eus')),
  'a null average is dropped — an unmeasured deployment is not an instant one',
);
check(
  !latencySweep.page.rows.some((row) => row.date === 'Jun 03'),
  'a row whose date is not an ISO day is dropped rather than placed by guesswork',
);
check(
  latencySweep.page.rows.some((row) => row.key === 'bedrock/claude') &&
    latencyDeploymentKey('bedrock/claude', null) === 'bedrock/claude',
  'a deployment with no api_base is keyed by its model string, and the health row rebuilds the same key',
);
check(
  latencySweep.page.apiBases.length === 1 &&
    latencySweep.page.apiBases[0] === 'https://nocturne-weu.openai.azure.com/',
  'all_api_bases is merged across the sweep and kept as evidence beside the readings',
);

const nullBody = await withProxy(
  replier({ '/model/metrics': { status: 200, body: null } }),
  async (proxy) => client(proxy.baseUrl).fetchModelLatency(LAT_FROM, LAT_TO, ['azure/gpt-4o']),
);
check(
  nullBody.available && nullBody.rows.length === 0,
  'a bare null body is the proxy saying "nothing matched" — available, with no readings',
);

const latencyEmpty = await withProxy(
  replier({ '/model/metrics': { status: 200, body: { data: [], all_api_bases: [] } } }),
  async (proxy) => client(proxy.baseUrl).fetchModelLatency(LAT_FROM, LAT_TO, ['azure/gpt-4o']),
);
check(
  latencyEmpty.available && latencyEmpty.rows.length === 0,
  'and so is an empty envelope — neither is a refusal',
);

const latencyNoAliases = await withProxy(
  replier({ '/model/metrics': { status: 200, body: { data: [], all_api_bases: [] } } }),
  async (proxy) => {
    const page = await client(proxy.baseUrl).fetchModelLatency(LAT_FROM, LAT_TO, []);
    return { page, calls: proxy.calls.length };
  },
);
check(
  latencyNoAliases.calls === 0 && latencyNoAliases.page.available,
  'no aliases fetches nothing rather than everything, exactly as on the exception sweep',
);

for (const status of [401, 403, 404, 405, 501]) {
  const refused = await withProxy(
    replier({ '/model/metrics': { status, body: { detail: 'no' } } }),
    async (proxy) => {
      const page = await client(proxy.baseUrl).fetchModelLatency(LAT_FROM, LAT_TO, [
        'azure/gpt-4o',
        'bedrock/claude',
      ]);
      return { page, calls: proxy.calls.length };
    },
  );
  check(
    !refused.page.available && refused.page.rows.length === 0 && refused.calls === 1,
    `${status} stands the latency sweep down after one call — disable_spend_logs empties this route too`,
  );
}

let latencyThrew = false;
try {
  await withProxy(
    replier({ '/model/metrics': { status: 200, body: { data: 'not a list' } } }),
    async (proxy) => client(proxy.baseUrl).fetchModelLatency(LAT_FROM, LAT_TO, ['azure/gpt-4o']),
  );
} catch (error) {
  latencyThrew = String(error).includes('unexpected shape');
}
check(latencyThrew, 'a malformed envelope throws rather than reporting a fast gateway');

// ----------------------------------- GET /model/metrics/slow_responses
//
// The ninth envelope and the plainest one: the handler returns Prisma's rows
// unwrapped, so the body is a bare array of `{api_base, total_count,
// slow_count}` — or `null` when the query matched nothing, exactly like
// `/model/metrics`. Four things it does that no sibling does: it groups on
// `api_base` *alone* (no fallback to a model string, so every deployment
// without a URL is one bucket), it carries its own denominator beside the
// count, its counts come from `COUNT(*)`/`SUM(...)` and may therefore arrive as
// strings, and the threshold that decides what "slow" means is the proxy's
// `alerting_threshold` and is nowhere in the response.

const SLOW_FROM = '2026-06-01';
const SLOW_TO = '2026-06-30';

const slowRows: Record<string, unknown[]> = {
  'azure/gpt-4o': [
    { api_base: 'https://nocturne-weu.openai.azure.com/', total_count: 40_000, slow_count: 84 },
    // A bigint handed back as a string by the driver: ordinary, not malformed.
    { api_base: 'https://nocturne-neu-ptu.openai.azure.com/', total_count: '20000', slow_count: '520' },
    // The proxy coalesces a null base to "" before answering; both shapes are
    // the unnamed bucket and neither is a broken row.
    { api_base: null, total_count: 900, slow_count: 3 },
    // No denominator, so no reading: this layer's only denominator is this one.
    { api_base: 'https://nocturne-eus.openai.azure.com/', total_count: null, slow_count: 12 },
    // More hangs than rows cannot happen upstream; clamped rather than trusted.
    { api_base: 'https://nocturne-sea.openai.azure.com/', total_count: 10, slow_count: 99 },
  ],
  'bedrock/claude': [
    // The path the proxy takes when the deployment has a URL with /openai/ in
    // it — the cut is applied upstream and again here, so a fixture that skips
    // it still lands on the same key.
    { api_base: 'https://x.openai.azure.com/openai/deployments/gpt-4o', total_count: 5_000, slow_count: 9 },
  ],
};

const slowSweep = await withProxy(
  (captured) =>
    captured.path === '/model/metrics/slow_responses'
      ? { status: 200, body: slowRows[captured.query.get('_selected_model_group') ?? ''] ?? [] }
      : { status: 404, body: { detail: 'unknown route' } },
  async (proxy) => {
    const page = await client(proxy.baseUrl).fetchModelSlowResponses(SLOW_FROM, SLOW_TO, [
      'azure/gpt-4o',
      'bedrock/claude',
    ]);
    return { page, calls: [...proxy.calls] };
  },
);

check(
  slowSweep.calls.length === 2 &&
    slowSweep.calls.every((call) => call.path === '/model/metrics/slow_responses'),
  `one call per alias — the third route with a model_group filter and no wildcard (${slowSweep.calls.length})`,
);
check(
  slowSweep.calls[0]?.query.get('_selected_model_group') === 'azure/gpt-4o' &&
    slowSweep.calls[1]?.query.get('_selected_model_group') === 'bedrock/claude',
  'every call names its model group here too — the "gpt-4-32k" default is the same trap on this route',
);
check(
  slowSweep.calls[0]?.query.get('startTime') === `${SLOW_FROM}T00:00:00` &&
    slowSweep.calls[0]?.query.get('endTime') === `${SLOW_TO}T23:59:59`,
  'the window is sent as datetimes, ending at the end of the last day',
);

const weuSlow = slowSweep.page.rows.find(
  (row) => row.key === 'https://nocturne-weu.openai.azure.com/',
);
check(
  slowSweep.page.available && weuSlow?.total === 40_000 && weuSlow?.slow === 84,
  'a bare array is the envelope — the counts come off the row with no wrapper to reach through',
);
check(
  weuSlow?.model === 'azure/gpt-4o',
  'the alias comes from the query, since the row carries an api_base and two counts and nothing else',
);
const ptuSlow = slowSweep.page.rows.find(
  (row) => row.key === 'https://nocturne-neu-ptu.openai.azure.com/',
);
check(
  ptuSlow?.total === 20_000 && ptuSlow?.slow === 520,
  'a count handed back as a string is read as the bigint it is, not dropped as a wrong type',
);
const unnamedSlow = slowSweep.page.rows.find((row) => row.key === UNKEYED_DEPLOYMENT);
check(
  unnamedSlow?.total === 900 && unnamedSlow.slow === 3,
  'a null api_base is the unnamed bucket, with a name rather than a blank key',
);
check(
  !slowSweep.page.rows.some((row) => row.key.includes('eus')),
  'a row with no total is dropped — the total is this layer\'s only denominator and may not be zero-filled',
);
check(
  slowSweep.page.rows.find((row) => row.key.includes('sea'))?.slow === 10,
  'and a slow count past the total is clamped to it, since the SQL cannot produce one',
);
check(
  slowSweep.page.rows.some((row) => row.key === 'https://x.openai.azure.com') &&
    slowResponseDeploymentKey('https://x.openai.azure.com/openai/deployments/gpt-4o') ===
      'https://x.openai.azure.com',
  'the /openai/ cut lands on the same key the health row rebuilds — the join runs one way only',
);

const slowNull = await withProxy(
  replier({ '/model/metrics/slow_responses': { status: 200, body: null } }),
  async (proxy) => client(proxy.baseUrl).fetchModelSlowResponses(SLOW_FROM, SLOW_TO, ['azure/gpt-4o']),
);
check(
  slowNull.available && slowNull.rows.length === 0,
  'a bare null body is "nothing matched" on this route too — available, with no rows',
);

const slowEmpty = await withProxy(
  replier({ '/model/metrics/slow_responses': { status: 200, body: [] } }),
  async (proxy) => client(proxy.baseUrl).fetchModelSlowResponses(SLOW_FROM, SLOW_TO, ['azure/gpt-4o']),
);
check(
  slowEmpty.available && slowEmpty.rows.length === 0,
  'and so is an empty array — neither is a refusal, and neither means nothing hung',
);

const slowNoAliases = await withProxy(
  replier({ '/model/metrics/slow_responses': { status: 200, body: [] } }),
  async (proxy) => {
    const page = await client(proxy.baseUrl).fetchModelSlowResponses(SLOW_FROM, SLOW_TO, []);
    return { page, calls: proxy.calls.length };
  },
);
check(
  slowNoAliases.calls === 0 && slowNoAliases.page.available,
  'no aliases fetches nothing rather than everything, exactly as on the other two sweeps',
);

for (const status of [401, 403, 404, 405, 501]) {
  const refused = await withProxy(
    replier({ '/model/metrics/slow_responses': { status, body: { detail: 'no' } } }),
    async (proxy) => {
      const page = await client(proxy.baseUrl).fetchModelSlowResponses(SLOW_FROM, SLOW_TO, [
        'azure/gpt-4o',
        'bedrock/claude',
      ]);
      return { page, calls: proxy.calls.length };
    },
  );
  check(
    !refused.page.available && refused.page.rows.length === 0 && refused.calls === 1,
    `${status} stands the slow-response sweep down after one call — this route reads the request log too`,
  );
}

let slowThrew = false;
try {
  await withProxy(
    replier({ '/model/metrics/slow_responses': { status: 200, body: { data: [] } } }),
    async (proxy) =>
      client(proxy.baseUrl).fetchModelSlowResponses(SLOW_FROM, SLOW_TO, ['azure/gpt-4o']),
  );
} catch (error) {
  slowThrew = String(error).includes('unexpected shape');
}
check(
  slowThrew,
  'an enveloped body throws rather than reading as empty — this route answers a bare array and only that',
);

// -------------------------------------------------------------------- done

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('litellm contract: all checks passed');
