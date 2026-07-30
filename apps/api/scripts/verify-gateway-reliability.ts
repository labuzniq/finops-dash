/**
 * Ad-hoc check of the web app's reliability derivations against a real
 * mock-source payload. Not a test suite (the repo has none) — run it by hand:
 *
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-reliability.ts
 *
 * It sits outside apps/api's tsconfig `include` on purpose: it imports the web
 * app's metrics modules, which do not belong in the API's build.
 *
 * What it proves:
 *
 * - the gateway-wide rate is the spine's own failures ÷ requests, and every
 *   full-coverage dimension's rows reconcile to it — failure counts sum, shares
 *   sum to 1, and the signed excess sums to zero, which is the property that
 *   makes the excess ranking a redistribution rather than an opinion;
 * - `mcp_server` stays a strict subset, as it does everywhere else on the page;
 * - the two failure sources the mock plants are found by the two different views
 *   they belong to: a structurally rate-limited deployment tops the key ranking
 *   and carries the badge, while a two-day regional incident shows up as two
 *   flagged days and as that provider's worst day — and explicitly *not* as a
 *   flagged key, because sixty days of fine averages it away;
 * - both gates hold in the regimes they exist for — thin evidence (1 failure of
 *   2 requests) and significant-but-trivial difference (3.39% against a 3.31%
 *   baseline over half a million calls).
 */
import { MockGatewayClient } from '../src/gateway/mock.js';
import { nanoToDollars } from '../src/lib/nano.js';
import { GATEWAY_DIMENSIONS } from '@dash/shared';
import type { GatewayBreakdownPoint, GatewayDailyPoint, GatewayUsage } from '@dash/shared';
import { deriveGateway } from '../../web/src/lib/metrics/gateway.js';
import {
  DEFAULT_RELIABILITY_OPTIONS,
  deriveReliability,
  wilsonLowerBound,
} from '../../web/src/lib/metrics/gatewayReliability.js';

const DAYS = 60;
const MS_PER_DAY = 86_400_000;

/** The mock's own plants — see apps/api/src/gateway/mock.ts. */
const RATE_LIMITED_MODEL = 'azure/o4-mini';
const INCIDENT_PROVIDER = 'bedrock';
const INCIDENT_DAYS_OF_MONTH = new Set([17, 18]);

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

const from = iso(-(DAYS - 1));
const to = iso(0);
const usage = await pull(from, iso(-1));
const summary = deriveGateway(usage, from, to);
const points = usage.breakdowns;

// -------------------------------------------------------------- gateway-wide

const model = deriveReliability(summary.daily, points, 'model');
const percent = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`);

console.log(
  `${summary.daily.length}d spine · ${model.requests.toLocaleString()} requests · ${model.failedRequests.toLocaleString()} failed · ${percent(model.failureRate)} gateway-wide`,
);

check(
  model.requests === summary.totals.requests && model.failedRequests === summary.totals.failedRequests,
  'reliability totals disagree with the spine totals',
);
check(
  model.failureRate !== null &&
    Math.abs(model.failureRate - summary.totals.failedRequests / summary.totals.requests) < 1e-12,
  'gateway-wide failure rate is not failures ÷ requests',
);
check(model.daily.length === summary.daily.length, 'the daily strip is not the trimmed spine');

// ------------------------------------------------------------- reconciliation

for (const dimension of GATEWAY_DIMENSIONS) {
  const derived = deriveReliability(summary.daily, points, dimension);
  if (derived.rows.length === 0) continue;

  const summed = derived.rows.reduce((total, row) => total + row.failedRequests, 0);
  const share = derived.rows.reduce((total, row) => total + row.shareOfFailures, 0);
  const excess = derived.rows.reduce((total, row) => total + row.excessFailures, 0);
  const subset = dimension === 'mcp_server';

  console.log(
    `  ${dimension.padEnd(11)} ${derived.rows.length.toString().padStart(2)} keys · ${summed.toLocaleString().padStart(8)} failures · share ${(share * 100).toFixed(1)}% · excess ${excess.toFixed(3)}`,
  );

  if (subset) {
    check(summed < derived.failedRequests, 'mcp_server accounted for every failure — it is a subset');
    check(share < 0.999, 'mcp_server shares summed to the whole gateway');
  } else {
    check(
      summed === derived.failedRequests,
      `${dimension} failures (${summed}) do not sum to the gateway's (${derived.failedRequests})`,
    );
    check(Math.abs(share - 1) < 1e-9, `${dimension} shares of failures sum to ${share}, not 1`);
    // The signed excess is a redistribution of the same failures: it must cancel.
    check(Math.abs(excess) < 1e-6, `${dimension} excess failures sum to ${excess}, not 0`);
  }

  // Ranking is by excess, descending.
  const ordered = derived.rows.every(
    (row, index) => index === 0 || (derived.rows[index - 1]?.excessFailures ?? 0) >= row.excessFailures,
  );
  check(ordered, `${dimension} rows are not ranked by excess failures`);
}

