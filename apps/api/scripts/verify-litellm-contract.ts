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
  parseBudgetDuration,
  summarizeGatewayProbe,
} from '@dash/shared';
import type { GatewayBudget, GatewayProbeRoute } from '@dash/shared';
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
    captured.path === '/tag/list'
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
// 7 · Budget arithmetic in @dash/shared
// =====================================================================
//
// These are pure and the UI will run on them, but they interpret LiteLLM's own
// duration grammar, so they belong next to the client that reads those fields.

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
  }),
  async (proxy) => ({ routes: await client(proxy.baseUrl).probe(DAY), calls: proxy.calls }),
);

const route = (path: string): GatewayProbeRoute | undefined =>
  healthy.routes.find((candidate) => candidate.path === path);

check(healthy.calls.length === 6, `one call per route, no retries (${healthy.calls.length})`);
check(
  healthy.calls.map((call) => call.path).join(' ') ===
    '/user/daily/activity /team/daily/activity /tag/daily/activity /key/list /team/list /tag/list',
  'routes are probed in dependency order, activity before management',
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
  }),
  async (proxy) => ({ routes: await client(proxy.baseUrl).probe(DAY), calls: proxy.calls }),
);

const restrictedRoute = (path: string): GatewayProbeRoute | undefined =>
  restricted.routes.find((candidate) => candidate.path === path);

check(
  restricted.calls.length === 6,
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
  restrictedSummary.warnings.length === 6,
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
// Only /user answers here, so the other four routes 404 and warn as absent —
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

// -------------------------------------------------------------------- done

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('litellm contract: all checks passed');
