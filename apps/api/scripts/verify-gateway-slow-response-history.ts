/**
 * Invariant check for the *stored* slow-response roll-up — the nightly sweep
 * kept, and the first of the four live gateway reads to get a table.
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-slow-response-history.ts
 *
 * Two halves, for the two things that can be wrong here.
 *
 * The **pure** half drives `summarizeSlowResponseHistory` over constructed
 * readings: the day roll-up (two aliases on one endpoint on one night are two
 * disjoint counts of it and must be added), the per-key roll-up across nights,
 * the two badge gates restated over pooled counts, `excessSlow` summing to zero,
 * the unobserved-day arithmetic (counted forward from `recordingSince`, never
 * filled in), and the half-over-half trend — pooled rather than averaged, split
 * on *observed* days, and reported in percentage points.
 *
 * The **mock** half simulates a run of nightly syncs by asking
 * `MockGatewayClient.fetchModelSlowResponses` for one day at a time, exactly as
 * `readSlowResponses` does, and checks that a sequence says what a single window
 * cannot: the two-day regional incident that averages away over a month is
 * visible as its own nights here, and the refusing reserved pool is the badged
 * key over the accumulated window as it is over one.
 *
 * Like its siblings it sits outside apps/api's tsconfig `include`: a harness,
 * not part of the API build.
 */
import {
  SLOW_RESPONSE_ELEVATED_RATIO,
  SLOW_RESPONSE_MIN_COUNT,
  SLOW_RESPONSE_TREND_MIN_DAYS,
  summarizeSlowResponseHistory,
} from '@dash/shared';
import type {
  GatewaySlowResponseHistory,
  GatewaySlowResponseObservation,
} from '@dash/shared';
import { MockGatewayClient } from '../src/gateway/mock.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
};

const close = (a: number, b: number, epsilon = 1e-9): boolean => Math.abs(a - b) < epsilon;

const observation = (
  date: string,
  model: string,
  key: string,
  total: number,
  slow: number,
): GatewaySlowResponseObservation => ({
  date,
  model,
  key,
  total,
  slow,
  observedAt: `${date}T06:00:00.000Z`,
});

const history = (
  observations: GatewaySlowResponseObservation[],
  from = '2026-07-01',
  to = '2026-07-10',
  recordingSince: string | null = observations[0]?.date ?? null,
): GatewaySlowResponseHistory => ({ from, to, recordingSince, observations });