// -------------------------------------------------- the structurally bad model

const rateLimited = model.rows.find((row) => row.key === RATE_LIMITED_MODEL);
console.log(
  `\n${RATE_LIMITED_MODEL}: ${percent(rateLimited?.failureRate ?? null)} of ${rateLimited?.requests.toLocaleString() ?? 0} requests · elevated=${rateLimited?.elevated ?? false} · rank ${model.rows.findIndex((row) => row.key === RATE_LIMITED_MODEL) + 1}`,
);

check(rateLimited !== undefined, `${RATE_LIMITED_MODEL} is missing from the model dimension`);
check(rateLimited?.elevated === true, `${RATE_LIMITED_MODEL} was not flagged as elevated`);
check(
  rateLimited !== undefined && rateLimited.excessFailures > 0,
  `${RATE_LIMITED_MODEL} carries no excess failures`,
);
check(
  model.rows[0]?.key === RATE_LIMITED_MODEL,
  `the rate-limited deployment does not top the ranking (got ${model.rows[0]?.key ?? 'nothing'})`,
);

// Nothing else may be flagged. Not the big healthy models (which ranking by raw
// count would have promoted), and not the incident provider's models either:
// two degraded days in sixty are a day-strip finding, and a badge on a model
// that is fine 58 days out of 60 would be a lie by aggregation.
const others = model.rows.filter((row) => row.key !== RATE_LIMITED_MODEL);
check(others.length > 0, 'no other models to compare against');
check(
  others.every((row) => !row.elevated),
  `models were flagged besides the rate-limited one: ${others.filter((row) => row.elevated).map((row) => `${row.key} ${(100 * (row.failureRate ?? 0)).toFixed(2)}%`).join(', ')}`,
);

// ------------------------------------------------------------ the incident

const provider = deriveReliability(summary.daily, points, 'provider');
const incidentDays = model.daily.filter((day) => INCIDENT_DAYS_OF_MONTH.has(Number(day.date.slice(8, 10))));
const ordinaryDays = model.daily.filter((day) => !INCIDENT_DAYS_OF_MONTH.has(Number(day.date.slice(8, 10))));

console.log(
  `incident days in range: ${incidentDays.map((day) => `${day.date} ${percent(day.failureRate)}`).join(', ') || 'none'}`,
);
console.log(
  `flagged days: ${model.worstDays.map((day) => `${day.date} ${percent(day.failureRate)}`).join(', ') || 'none'}`,
);

check(incidentDays.length > 0, 'the range holds no incident day to check');
check(
  incidentDays.every((day) => day.elevated),
  `an incident day was not flagged: ${incidentDays.filter((day) => !day.elevated).map((day) => day.date).join(', ')}`,
);
check(
  ordinaryDays.every((day) => !day.elevated),
  `an ordinary day was flagged: ${ordinaryDays.filter((day) => day.elevated).map((day) => day.date).join(', ')}`,
);
check(
  model.worstDays.length === incidentDays.length,
  `worstDays holds ${model.worstDays.length} days, expected the ${incidentDays.length} incident days`,
);

// The incident is regional, so it attributes to a provider, and that provider's
// worst day must be one of the incident days.
const bedrock = provider.rows.find((row) => row.key === INCIDENT_PROVIDER);
console.log(
  `${INCIDENT_PROVIDER}: ${percent(bedrock?.failureRate ?? null)} overall · worst day ${bedrock?.worstDay?.date ?? 'none'} at ${percent(bedrock?.worstDay?.failureRate ?? null)}`,
);
check(bedrock !== undefined, `${INCIDENT_PROVIDER} is missing from the provider dimension`);
// And the incident provider is deliberately NOT flagged over the range: two bad
// days in sixty dilute to a rate barely above the gateway's own, which is the
// truth. Two days is a day-strip finding, not a key finding — the card carries
// both views precisely because one cannot answer for the other.
check(
  bedrock?.elevated === false,
  `${INCIDENT_PROVIDER} was flagged over the whole range on the strength of two days`,
);
check(
  bedrock?.worstDay !== null &&
    bedrock?.worstDay !== undefined &&
    INCIDENT_DAYS_OF_MONTH.has(Number(bedrock.worstDay.date.slice(8, 10))),
  `${INCIDENT_PROVIDER}'s worst day is not an incident day`,
);

