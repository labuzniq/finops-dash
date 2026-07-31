/**
 * Ad-hoc check of the web app's adoption derivations against a real mock-source
 * payload. Not a test suite (the repo has none) — run it by hand:
 *
 *   set -a; . ./.env; set +a; \
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-adoption.ts
 *
 * It sits outside apps/api's tsconfig `include` on purpose: it imports the web
 * app's metrics modules, which do not belong in the API's build.
 *
 * What it proves:
 *
 * - the per-user rows reconcile — every row's spend, requests and tokens sum
 *   back to the attributed totals, and the attributed totals never exceed the
 *   gateway's, which is the bound that makes `coverage` a share rather than a
 *   ratio of two unrelated numbers;
 * - the two denominators stay separate: a row's `share` is gateway-wide while
 *   `shareOfAttributed` is the distribution's own, and the second sums to 1
 *   across the table while the first sums to coverage;
 * - the cumulative column is monotone, ends at 1, and the concentration counts
 *   are read off it, so the "9 users are 80% of the bill" sentence and the table
 *   under it can never disagree;
 * - daily actives are a real per-day distinct count bounded by the window's
 *   population, and a user only counts as active on a day it actually called;
 * - the mock's planted shapes are picked up: a skewed roster (the head of a key's
 *   user list carries far more than its share) and an onboarding ramp that is
 *   date-keyed, so a shorter, more recent window reads a larger population per
 *   key than a longer one does;
 * - the edges behave: a payload with no user rows stands the card down instead
 *   of reporting 0 users of a real bill, a short spine reports no trend and
 *   flags nobody as new, and an empty range derives nothing rather than
 *   dividing by zero.
 */
