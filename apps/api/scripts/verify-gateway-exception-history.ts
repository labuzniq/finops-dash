/**
 * Invariant check for the *stored* exception roll-up — the nightly sweep kept,
 * and the second of the four live gateway reads to get a table.
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-exception-history.ts
 *
 * Two halves, for the two things that can be wrong here.
 *
 * The **pure** half drives `summarizeExceptionHistory` over constructed
 * readings. Most of it restates the hang history's arithmetic over a different
 * quantity — counts add across a sweep and across nights, an unswept night is
 * never filled in, the halves split on observed nights — but two things are this
 * layer's own and are where the checks concentrate:
 *
 *  - **the receipt**, because this route answers rows only where something
 *    failed. A night that was swept and found nothing must read as *clean* and a
 *    night nobody swept must stay unknown, and in the rows alone those are the
 *    same empty list;
 *  - **the mix shift**, because this route carries no denominator. A trend in
 *    counts would move with traffic, so the statement is each class's share of
 *    recorded exceptions in percentage points — and the property worth asserting
 *    is that multiplying every count by ten moves it by nothing.
 *
 * The **mock** half simulates a run of nightly syncs by asking
 * `MockGatewayClient.fetchModelExceptions` for one day at a time, exactly as
 * `readExceptions` does, and checks that a sequence says what a single window
 * cannot: the planted two-day regional incident is a *mix* change on its own
 * nights (backend faults, not more of everything), where a month-long window
 * dissolves it into the ordinary error mix.
 *
 * Like its siblings it sits outside apps/api's tsconfig `include`: a harness,
 * not part of the API build.
 */
import { EXCEPTION_TREND_MIN_DAYS, classifyGatewayException, summarizeExceptionHistory } from '@dash/shared';
import type {
  GatewayExceptionHistory,
  GatewayExceptionObservation,
  GatewayExceptionSweep,
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
  deployment: string,
  type: string,
  count: number,
): GatewayExceptionObservation => ({
  date,
  model,
  deployment,
  type,
  count,
  observedAt: `${date}T06:00:00.000Z`,
});

const sweep = (date: string, models = 3, deployments = 2, exceptions = 0): GatewayExceptionSweep => ({
  date,
  models,
  deployments,
  exceptions,
  observedAt: `${date}T06:00:00.000Z`,
});

const history = (
  observations: GatewayExceptionObservation[],
  sweeps: GatewayExceptionSweep[],
  from = '2026-07-01',
  to = '2026-07-10',
  recordingSince: string | null = sweeps[0]?.date ?? null,
): GatewayExceptionHistory => ({ from, to, recordingSince, observations, sweeps });