const shiftIso = (iso: string, days: number): string => {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// ----------------------------------------------------------------- pure half

console.log('\nnothing recorded');

const empty = summarizeSlowResponseHistory(history([], '2026-07-01', '2026-07-10', null));
check(empty.observedDays.length === 0, 'a table nobody has written reports no observed days');
check(empty.share === null, 'and no share — a window with nothing read has no hang rate');
check(
  empty.unobservedDays === 10,
  'every day of the window is unobserved, which is the honest reading of "we have never swept"',
);
check(empty.trend === null, 'and no trend, since a trend needs two halves of evidence');

console.log('\none night, two aliases, one endpoint');

const shared = summarizeSlowResponseHistory(
  history([
    observation('2026-07-01', 'azure/gpt-4o', 'https://weu.example', 1_000, 4),
    observation('2026-07-01', 'azure/o4-mini', 'https://weu.example', 500, 6),
  ]),
);
check(shared.days.length === 1, 'two aliases swept the same night are one day of the series');
const dayOne = shared.days[0];
check(
  dayOne !== undefined && dayOne.total === 1_500 && dayOne.slow === 10,
  'and their counts are added — the route grouped disjoint request-log rows per alias',
);
check(
  dayOne !== undefined && dayOne.keys === 1 && dayOne.models === 2,
  'the night reports one key and two aliases, which is the coverage a reader needs',
);
check(
  shared.keys.length === 1 &&
    shared.keys[0]?.total === 1_500 &&
    shared.keys[0]?.models.join(',') === 'azure/gpt-4o,azure/o4-mini',
  'and the endpoint is one row carrying both aliases',
);
check(
  shared.keys[0]?.daysObserved === 1,
  'two readings of one endpoint on one night are one observed day, not two',
);

console.log('\nacross nights');

const week = summarizeSlowResponseHistory(
  history([
    observation('2026-07-01', 'azure/gpt-4o', 'https://weu.example', 1_000, 2),
    observation('2026-07-02', 'azure/gpt-4o', 'https://weu.example', 1_000, 0),
    observation('2026-07-03', 'azure/gpt-4o', 'https://weu.example', 500, 20),
    observation('2026-07-03', 'azure/gpt-4o', 'https://neu.example', 400, 1),
  ]),
);
check(week.days.length === 3, 'three nights of readings are three days');
check(week.total === 2_900 && week.slow === 23, 'and the window totals are their sum');
const weu = week.keys.find((row) => row.key === 'https://weu.example');
check(weu?.daysObserved === 3, 'the endpoint was observed on every night it carried a reading');
check(
  weu?.daysWithHangs === 2,
  'and a night with a reading and no hangs is observed — it is evidence, not a gap',
);
check(
  weu?.worstDay?.date === '2026-07-03' && close(weu.worstDay.share, 20 / 500),
  'the worst night is the highest share rather than the highest count',
);
check(
  weu?.firstDate === '2026-07-01' && weu.lastDate === '2026-07-03',
  'and the row carries the span it was seen across',
);
check(
  close(week.keys.reduce((sum, row) => sum + row.excessSlow, 0), 0, 1e-9),
  'signed excess sums to zero across the keys — it redistributes the window, it does not judge it',
);

console.log('\nthe two gates, over pooled counts');

// Baseline keys carry the traffic, so the window share the gates are measured
// against is not dragged by the rows under test — the trap iterations 42, 43
// and 45 each hit with a median and a share.
const gateRows: GatewaySlowResponseObservation[] = [];
for (let day = 0; day < 8; day += 1) {
  const date = shiftIso('2026-07-01', day);
  gateRows.push(observation(date, 'azure/gpt-4o', 'baseline-a', 20_000, 80));
  gateRows.push(observation(date, 'azure/gpt-4o', 'baseline-b', 20_000, 80));
  // Materially and measurably worse: 1.2% against a ~0.4% window.
  gateRows.push(observation(date, 'azure/gpt-4o', 'refusing-pool', 1_000, 12));
  // Certain, and not worth an afternoon: 0.5% across a lot of traffic.
  gateRows.push(observation(date, 'azure/gpt-4o', 'faintly-worse', 20_000, 100));
  // Materially worse and barely seen: 2 hangs total, under the floor.
  gateRows.push(observation(date, 'azure/gpt-4o', 'barely-seen', 20, day < 2 ? 1 : 0));
  // Better than the gateway: nothing to report however much traffic it has.
  gateRows.push(observation(date, 'azure/gpt-4o', 'quiet', 20_000, 20));
}
const gated = summarizeSlowResponseHistory(history(gateRows, '2026-07-01', '2026-07-08'));
const gateKey = (key: string) => gated.keys.find((row) => row.key === key);
check(gateKey('refusing-pool')?.elevated === true, 'a key materially and certainly worse is badged');
check(
  gateKey('faintly-worse')?.elevated === false &&
    (gateKey('faintly-worse')?.ratioToGateway ?? 0) < SLOW_RESPONSE_ELEVATED_RATIO,
  'one certainly worse by a hair is refused by the materiality ratio, not by the interval',
);
check(
  gateKey('barely-seen')?.elevated === false &&
    (gateKey('barely-seen')?.ratioToGateway ?? 0) >= SLOW_RESPONSE_ELEVATED_RATIO &&
    (gateKey('barely-seen')?.slow ?? 0) < SLOW_RESPONSE_MIN_COUNT,
  'and one materially worse on two hangs is refused by the count floor',
);
check(gateKey('quiet')?.elevated === false, 'a key below the window share is never badged');
check(
  gated.keys[0]?.key === 'faintly-worse',
  'rows rank by hangs, so the busiest contributor leads even when it is not the worst',
);

console.log('\nunobserved nights');

const gappy = summarizeSlowResponseHistory(
  history(
    [
      observation('2026-07-04', 'azure/gpt-4o', 'weu', 100, 1),
      observation('2026-07-07', 'azure/gpt-4o', 'weu', 100, 1),
    ],
    '2026-07-01',
    '2026-07-08',
    '2026-07-04',
  ),
);
check(
  gappy.unobservedDays === 3,
  'the three nights between the first reading and the last day of the window are gaps',
);
check(
  gappy.days.length === 2 && gappy.days.every((day) => day.total > 0),
  'and a gap is left out of the series rather than drawn as a night nothing hung',
);
const beforeRecording = summarizeSlowResponseHistory(
  history(
    [observation('2026-07-08', 'azure/gpt-4o', 'weu', 100, 1)],
    '2026-07-01',
    '2026-07-08',
    '2026-07-08',
  ),
);
check(
  beforeRecording.unobservedDays === 0,
  'a window that mostly predates the recording reports no gaps — nobody was watching yet',
);
check(
  summarizeSlowResponseHistory(
    history([observation('2026-07-20', 'azure/gpt-4o', 'weu', 100, 1)], '2026-07-01', '2026-07-08', '2026-07-20'),
  ).unobservedDays === 0,
  'and a recording that starts after the window ends reports no gaps either',
);

console.log('\nthe trend');

const short = summarizeSlowResponseHistory(
  history(
    Array.from({ length: SLOW_RESPONSE_TREND_MIN_DAYS - 1 }, (_, index) =>
      observation(shiftIso('2026-07-01', index), 'azure/gpt-4o', 'weu', 1_000, 5),
    ),
    '2026-07-01',
    '2026-07-08',
  ),
);
check(
  short.trend === null,
  `fewer than ${SLOW_RESPONSE_TREND_MIN_DAYS} observed nights is not enough evidence to split`,
);

// Pooled rather than averaged, and the fixture is built so the two disagree in
// *sign*: the recent half hangs more in absolute terms while its quiet nights
// carry the higher per-night share.
const trendRows: GatewaySlowResponseObservation[] = [
  observation('2026-07-01', 'azure/gpt-4o', 'weu', 10_000, 20),
  observation('2026-07-02', 'azure/gpt-4o', 'weu', 10_000, 20),
  observation('2026-07-03', 'azure/gpt-4o', 'weu', 10, 5),
  observation('2026-07-04', 'azure/gpt-4o', 'weu', 10_000, 100),
  observation('2026-07-05', 'azure/gpt-4o', 'weu', 10_000, 100),
  observation('2026-07-06', 'azure/gpt-4o', 'weu', 10, 1),
];
const trended = summarizeSlowResponseHistory(history(trendRows, '2026-07-01', '2026-07-06'));
const meanOfShares = (rows: GatewaySlowResponseObservation[]) =>
  rows.reduce((sum, row) => sum + row.slow / row.total, 0) / rows.length;
check(
  trended.trend !== null &&
    trended.trend.earlier.days === 3 &&
    trended.trend.recent.days === 3 &&
    trended.trend.earlier.to === '2026-07-03' &&
    trended.trend.recent.from === '2026-07-04',
  'six observed nights split into two halves of three, adjacent and in order',
);
check(
  trended.trend !== null && close(trended.trend.earlier.share, 45 / 20_010),
  'each half is pooled — counts over counts, not a mean of nightly shares',
);
check(
  trended.trend !== null &&
    trended.trend.deltaPoints > 0 &&
    meanOfShares(trendRows.slice(0, 3)) > meanOfShares(trendRows.slice(3)),
  'and the pooled reading rises where a mean of shares would have fallen, which is the point of pooling it',
);
check(
  trended.trend !== null &&
    close(
      trended.trend.deltaPoints,
      (trended.trend.recent.share - trended.trend.earlier.share) * 100,
    ),
  'the movement is in percentage points, never a percent of a percent',
);
const oddTrend = summarizeSlowResponseHistory(
  history(
    Array.from({ length: 7 }, (_, index) =>
      observation(shiftIso('2026-07-01', index), 'azure/gpt-4o', 'weu', 1_000, 5),
    ),
    '2026-07-01',
    '2026-07-08',
  ),
);
check(
  oddTrend.trend?.earlier.days === 3 && oddTrend.trend.recent.days === 4,
  'an odd number of nights gives the extra one to the recent half — the question is about now',
);

console.log('\nrows the route could not have meant');

const junk = summarizeSlowResponseHistory(
  history([
    observation('2026-07-01', 'azure/gpt-4o', 'weu', 0, 0),
    observation('2026-07-02', 'azure/gpt-4o', 'weu', 100, 3),
  ]),
);
check(
  junk.days.length === 1 && junk.days[0]?.date === '2026-07-02',
  'a reading with no denominator is dropped rather than divided by',
);

// ----------------------------------------------------------------- mock half

console.log('\nthe mock, swept one night at a time');

const mock = new MockGatewayClient();
// Ends on the 20th deliberately: the mock plants its regional incident on the
// 17th and 18th, and a run of nights that misses it cannot demonstrate the one
// thing the stored table adds over the live read.
const lastNight = '2026-07-20';
const nights = 12;
const aliases = ['azure/gpt-4o', 'azure/o4-mini', 'bedrock/anthropic.claude-sonnet-4-v1:0'];

const observations: GatewaySlowResponseObservation[] = [];
for (let index = nights - 1; index >= 0; index -= 1) {
  const date = shiftIso(lastNight, -index);
  // Exactly what `readSlowResponses` does on a nightly sync: one day, the
  // window's last, the aliases the day's own usage ranked.
  const page = await mock.fetchModelSlowResponses(date, date, aliases);
  check(
    page.available && page.rows.length > 0,
    `the sweep for ${date} answered rows — a night nobody read would be stored as nothing at all`,
  );
  for (const row of page.rows) {
    observations.push(observation(date, row.model, row.key, row.total, row.slow));
  }
}

const swept = summarizeSlowResponseHistory(
  history(observations, shiftIso(lastNight, -(nights - 1)), lastNight, shiftIso(lastNight, -(nights - 1))),
);
check(swept.observedDays.length === nights, `${nights} nightly sweeps are ${nights} observed days`);
check(swept.unobservedDays === 0, 'and a scheduler that ran every night leaves no gaps');
check(
  swept.total === observations.reduce((sum, row) => sum + row.total, 0),
  'the window total is the sum of the nights, because these are disjoint request-log rows',
);
check(
  swept.keys.reduce((sum, row) => sum + row.slow, 0) === swept.slow,
  'and every hang is attributed to exactly one endpoint',
);

const ptu = swept.keys.find((row) => row.key.includes('neu-ptu'));
check(ptu !== undefined, 'the reserved pool is a key of its own, as the api_base grouping makes it');
check(
  ptu?.elevated === true,
  'and it is the badged key over the accumulated window as it is over one — more evidence, same question',
);
check(
  swept.keys.filter((row) => row.elevated).length === 1,
  'nothing else clears both gates, so the badge still names one endpoint rather than half of them',
);

// The claim the stored table exists for: the two-day incident is a *night* here,
// where a month-long window averages it into the provider's ordinary rate.
const incidentNights = swept.days.filter((day) => ['17', '18'].includes(day.date.slice(8, 10)));
const ordinaryNights = swept.days.filter((day) => !['17', '18'].includes(day.date.slice(8, 10)));
const meanShare = (days: typeof swept.days) =>
  days.reduce((sum, day) => sum + (day.share ?? 0), 0) / Math.max(1, days.length);
check(
  incidentNights.length === 2,
  'the window covers the two incident nights the mock plants every month',
);
check(
  meanShare(incidentNights) > meanShare(ordinaryNights) * 1.2,
  'and they read materially worse than the ordinary ones — a finding no single window shows',
);

check(
  swept.trend !== null && swept.trend.earlier.days + swept.trend.recent.days === nights,
  'the trend covers every observed night and invents none',
);

const window = await mock.fetchModelSlowResponses(
  shiftIso(lastNight, -(nights - 1)),
  lastNight,
  aliases,
);
const windowTotal = window.rows.reduce((sum, row) => sum + row.total, 0);
check(
  Math.abs(windowTotal - swept.total) / windowTotal < 0.01,
  'and the nights add back up to what one sweep of the same window reports, within rounding',
);

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('gateway slow-response history: all checks passed');
