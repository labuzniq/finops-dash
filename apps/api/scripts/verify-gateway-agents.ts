/**
 * Ad-hoc check of the web app's agent-traffic derivations against a real
 * mock-source payload. Not a test suite (the repo has none) — run it by hand:
 *
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-agents.ts
 *
 * It sits outside apps/api's tsconfig `include` on purpose: it imports the web
 * app's metrics modules, which do not belong in the API's build.
 *
 * What it proves:
 *
 * - the split is a real partition — attributed + remainder reproduces the
 *   gateway totals to the cent on every counter, which is the whole licence for
 *   subtracting one dimension from the totals at all, and it only holds because
 *   `mcp_server` is a strict subset rather than a peer slice;
 * - the subset invariant holds day by day, not merely in aggregate: no day
 *   attributes more spend, requests or tokens than the gateway saw, so the
 *   clamp never fires and `inconsistentDays` stays empty;
 * - the per-server rows reconcile to the attributed total, and their two share
 *   columns use the two denominators they claim to (agent spend, gateway spend);
 * - unit economics are computed over comparable slices — the mock scales every
 *   counter of an MCP row by the same share, so tokens-per-call is a property of
 *   the workload rather than an artefact of scaling spend but not tokens;
 * - the adoption ramp the mock plants is picked up by the half-over-half trend,
 *   and it is date-keyed, so the same calendar day reads the same share in a
 *   30-day pull and a 90-day one;
 * - the edges behave: a gateway with no MCP rows stands the card down instead of
 *   claiming 0% agents, a short spine reports no trend rather than a noisy one,
 *   and an over-attributing proxy is clamped *and* reported.
 */
import { MockGatewayClient } from '../src/gateway/mock.js';
import { nanoToDollars } from '../src/lib/nano.js';
import { EMPTY_GATEWAY_METRICS } from '@dash/shared';
import type { GatewayBreakdownPoint, GatewayDailyPoint, GatewayUsage } from '@dash/shared';
import { deriveGateway } from '../../web/src/lib/metrics/gateway.js';
import { deriveAgentTraffic, hasAgentTraffic } from '../../web/src/lib/metrics/gatewayAgents.js';

const DAYS = 60;
const MS_PER_DAY = 86_400_000;

function iso(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
}

const client = new MockGatewayClient();