const shiftIso = (iso: string, days: number): string => {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// ----------------------------------------------------------------- pure half

console.log('\nnothing recorded');

const empty = summarizeExceptionHistory(history([], [], '2026-07-01', '2026-07-10', null));
check(empty.total === 0, 'an empty history totals nothing');
check(empty.days.length === 0, 'and draws no nights');
check(empty.classes.length === 0 && empty.deployments.length === 0, 'and ranks nothing');
check(empty.trend === null, 'and withholds the trend');
check(
  empty.unobservedDays === 10,
  'and reads every night of the window as unread — with no recording at all, nobody looked on any of them',
);

console.log('\nthe receipt — a clean night against an unread one');

const cleanNight = summarizeExceptionHistory(
  history([], [sweep('2026-07-03', 5, 0, 0)], '2026-07-01', '2026-07-05'),
);
check(cleanNight.days.length === 1, 'a night swept with nothing found is still a night');
check(
  cleanNight.days[0]?.clean === true && cleanNight.days[0]?.total === 0,
  'drawn as clean, with a total of zero rather than as absent',
);
check(cleanNight.cleanDays === 1, 'and counted as a clean night');
check(
  cleanNight.observedDays.length === 1 && cleanNight.observedDays[0] === '2026-07-03',
  'the observed list is the nights we looked, not the nights something broke',
);
check(
  cleanNight.unobservedDays === 2,
  'the two nights after recording started and before the window ends are gaps; the ones before it are not',
);
check(cleanNight.days[0]?.models === 5, 'the receipt carries how many aliases were swept');

const noReceipt = summarizeExceptionHistory(
  history([observation('2026-07-03', 'gpt-4o', 'gpt-4o-https://a/', 'RateLimitError', 4)], [], '2026-07-01', '2026-07-05', '2026-07-03'),
);
check(
  noReceipt.days.length === 1 && noReceipt.days[0]?.clean === false,
  'rows with no receipt are still evidence the sweep ran — the night is observed, not clean',
);
check(noReceipt.days[0]?.models === 0, 'though with no receipt it cannot say how many aliases it covered');

console.log('\nthe roll-ups');

const rolled = summarizeExceptionHistory(
  history(
    [
      observation('2026-07-01', 'gpt-4o', 'gpt-4o-https://ptu/', 'RateLimitError', 100),
      observation('2026-07-01', 'gpt-4o', 'gpt-4o-https://ptu/', 'Timeout', 10),
      observation('2026-07-01', 'gpt-4o-mini', 'gpt-4o-https://ptu/', 'RateLimitError', 20),
      observation('2026-07-01', 'gpt-4o', 'gpt-4o-https://weu/', 'BadRequestError', 30),
      observation('2026-07-02', 'gpt-4o', 'gpt-4o-https://ptu/', 'litellm.RateLimitError', 40),
    ],
    [sweep('2026-07-01'), sweep('2026-07-02')],
    '2026-07-01',
    '2026-07-02',
  ),
);
check(rolled.total === 200, 'every count adds: 200 exceptions across two nights');
check(
  rolled.days[0]?.total === 160 && rolled.days[1]?.total === 40,
  'each night carries its own sum',
);
check(
  rolled.days[0]?.deployments === 2,
  'and how many deployments contributed to it, not how many exist',
);
const rateLimit = rolled.classes.find((entry) => entry.class === 'rate-limit');
check(
  rateLimit?.count === 160,
  'a class pools across aliases, deployments and nights — two aliases on one deployment are two counts of it',
);
check(
  rateLimit?.types.some((type) => type.type === 'litellm.RateLimitError'),
  'and keeps the proxy\'s own type strings apart while classifying them together',
);
check(
  close(rolled.classes.reduce((sum, entry) => sum + entry.share, 0), 1),
  'class shares are of recorded exceptions and sum to one',
);
check(
  rateLimit?.daysPresent === 2 && rateLimit?.deployments === 1,
  'a class counts the nights it appeared on and the deployments it came from',
);
const ptu = rolled.deployments[0];
check(
  ptu?.deployment === 'gpt-4o-https://ptu/' && ptu?.count === 170,
  'deployments rank by count, largest first',
);
check(
  ptu?.dominantClass === 'rate-limit' && close(ptu?.dominantShare ?? 0, 160 / 170),
  'and name the class carrying most of their own exceptions',
);
check(
  ptu?.worstDay?.date === '2026-07-01' && ptu?.worstDay?.count === 130,
  'the worst night is the deployment\'s own, summed across the aliases that routed there',
);
check(
  ptu?.models.join(',') === 'gpt-4o,gpt-4o-mini',
  'and the aliases that routed to it are listed, sorted',
);
check(
  close(rolled.deployments.reduce((sum, row) => sum + row.share, 0), 1),
  'deployment shares are of the same denominator and also sum to one',
);

console.log('\nthe class is derived on read, never stored');

const unknown = summarizeExceptionHistory(
  history(
    [observation('2026-07-01', 'gpt-4o', 'd', 'SomeFutureLiteLLMError', 7)],
    [sweep('2026-07-01')],
    '2026-07-01',
    '2026-07-01',
  ),
);
check(
  classifyGatewayException('SomeFutureLiteLLMError') === 'other' &&
    unknown.classes[0]?.class === 'other',
  'an unrecognised type lands in other rather than being guessed at',
);
check(
  unknown.classes[0]?.types[0]?.type === 'SomeFutureLiteLLMError',
  'under its own name, so adding it to the taxonomy later re-files this history',
);

console.log('\nthe mix shift');

const short = summarizeExceptionHistory(
  history(
    Array.from({ length: EXCEPTION_TREND_MIN_DAYS - 1 }, (_, index) =>
      observation(shiftIso('2026-07-01', index), 'gpt-4o', 'd', 'RateLimitError', 10),
    ),
    Array.from({ length: EXCEPTION_TREND_MIN_DAYS - 1 }, (_, index) =>
      sweep(shiftIso('2026-07-01', index)),
    ),
    '2026-07-01',
    '2026-07-09',
  ),
);
check(
  short.trend === null,
  `fewer than ${EXCEPTION_TREND_MIN_DAYS} swept nights withholds the trend rather than reporting a direction`,
);
check(
  short.classes.every((entry) => entry.shiftPoints === null && entry.newInRecentHalf === null),
  'and every class says so rather than reading as unmoved',
);

// Six nights: rate limits dominate the first three, backend faults the last
// three — the same total each night, so only the *mix* moved.
const mixNights = [0, 1, 2, 3, 4, 5].map((index) => shiftIso('2026-07-01', index));
const shifted = summarizeExceptionHistory(
  history(
    mixNights.flatMap((date, index) =>
      index < 3
        ? [
            observation(date, 'gpt-4o', 'd', 'RateLimitError', 80),
            observation(date, 'gpt-4o', 'd', 'ServiceUnavailableError', 20),
          ]
        : [
            observation(date, 'gpt-4o', 'd', 'RateLimitError', 20),
            observation(date, 'gpt-4o', 'd', 'ServiceUnavailableError', 80),
          ],
    ),
    mixNights.map((date) => sweep(date)),
    '2026-07-01',
    '2026-07-06',
  ),
);
check(shifted.trend !== null, 'six swept nights are enough to split');
check(
  shifted.trend?.earlier.days === 3 && shifted.trend?.recent.days === 3,
  'the halves are three nights each, split on swept nights rather than on the calendar',
);
const backendMove = shifted.trend?.classes.find((entry) => entry.class === 'backend');
const rateMove = shifted.trend?.classes.find((entry) => entry.class === 'rate-limit');
check(
  close(backendMove?.deltaPoints ?? 0, 60) && close(rateMove?.deltaPoints ?? 0, -60),
  'the shift is in percentage points of the mix: backend +60, rate-limit −60',
);
check(
  close(
    (shifted.trend?.classes ?? []).reduce((sum, entry) => sum + entry.deltaPoints, 0),
    0,
    1e-9,
  ),
  'and the moves sum to zero, because both halves are shares of their own totals',
);
check(
  shifted.trend?.classes[0]?.class === 'backend' || shifted.trend?.classes[0]?.class === 'rate-limit',
  'the trend is ordered by the size of the move, not by volume',
);
check(
  shifted.classes.find((entry) => entry.class === 'backend')?.shiftPoints !== null,
  'and the per-class rows carry the same number, so the two cannot disagree',
);

// The property the whole design rests on: with no denominator, ten times the
// traffic must move the statement by nothing.
const louder = summarizeExceptionHistory(
  history(
    mixNights.flatMap((date, index) =>
      index < 3
        ? [
            observation(date, 'gpt-4o', 'd', 'RateLimitError', 80),
            observation(date, 'gpt-4o', 'd', 'ServiceUnavailableError', 20),
          ]
        : [
            observation(date, 'gpt-4o', 'd', 'RateLimitError', 200),
            observation(date, 'gpt-4o', 'd', 'ServiceUnavailableError', 800),
          ],
    ),
    mixNights.map((date) => sweep(date)),
    '2026-07-01',
    '2026-07-06',
  ),
);
check(
  close(
    louder.trend?.classes.find((entry) => entry.class === 'backend')?.deltaPoints ?? 0,
    backendMove?.deltaPoints ?? -1,
  ),
  'a tenfold busier recent half reports the identical shift — the mix is what a missing denominator cannot corrupt',
);
check(
  louder.total === shifted.total * 5.5,
  'while the counts themselves moved, and are carried as evidence rather than as the statement',
);

const arrived = summarizeExceptionHistory(
  history(
    mixNights.flatMap((date, index) =>
      index < 3
        ? [observation(date, 'gpt-4o', 'd', 'RateLimitError', 50)]
        : [
            observation(date, 'gpt-4o', 'd', 'RateLimitError', 50),
            observation(date, 'gpt-4o', 'd', 'AuthenticationError', 12),
          ],
    ),
    mixNights.map((date) => sweep(date)),
    '2026-07-01',
    '2026-07-06',
  ),
);
check(
  arrived.classes.find((entry) => entry.class === 'auth')?.newInRecentHalf === true,
  'a class absent from the earlier half entirely is flagged as new',
);
check(
  arrived.classes.find((entry) => entry.class === 'rate-limit')?.newInRecentHalf === false,
  'and one that was always there is not',
);

const quietHalf = summarizeExceptionHistory(
  history(
    mixNights
      .slice(0, 3)
      .map((date) => observation(date, 'gpt-4o', 'd', 'RateLimitError', 50)),
    mixNights.map((date) => sweep(date)),
    '2026-07-01',
    '2026-07-06',
  ),
);
check(
  quietHalf.trend === null,
  'a half that recorded nothing has no mix, so the trend is withheld rather than reported as every class collapsing',
);
check(
  quietHalf.cleanDays === 3 && quietHalf.days.length === 6,
  'though its clean nights are still observed nights',
);

console.log('\nthe gaps');

const gappy = summarizeExceptionHistory(
  history(
    [observation('2026-07-04', 'gpt-4o', 'd', 'Timeout', 3)],
    [sweep('2026-07-04'), sweep('2026-07-08')],
    '2026-07-01',
    '2026-07-10',
    '2026-07-04',
  ),
);
check(
  gappy.unobservedDays === 5,
  'gaps are counted forward from the first night we ever swept: 4th to 10th is seven nights, two were swept',
);
check(
  gappy.days.length === 2 && gappy.days[1]?.clean === true,
  'and the unswept nights are absent from the series rather than drawn as clean',
);

// ----------------------------------------------------------------- mock half

console.log('\ntwelve nightly sweeps against the mock proxy');

const mock = new MockGatewayClient();

// Anchored so the window covers the planted 17th/18th incident: a run of nights
// chosen off the newest day silently misses the one fault the stored table
// exists to make visible.
const yesterday = shiftIso(new Date().toISOString().slice(0, 10), -1);
const anchor = Number(yesterday.slice(8, 10)) >= 20 ? `${yesterday.slice(0, 8)}20` : shiftIso(`${yesterday.slice(0, 8)}01`, -11);
const nights = 12;
const firstNight = shiftIso(anchor, -(nights - 1));

const snapshot = await mock.fetchUsage(firstNight, anchor);
const spendByModel = new Map<string, bigint>();
for (const row of snapshot.breakdowns) {
  if (row.dimension !== 'model') continue;
  spendByModel.set(row.key, (spendByModel.get(row.key) ?? 0n) + row.spendNano);
}
const aliases = [...spendByModel.entries()]
  .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] > a[1] ? 1 : -1))
  .map(([model]) => model)
  .slice(0, 12);