import { MockGatewayClient } from '../src/gateway/mock.js';
import { nanoToDollars } from '../src/lib/nano.js';
import type { GatewayBreakdownPoint, GatewayDailyPoint, GatewayUsage } from '@dash/shared';
import { deriveGateway } from '../../web/src/lib/metrics/gateway.js';
import { deriveAdoption, hasAdoption } from '../../web/src/lib/metrics/gatewayAdoption.js';

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
const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`);

const from = iso(-(DAYS - 1));
const to = iso(0);
const usage = await pull(from, iso(-1));
const summary = deriveGateway(usage, from, to);
const adoption = deriveAdoption(summary.daily, usage.breakdowns);

console.log(
  `${summary.daily.length}d spine · ${adoption.totalUsers} users · ` +
    `${adoption.meanDailyActive?.toFixed(1) ?? 'n/a'} active/day (peak ${adoption.peakDailyActive}) · ` +
    `coverage ${pct(adoption.coverage)} · top decile ${pct(adoption.concentration.topDecileShare)} · ` +
    `${adoption.concentration.usersForMost} users are 80% of spend`,
);

// ------------------------------------------------------------- reconciliation

check(hasAdoption(adoption), 'the mock produced no user-attributed traffic at all');
check(
  near(
    adoption.users.reduce((sum, row) => sum + row.metrics.spend, 0),
    adoption.attributed.spend,
    1e-6,
  ),
  'the ranked user rows do not sum to the attributed total',
);
for (const field of ['requests', 'totalTokens', 'failedRequests'] as const) {
  check(
    near(
      adoption.users.reduce((sum, row) => sum + row.metrics[field], 0),
      adoption.attributed[field],
      1e-6,
    ),
    `the ranked user rows do not sum to the attributed ${field}`,
  );
  check(
    adoption.attributed[field] <= adoption.totals[field] + 1e-9,
    `attributed ${field} exceeds the gateway total`,
  );
}
check(
  adoption.attributed.spend <= adoption.totals.spend + 1e-6,
  'attributed spend exceeds gateway spend — coverage would read above 100%',
);
check(
  adoption.coverage !== null && adoption.coverage > 0.99 && adoption.coverage <= 1 + 1e-9,
  `the mock tags every call with a user, so coverage should be ~100% (got ${pct(adoption.coverage)})`,
);

// ------------------------------------------------------------ two denominators

check(
  near(
    adoption.users.reduce((sum, row) => sum + row.shareOfAttributed, 0),
    1,
    1e-6,
  ),
  'shares of attributed spend do not sum to 1',
);
check(
  near(
    adoption.users.reduce((sum, row) => sum + row.share, 0),
    adoption.coverage ?? 0,
    1e-6,
  ),
  'gateway-wide user shares do not sum to coverage',
);
check(
  adoption.users.every(
    (row) => row.share <= row.shareOfAttributed + 1e-9,
  ),
  'a gateway-wide share exceeded its share of the attributed subset',
);

// --------------------------------------------------------------- the ranking

check(
  adoption.users.every(
    (row, index) => index === 0 || row.metrics.spend <= (adoption.users[index - 1]?.metrics.spend ?? 0) + 1e-9,
  ),
  'the user table is not ranked by spend',
);
check(
  adoption.users.every(
    (row, index) => index === 0 || row.cumulativeShare >= (adoption.users[index - 1]?.cumulativeShare ?? 0) - 1e-9,
  ),
  'the cumulative share column is not monotone',
);
check(
  near(adoption.users[adoption.users.length - 1]?.cumulativeShare ?? 0, 1, 1e-6),
  'the cumulative share column does not end at 100%',
);

// The concentration counts must be readable straight off the table, or the
// sentence the card writes and the rows under it are two different claims.
const { usersForHalf, usersForMost, topDecileShare, topUserShare } = adoption.concentration;
check(usersForHalf !== null && usersForMost !== null, 'concentration counts missing on a live payload');
check(
  usersForHalf !== null && usersForMost !== null && usersForHalf <= usersForMost,
  'fewer users cover 80% than cover 50%',
);
check(
  usersForHalf !== null &&
    (adoption.users[usersForHalf - 1]?.cumulativeShare ?? 0) >= 0.5 - 1e-9 &&
    (usersForHalf === 1 || (adoption.users[usersForHalf - 2]?.cumulativeShare ?? 0) < 0.5),
  'usersForHalf is not the smallest count reaching 50%',
);
check(
  usersForMost !== null &&
    (adoption.users[usersForMost - 1]?.cumulativeShare ?? 0) >= 0.8 - 1e-9 &&
    (usersForMost === 1 || (adoption.users[usersForMost - 2]?.cumulativeShare ?? 0) < 0.8),
  'usersForMost is not the smallest count reaching 80%',
);
check(
  near(topUserShare ?? -1, adoption.users[0]?.shareOfAttributed ?? -2, 1e-9),
  'the top-user share disagrees with the first row of the table',
);
const decile = Math.max(1, Math.ceil(adoption.totalUsers / 10));
check(
  near(topDecileShare ?? -1, adoption.users[decile - 1]?.cumulativeShare ?? -2, 1e-9),
  'the top-decile share is not the cumulative share at the decile boundary',
);

// ----------------------------------------------------------- daily actives

check(
  adoption.daily.length === summary.daily.length &&
    adoption.daily.every((day, index) => day.date === summary.daily[index]?.date),
  'the adoption day strip is not on the page spine',
);
check(
  adoption.daily.every((day) => day.activeUsers <= adoption.totalUsers),
  'a day reported more active users than the window has users at all',
);
check(
  adoption.daily.every((day) => day.attributedSpend <= day.spend + 1e-9),
  'a day attributed more spend to users than the gateway spent',
);
check(
  adoption.daily.every(
    (day) =>
      (day.spendPerActiveUser === null) === (day.activeUsers === 0) &&
      (day.spendPerActiveUser === null ||
        near(day.spendPerActiveUser * day.activeUsers, day.attributedSpend, 1e-6)),
  ),
  'spend per active user does not multiply back to the day it came from',
);
check(adoption.peakDailyActive >= (adoption.meanDailyActive ?? 0), 'peak actives below the mean');
check(
  adoption.stickiness !== null && adoption.stickiness > 0 && adoption.stickiness <= 1 + 1e-9,
  'daily reach fell outside 0..1',
);

// A user counted as active must have actually called that day: the derivation
// filters on requests, so an all-failure row still counts (a rejected call is a
// call) but a row with no requests at all does not.
const spineDates = new Set(summary.daily.map((day) => day.date));
const activeFromPayload = new Map<string, Set<string>>();
for (const point of usage.breakdowns) {
  if (point.dimension !== 'user' || !spineDates.has(point.date) || point.requests === 0) continue;
  const bucket = activeFromPayload.get(point.date) ?? new Set<string>();
  bucket.add(point.key);
  activeFromPayload.set(point.date, bucket);
}
check(
  adoption.daily.every(
    (day) => day.activeUsers === (activeFromPayload.get(day.date)?.size ?? 0),
  ),
  'a daily active count disagrees with the distinct user keys in the payload',
);

// -------------------------------------------------------------- planted shape

// The roster pick is skewed, so the heaviest user must carry far more than an
// even split of the population would give them.
const evenShare = 1 / adoption.totalUsers;
check(
  (topUserShare ?? 0) > evenShare * 2,
  `the heaviest user carries ${pct(topUserShare)}, no more than twice an even ${pct(evenShare)} split — the long tail is missing`,
);
check(
  adoption.totalUsers >= 20,
  `only ${adoption.totalUsers} users in a ${DAYS}-day window — the roster is too small for a concentration read`,
);

// The onboarding ramp, read within one pull. Comparing two *pulls* would not
// work here: the mock's Lehmer stream is consumed from the window start, so the
// same calendar day draws different users in a 20-day pull and a 60-day one,
// and only the date-keyed *structure* (how much of each roster is onboarded,
// how skewed the pick is) is stable across windows. Equal-length halves of the
// same pull compare equal numbers of draws against a growing population, which
// is exactly the ramp and nothing else.
const halfIndex = Math.floor(summary.daily.length / 2);
const populationOf = (days: readonly { date: string }[]): number => {
  const dates = new Set(days.map((day) => day.date));
  return new Set(
    usage.breakdowns
      .filter((point) => point.dimension === 'user' && dates.has(point.date) && point.requests > 0)
      .map((point) => point.key),
  ).size;
};
const firstHalfPopulation = populationOf(summary.daily.slice(halfIndex - 20, halfIndex));
const secondHalfPopulation = populationOf(summary.daily.slice(summary.daily.length - 20));
console.log(
  `population over 20d windows · earlier ${firstHalfPopulation} · latest ${secondHalfPopulation} · ` +
    `${adoption.newUsers} first seen in the second half`,
);
check(
  secondHalfPopulation > firstHalfPopulation,
  `the population did not grow (${firstHalfPopulation} → ${secondHalfPopulation}) — the onboarding ramp is missing`,
);
check(adoption.newUsers > 0, 'the ramp onboarded nobody in the second half of the window');
check(
  adoption.trend !== null && adoption.trend.deltaUsers !== null,
  'a 59-day spine reported no half-over-half trend',
);
check(
  adoption.users.every((row) => !row.isNew || row.firstSeen >= (summary.daily[Math.floor(summary.daily.length / 2)]?.date ?? '')),
  'a user flagged new was first seen in the first half of the window',
);

// ---------------------------------------------------------------- the edges

const noUsers = deriveAdoption(
  summary.daily,
  usage.breakdowns.filter((point) => point.dimension !== 'user'),
);
check(!hasAdoption(noUsers), 'a payload with no user rows still rendered the card');
check(
  noUsers.coverage === 0 && noUsers.totalUsers === 0 && noUsers.concentration.usersForHalf === null,
  'a payload with no user rows did not read as zero coverage and no distribution',
);

const shortSpine = summary.daily.slice(0, 4);
const short = deriveAdoption(shortSpine, usage.breakdowns);
check(short.trend === null, 'a 4-day spine reported a half-over-half trend');
check(short.newUsers === 0, 'a 4-day spine flagged users as new');
check(
  short.daily.length === 4 && short.users.every((row) => row.activeDays <= 4),
  'a short spine leaked rows from days it does not cover',
);

const empty = deriveAdoption([], usage.breakdowns);
check(
  empty.totalUsers === 0 &&
    empty.coverage === null &&
    empty.meanDailyActive === null &&
    empty.stickiness === null &&
    empty.spendPerUser === null,
  'an empty spine derived something out of nothing',
);

// -------------------------------------------------------------------- report

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('\nall adoption checks passed');