async function pull(from: string, to: string): Promise<GatewayUsage> {
  const snapshot = await client.fetchUsage(from, to);
  return {
    daily: snapshot.daily.map(
      (row): GatewayDailyPoint => ({ ...row, spend: nanoToDollars(row.spendNano) }),
    ),
    breakdowns: snapshot.breakdowns.map(
      (row): GatewayBreakdownPoint => ({ ...row, spend: nanoToDollars(row.spendNano) }),
    ),
  };
}

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};
const near = (a: number, b: number, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
const percent = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`);

const from = iso(-(DAYS - 1));
const to = iso(0);
const usage = await pull(from, iso(-1));
const summary = deriveGateway(usage, from, to);
const agents = deriveAgentTraffic(summary.daily, usage.breakdowns);

console.log(
  `${summary.daily.length}d spine · MCP-attributed ${percent(agents.spendShare)} of spend, ` +
    `${percent(agents.requestShare)} of calls, ${percent(agents.tokenShare)} of tokens · ` +
    `${agents.servers.length} servers`,
);

// ------------------------------------------------------------------ partition

check(hasAgentTraffic(agents), 'the mock produced no MCP traffic at all');
check(
  near(agents.attributed.spend + agents.remainder.spend, summary.totals.spend, 1e-6),
  'attributed + remainder does not reproduce gateway spend',
);
for (const field of Object.keys(EMPTY_GATEWAY_METRICS) as (keyof typeof EMPTY_GATEWAY_METRICS)[]) {
  check(
    near(agents.attributed[field] + agents.remainder[field], summary.totals[field], 1e-6),
    `attributed + remainder does not reproduce gateway ${field}`,
  );
  check(
    agents.attributed[field] <= summary.totals[field] + 1e-9,
    `attributed ${field} exceeds the gateway total — the subset invariant broke`,
  );
}
check(
  near(agents.totals.spend, summary.totals.spend, 1e-9),
  'the agent summary disagrees with the page totals',
);

// -------------------------------------------------------------- day by day

const bySpineDate = new Map(summary.daily.map((day) => [day.date, day]));
check(
  agents.daily.length === summary.daily.length &&
    agents.daily.every((day, index) => day.date === summary.daily[index]?.date),
  'the agent day strip is not on the page spine',
);
check(agents.inconsistentDays.length === 0, 'the mock over-attributed MCP spend on some day');
check(
  agents.daily.every((day) => near(day.totalSpend, bySpineDate.get(day.date)?.spend ?? -1, 1e-9)),
  'a day of the strip disagrees with the spine total it is a share of',
);
check(
  agents.daily.every(
    (day) => day.share === null || (day.share >= 0 && day.share <= 1 + 1e-9),
  ),
  'a daily MCP share fell outside 0..1',
);
check(
  near(
    agents.daily.reduce((sum, day) => sum + day.attributedSpend, 0),
    agents.attributed.spend,
    1e-6,
  ),
  'the daily attributed spend does not sum to the range total',
);

// Breakdown rows outside the trimmed spine must not leak into the totals — that
// is what would push the share above 100% on the day the sync is mid-flight.
const lastSpineDay = summary.daily[summary.daily.length - 1]?.date ?? '';
check(
  usage.breakdowns.some((row) => row.dimension === 'mcp_server' && row.date <= lastSpineDay),
  'no mcp_server rows inside the spine — the rest of this run proves nothing',
);

// ------------------------------------------------------------------- servers

const serverSpend = agents.servers.reduce((sum, row) => sum + row.metrics.spend, 0);
const serverRequests = agents.servers.reduce((sum, row) => sum + row.metrics.requests, 0);
check(near(serverSpend, agents.attributed.spend, 1e-6), 'server rows do not sum to attributed spend');
check(serverRequests === agents.attributed.requests, 'server rows do not sum to attributed calls');
check(
  near(
    agents.servers.reduce((sum, row) => sum + row.shareOfAttributed, 0),
    1,
    1e-6,
  ),
  'shares of agent spend do not sum to 1',
);
check(
  near(
    agents.servers.reduce((sum, row) => sum + row.shareOfGateway, 0),
    agents.spendShare ?? 0,
    1e-6,
  ),
  'shares of gateway spend do not sum to the agent share',
);
check(
  agents.servers.every(
    (row, index) => index === 0 || row.metrics.spend <= (agents.servers[index - 1]?.metrics.spend ?? 0),
  ),
  'server rows are not ranked by spend',
);

// ----------------------------------------------------------- unit economics

const agentPerCall = agents.attributed.spend / agents.attributed.requests;
const restPerCall = agents.remainder.spend / agents.remainder.requests;
const agentTokensPerCall = agents.attributed.totalTokens / agents.attributed.requests;
const restTokensPerCall = agents.remainder.totalTokens / agents.remainder.requests;
console.log(
  `  $/call: agent ${agentPerCall.toFixed(5)} vs rest ${restPerCall.toFixed(5)} · ` +
    `tokens/call: agent ${Math.round(agentTokensPerCall)} vs rest ${Math.round(restTokensPerCall)}`,
);

// The mock plants the asymmetry the card exists to price: an MCP-routed call
// ships tool schemas and results, so it is a *heavier* call than the ones it
// was sliced from. That has to show up as a token share above the call share,
// and as a tokens-per-call ratio above one — while staying in the range a real
// tool turn lives in rather than the 4× artefact that scaling spend without
// scaling tokens would manufacture.
check(
  agents.tokenShare !== null &&
    agents.requestShare !== null &&
    agents.tokenShare > agents.requestShare,
  'MCP traffic carries no more tokens per call than its share of calls — the two scalings collapsed',
);
check(
  agentTokensPerCall / restTokensPerCall > 1 && agentTokensPerCall / restTokensPerCall < 2.5,
  'attributed tokens-per-call is not in the range a tool turn plausibly occupies',
);
check(
  agentPerCall / restPerCall > 1 && agentPerCall / restPerCall < 2.5,
  'attributed cost-per-call is not in the range a tool turn plausibly occupies',
);
// Spend follows tokens, not calls: the same dollars-per-token as the rest of
// the gateway, because an MCP tag changes what a call carries and not what a
// token costs.
const agentPerToken = agents.attributed.spend / agents.attributed.totalTokens;
const restPerToken = agents.remainder.spend / agents.remainder.totalTokens;
console.log(
  `  $/1M tokens: agent ${(agentPerToken * 1e6).toFixed(3)} vs rest ${(restPerToken * 1e6).toFixed(3)}`,
);
check(
  Math.abs(agentPerToken - restPerToken) / restPerToken < 0.05,
  'attributed traffic is priced at a materially different dollars-per-token than the rest',
);

// ---------------------------------------------------------------- adoption

const trend = agents.trend;
check(trend !== null, 'a 59-day spine produced no half-over-half trend');
if (trend !== null) {
  console.log(
    `  adoption: ${percent(trend.firstHalfShare)} over the first ${trend.firstHalfDays}d → ` +
      `${percent(trend.secondHalfShare)} over the last ${trend.secondHalfDays}d ` +
      `(${trend.deltaPoints === null ? 'n/a' : `${trend.deltaPoints >= 0 ? '+' : ''}${trend.deltaPoints.toFixed(2)}`} pts)`,
  );
  check(
    trend.firstHalfDays + trend.secondHalfDays === agents.daily.length,
    'the two halves do not cover the spine',
  );
  check(
    trend.deltaPoints !== null && trend.deltaPoints > 0,
    'the mock ramps MCP adoption month over month, but the trend did not see it rise',
  );
}

// The ramp is keyed on the calendar date, not on an index into the window, so a
// shorter pull must report the same share for the same days. (The mock's Lehmer
// stream is window-dependent, so the two pulls disagree on absolute dollars —
// the assertion is on the *shape*, i.e. that the later half still reads higher.)
const shortFrom = iso(-29);
const shortUsage = await pull(shortFrom, iso(-1));
const shortSummary = deriveGateway(shortUsage, shortFrom, to);
const shortAgents = deriveAgentTraffic(shortSummary.daily, shortUsage.breakdowns);
check(
  shortAgents.trend !== null && (shortAgents.trend.deltaPoints ?? 0) > 0,
  'a 30-day pull did not see the adoption ramp — is it keyed on the window rather than the date?',
);
check(
  shortAgents.spendShare !== null &&
    agents.spendShare !== null &&
    shortAgents.spendShare > agents.spendShare,
  'the most recent 30 days do not carry a higher agent share than the 60-day window',
);

// -------------------------------------------------------------------- edges

const noMcp = deriveAgentTraffic(
  summary.daily,
  usage.breakdowns.filter((row) => row.dimension !== 'mcp_server'),
);
check(!hasAgentTraffic(noMcp), 'a gateway with no MCP rows still claimed agent traffic');
check(
  near(noMcp.remainder.spend, summary.totals.spend, 1e-9) && noMcp.attributed.spend === 0,
  'with no MCP rows the remainder is not the whole gateway',
);
check(noMcp.spendShare === 0, 'with no MCP rows the share is not zero');

const shortSpine = deriveAgentTraffic(summary.daily.slice(0, 4), usage.breakdowns);
check(shortSpine.trend === null, 'a 4-day spine reported a half-over-half trend');

const empty = deriveAgentTraffic([], []);
check(
  empty.spendShare === null && empty.requestShare === null && empty.tokenShare === null,
  'an empty range reported a share instead of null',
);
check(empty.servers.length === 0 && empty.trend === null, 'an empty range produced rows or a trend');

// An over-attributing proxy: one MCP row larger than its own day. The remainder
// clamps at zero rather than going negative, and the day is named.
const [firstDay] = summary.daily;
if (firstDay !== undefined) {
  const over = deriveAgentTraffic(
    [firstDay],
    [
      {
        date: firstDay.date,
        dimension: 'mcp_server',
        key: 'runaway',
        label: null,
        ...EMPTY_GATEWAY_METRICS,
        spend: firstDay.spend * 2,
        requests: firstDay.requests * 2,
      },
    ],
  );
  check(over.remainder.spend === 0, 'an over-attributed day produced a negative remainder');
  check(
    over.inconsistentDays.length === 1 && over.inconsistentDays[0] === firstDay.date,
    'an over-attributed day was not reported',
  );
}

// -------------------------------------------------------------------- verdict

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('\nall agent-traffic checks passed');