check(aliases.length > 0, `the sweep has ${aliases.length} aliases to ask about, from the window's own usage`);

const observations: GatewayExceptionObservation[] = [];
const sweeps: GatewayExceptionSweep[] = [];
for (let index = 0; index < nights; index += 1) {
  const night = shiftIso(firstNight, index);
  const page = await mock.fetchModelExceptions(night, night, aliases);
  if (!page.available) continue;
  let counted = 0;
  const deployments = new Set<string>();
  for (const row of page.rows) {
    for (const entry of row.exceptions) {
      if (entry.count <= 0) continue;
      observations.push(observation(night, row.model, row.deployment, entry.type, entry.count));
      deployments.add(row.deployment);
      counted += entry.count;
    }
  }
  sweeps.push({
    date: night,
    models: aliases.length,
    deployments: deployments.size,
    exceptions: counted,
    observedAt: `${night}T06:00:00.000Z`,
  });
}

const swept = summarizeExceptionHistory({
  from: firstNight,
  to: anchor,
  recordingSince: firstNight,
  observations,
  sweeps,
});

check(swept.days.length === nights, `all ${nights} nights were swept and recorded`);
check(swept.unobservedDays === 0, 'and none of them reads as a gap');
check(swept.total > 0, `the run recorded ${swept.total} exceptions`);
check(
  swept.classes.reduce((sum, entry) => sum + entry.count, 0) === swept.total,
  'the class roll-up accounts for every one of them',
);
check(
  swept.deployments.reduce((sum, row) => sum + row.count, 0) === swept.total,
  'and so does the deployment roll-up — the two are the same exceptions cut two ways',
);

