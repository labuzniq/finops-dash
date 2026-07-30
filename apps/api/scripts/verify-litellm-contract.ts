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

// -------------------------------------------------------------------- done

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('litellm contract: all checks passed');