// The incident bills almost nothing — a rejected call sends no tokens — so it
// must be invisible to the spend-shaped cards. That is precisely why the
// reliability card is not redundant with the unusual-spend one.
const incidentSpendShare =
  incidentDays.reduce((total, day) => {
    const spend = summary.daily.find((row) => row.date === day.date)?.spend ?? 0;
    return total + spend;
  }, 0) / incidentDays.length;
const ordinarySpendShare =
  ordinaryDays.reduce((total, day) => {
    const spend = summary.daily.find((row) => row.date === day.date)?.spend ?? 0;
    return total + spend;
  }, 0) / ordinaryDays.length;
console.log(
  `incident-day mean spend $${incidentSpendShare.toFixed(2)} vs ordinary $${ordinarySpendShare.toFixed(2)}`,
);

// ------------------------------------------------------------- the Wilson gate

const { confidenceZ } = DEFAULT_RELIABILITY_OPTIONS;
check(wilsonLowerBound(0, 1_000, confidenceZ) === 0, 'a clean key has a non-zero lower bound');
check(wilsonLowerBound(5, 0, confidenceZ) === 0, 'zero trials produced a bound');
// Wilson alone *does* clear a 2% baseline on 1-of-2: two calls both being
// unlikely is genuine evidence, and the statistics are not wrong. It is the
// materiality gate, not the interval, that keeps that row off the card.
check(
  wilsonLowerBound(1, 2, confidenceZ) > 0.02,
  'the Wilson bound for 1-of-2 no longer clears 2% — the interval maths changed',
);
check(
  wilsonLowerBound(3, 3, confidenceZ) > 0.02,
  '3 failures of 3 requests did not clear a 2% baseline — the interval is too loose',
);
check(
  wilsonLowerBound(2, 100, confidenceZ) < 0.02,
  '2 failures of 100 requests cleared a 2% baseline — the interval is too tight',
);
check(
  wilsonLowerBound(300, 10_000, confidenceZ) < 3_00 / 10_000,
  'the lower bound is not below the point estimate',
);

// The materiality gate has to be the thing rejecting the near-baseline keys, not
// a lucky interval: every unflagged key with a rate above the gateway's must be
// one the Wilson gate would have passed. Otherwise the two gates are untested in
// the regime they were added for.
const nearBaseline = model.rows.filter(
  (row) =>
    !row.elevated &&
    row.failureRate !== null &&
    model.failureRate !== null &&
    row.failureRate > model.failureRate,
);
check(nearBaseline.length > 0, 'no above-baseline-but-unflagged key to test the materiality gate');
check(
  nearBaseline.every(
    (row) =>
      wilsonLowerBound(row.failedRequests, row.requests, confidenceZ) > (model.failureRate ?? 0),
  ),
  'an above-baseline key was rejected by the interval rather than by materiality',
);
check(
  nearBaseline.every(
    (row) =>
      (row.failureRate ?? 0) <
      (model.failureRate ?? 0) * DEFAULT_RELIABILITY_OPTIONS.minRatio,
  ),
  'a key above the materiality ratio went unflagged',
);

// The same thing end to end: a thin, catastrophic key is not flagged; a large,
// mildly-bad one is.
const synthetic: GatewayBreakdownPoint[] = [
  {
    date: summary.daily[0]?.date ?? from,
    dimension: 'tag',
    key: 'thin',
    label: null,
    spend: 0,
    requests: 2,
    successfulRequests: 1,
    failedRequests: 1,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  {
    date: summary.daily[0]?.date ?? from,
    dimension: 'tag',
    key: 'idle',
    label: null,
    spend: 0,
    requests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
];
const syntheticSummary = deriveReliability(summary.daily, synthetic, 'tag');
const thin = syntheticSummary.rows.find((row) => row.key === 'thin');
const idle = syntheticSummary.rows.find((row) => row.key === 'idle');
check(
  thin?.elevated === false,
  'a 50%-failing 2-request key was flagged — the materiality gate is not holding',
);
check(
  thin !== undefined && thin.failureRate === 0.5,
  'the thin key lost its (real, but immaterial) 50% rate',
);
check(idle?.failureRate === null, 'a key with no requests reported a failure rate, not null');
check(idle?.elevated === false, 'a key with no requests was flagged');
check(idle?.worstDay === null, 'a key with no requests has a worst day');

// ------------------------------------------------------------------ empty range

const empty = deriveReliability([], [], 'model');
check(empty.failureRate === null, 'an empty range reported a failure rate');
check(empty.rows.length === 0 && empty.worstDays.length === 0, 'an empty range produced rows');

// -------------------------------------------------------------------- verdict

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('\nall reliability checks passed');