const refusing = swept.deployments.find((row) => row.deployment.includes('neu-ptu'));
check(
  refusing !== undefined && refusing.dominantClass === 'rate-limit',
  'the refusing reserved pool is dominated by rate limits, which is the finding the ledger cannot make',
);
check(
  (refusing?.dominantShare ?? 0) > 0.9,
  'overwhelmingly so — one class, not a spread',
);

// The claim the stored table exists for: the incident is a *mix* change on its
// own nights, where a month-long window dissolves it into the ordinary mix.
const incidentNights = swept.days.filter((day) => ['17', '18'].includes(day.date.slice(8, 10)));
const ordinaryNights = swept.days.filter((day) => !['17', '18'].includes(day.date.slice(8, 10)));
const backendShare = (days: typeof swept.days) => {
  const total = days.reduce((sum, day) => sum + day.total, 0);
  const backend = days.reduce(
    (sum, day) => sum + (day.classes.find((entry) => entry.class === 'backend')?.count ?? 0),
    0,
  );
  return total === 0 ? 0 : backend / total;
};
check(
  incidentNights.length === 2,
  'the window covers the two incident nights the mock plants every month',
);
check(
  backendShare(incidentNights) > backendShare(ordinaryNights) * 1.3,
  'and backend faults carry a materially larger share of those nights\' mix — a change in what broke, not in how much',
);
check(
  swept.trend !== null && swept.trend.earlier.days + swept.trend.recent.days === nights,
  'the trend covers every swept night and invents none',
);

const window = await mock.fetchModelExceptions(firstNight, anchor, aliases);
const windowTotal = window.rows.reduce(
  (sum, row) => sum + row.exceptions.reduce((inner, entry) => inner + entry.count, 0),
  0,
);
check(
  Math.abs(windowTotal - swept.total) / windowTotal < 0.02,
  'and the nights add back up to what one sweep of the same window reports, within rounding',
);
check(
  window.rows.every((row) => row.reportedTotal <= row.exceptions.length),
  "the proxy's own total_exceptions still counts classes rather than exceptions, and is never what we stored",
);

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('gateway exception history: all checks passed');
