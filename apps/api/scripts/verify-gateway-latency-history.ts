/**
 * Invariant check for the *stored* latency roll-up — the nightly `/model/metrics`
 * sweep kept, and the third of the four live gateway reads to get a table.
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-latency-history.ts
 *
 * The table is stored on a different licence from its two siblings and the whole
 * point of this harness is that the difference holds in the arithmetic rather
 * than only in the prose. `gateway_slow_response_daily` and
 * `gateway_exception_daily` keep counts, which **add** across a sweep and across
 * nights. These readings are averages the proxy took over request counts it then
 * discarded, so they may be **compared and never pooled** — every window figure
 * is a median of nightly readings, a night with thirty keys reporting weighs
 * exactly what a night with one does, and two aliases behind one endpoint stay
 * two rows where the hang history adds them into one.
 *
 * Two halves, as with every sibling.
 *
 * The **pure** half drives `summarizeLatencyHistory` over constructed readings:
 * the night roll-up (a median across pairs, never a sum), the per-pair roll-up
 * across nights (a median, so one incident night in a quarter is not the pair's
 * standing rate), a re-sweep replacing a reading rather than averaging with it,
 * the badge gates from both sides over a fixture whose baseline pairs are not
 * dragged by the outliers under test, the unobserved-night arithmetic in the
 * window and inside a pair's own span, and the half-over-half trend — a ratio of
 * two medians, split on *observed* nights, withheld below the gate, and provably
 * unmoved by how many keys reported.
 *
 * The **mock** half simulates a run of nightly syncs by asking
 * `MockGatewayClient.fetchModelLatency` for one night at a time exactly as
 * `readLatency` does, and checks that the sequence says what a single window
 * cannot: the two-day regional incident is visible as its own nights while the
 * same days average away inside a month-long read, the refusing reserved pool is
 * the badged key, and the deliberately-slow reasoning deployment stays under the
 * badge. It also round-trips every reading through the nano encoding the table
 * stores it in.
 *
 * Like its siblings it sits outside apps/api's tsconfig `include`: a harness,
 * not part of the API build.
 */
import {
  LATENCY_ELEVATED_RATIO,
  LATENCY_MIN_DAYS,
  LATENCY_TREND_MIN_DAYS,
  summarizeLatencyHistory,
  summarizeGatewayLatency,
} from '@dash/shared';
import type {
  GatewayLatency,
  GatewayLatencyHistory,
  GatewayLatencyObservation,
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
  secondsPerToken: number,
): GatewayLatencyObservation => ({
  date,
  model,
  key,
  secondsPerToken,
  observedAt: `${date}T06:00:00.000Z`,
});

const history = (
  observations: GatewayLatencyObservation[],
  from = '2026-07-01',
  to = '2026-07-10',
  recordingSince: string | null = observations[0]?.date ?? null,
): GatewayLatencyHistory => ({ from, to, recordingSince, observations });

const shiftIso = (iso: string, days: number): string => {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

// ----------------------------------------------------------------- pure half

console.log('\nnothing recorded');

const empty = summarizeLatencyHistory(history([], '2026-07-01', '2026-07-10', null));
check(empty.days.length === 0 && empty.keys.length === 0, 'an empty recording has no nights and no keys');
check(empty.medianSecondsPerToken === null, 'and no gateway median to compare anything against');
check(empty.trend === null, 'and no trend');
check(
  empty.unobservedDays === 10,
  'every night of the window is unread when nothing was ever recorded — not a fast gateway',
);

console.log('\none night');

const oneNight = summarizeLatencyHistory(
  history([
    observation('2026-07-01', 'azure/gpt-4o', 'https://weu.example', 0.02),
    observation('2026-07-01', 'bedrock/claude', 'bedrock/claude', 0.04),
  ]),
);
check(oneNight.days.length === 1, 'one night carrying readings is one point on the series');
check(
  close(oneNight.days[0]!.medianSecondsPerToken, 0.03),
  "the night's reading is the median across the keys that reported (0.02, 0.04 → 0.03)",
);
check(
  !close(oneNight.days[0]!.medianSecondsPerToken, 0.06),
  'and never their sum — rates do not add, which is the whole reason this table may not be pooled',
);
check(oneNight.days[0]!.keys === 2 && oneNight.days[0]!.models === 2, 'the night carries its own coverage');
check(
  close(oneNight.medianSecondsPerToken ?? 0, 0.03),
  'the gateway figure is the median of the pair medians',
);

console.log('\nthe grain is the (alias, key) pair');

const sharedEndpoint = summarizeLatencyHistory(
  history([
    observation('2026-07-01', 'azure/gpt-4o', 'https://weu.example', 0.02),
    observation('2026-07-01', 'azure/o4-mini', 'https://weu.example', 0.06),
  ]),
);
check(
  sharedEndpoint.keys.length === 2,
  'two aliases behind one endpoint stay two rows — the opposite of the hang history, because two averages over two workloads have no sum',
);
check(
  sharedEndpoint.days[0]!.keys === 2 && close(sharedEndpoint.days[0]!.medianSecondsPerToken, 0.04),
  'and both of them count towards the night, which is a median rather than a merge',
);

const resweep = summarizeLatencyHistory(
  history([
    observation('2026-07-01', 'azure/gpt-4o', 'https://weu.example', 0.02),
    observation('2026-07-01', 'azure/gpt-4o', 'https://weu.example', 0.06),
  ]),
);
check(
  resweep.keys.length === 1 && close(resweep.keys[0]!.medianSecondsPerToken, 0.06),
  'a night swept twice keeps the later reading',
);
check(
  !close(resweep.keys[0]!.medianSecondsPerToken, 0.04),
  'and never the mean of the two — that is the pooling this layer does not permit',
);

console.log('\na pair across nights');

const spiky = summarizeLatencyHistory(
  history([
    observation('2026-07-01', 'azure/gpt-4o', 'https://weu.example', 0.01),
    observation('2026-07-02', 'azure/gpt-4o', 'https://weu.example', 0.01),
    observation('2026-07-03', 'azure/gpt-4o', 'https://weu.example', 0.1),
  ]),
);
check(
  close(spiky.keys[0]!.medianSecondsPerToken, 0.01),
  'a pair reads at the median of its nights, so one incident night is not its standing rate',
);
check(
  !close(spiky.keys[0]!.medianSecondsPerToken, 0.04),
  'and not at their mean, which the single incident night would own',
);
check(
  spiky.keys[0]!.worstDay.date === '2026-07-03' && close(spiky.keys[0]!.worstDay.secondsPerToken, 0.1),
  'the incident night is still reported, as the pair worst night',
);
check(
  spiky.keys[0]!.bestDay.date === '2026-07-01',
  'beside its best — a pair that is always slow reads differently from one that spiked',
);
check(spiky.keys[0]!.daysObserved === 3, 'nights observed are counted, never converted into a duration');

const gappyPair = summarizeLatencyHistory(
  history([
    observation('2026-07-01', 'azure/gpt-4o', 'https://weu.example', 0.01),
    observation('2026-07-03', 'azure/gpt-4o', 'https://weu.example', 0.01),
    observation('2026-07-05', 'azure/gpt-4o', 'https://weu.example', 0.01),
  ]),
);
check(
  gappyPair.keys[0]!.unobservedDays === 2,
  "a pair's gaps are counted inside its own first-to-last span, not the window's",
);
check(
  gappyPair.unobservedDays === 7,
  'while the window counts every night after recording started that carries nothing',
);

const lateStart = summarizeLatencyHistory(
  history(
    [
      observation('2026-07-06', 'azure/gpt-4o', 'https://weu.example', 0.01),
      observation('2026-07-07', 'azure/gpt-4o', 'https://weu.example', 0.01),
      observation('2026-07-09', 'azure/gpt-4o', 'https://weu.example', 0.01),
    ],
    '2026-07-01',
    '2026-07-10',
    '2026-07-06',
  ),
);
check(
  lateStart.unobservedDays === 2,
  'nights before recording started are not gaps — the count runs forward from recordingSince',
);

console.log('\nreadings the payload cannot mean');

const rubbish = summarizeLatencyHistory(
  history([
    observation('2026-07-01', 'azure/gpt-4o', 'https://weu.example', 0),
    observation('2026-07-01', 'azure/o4-mini', 'https://neu.example', -0.4),
    observation('2026-07-01', 'bedrock/claude', 'bedrock/claude', Number.NaN),
    observation('2026-07-01', 'azure/gpt-4o-mini', 'https://eus.example', 0.02),
  ]),
);
check(
  rubbish.keys.length === 1 && rubbish.days[0]!.keys === 1,
  'a zero, a negative and a NaN are dropped rather than read as instant deployments',
);

console.log('\nthe badge, from both sides');

const badgeReadings: GatewayLatencyObservation[] = [];
const nights = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'];
// Five baseline pairs, so the median the ratios are taken against is not dragged
// by the rows under test — the fixture trap every badged layer in this repo has
// hit, here for the fifth time.
for (const night of nights) {
  for (let index = 0; index < 5; index += 1) {
    badgeReadings.push(observation(night, `baseline/${index}`, `https://base-${index}`, 0.01));
  }
  badgeReadings.push(observation(night, 'azure/gpt-4o', 'https://ptu.example', 0.02));
  badgeReadings.push(observation(night, 'azure/gpt-4o', 'https://near.example', 0.013));
}
// Materially slower, but seen on fewer nights than the evidence gate wants.
badgeReadings.push(observation('2026-07-04', 'azure/new', 'https://new.example', 0.02));
badgeReadings.push(observation('2026-07-05', 'azure/new', 'https://new.example', 0.02));

const badges = summarizeLatencyHistory(history(badgeReadings, '2026-07-01', '2026-07-05'));
const rowFor = (key: string) => badges.keys.find((row) => row.key === key);
check(
  close(badges.medianSecondsPerToken ?? 0, 0.01),
  'the gateway median is the baseline, not an average dragged by the rows under test',
);
check(
  rowFor('https://ptu.example')?.elevated === true &&
    (rowFor('https://ptu.example')?.ratioToGateway ?? 0) >= LATENCY_ELEVATED_RATIO,
  `a pair ${LATENCY_ELEVATED_RATIO}x the gateway median on enough nights is badged`,
);
check(
  rowFor('https://near.example')?.elevated === false,
  'one 1.3x the median is not — the layer has no significance test, so materiality is the whole gate',
);
check(
  rowFor('https://new.example')?.elevated === false &&
    (rowFor('https://new.example')?.daysObserved ?? 0) < LATENCY_MIN_DAYS,
  `and one seen on fewer than ${LATENCY_MIN_DAYS} nights is not badged however slow it read`,
);
check(
  badges.keys[0]!.medianSecondsPerToken >= badges.keys[badges.keys.length - 1]!.medianSecondsPerToken,
  'rows rank slowest first',
);

console.log('\nthe trend');

const trendNights = (count: number, earlier: number, recent: number): GatewayLatencyObservation[] => {
  const readings: GatewayLatencyObservation[] = [];
  const cut = Math.floor(count / 2);
  for (let index = 0; index < count; index += 1) {
    readings.push(
      observation(
        shiftIso('2026-07-01', index),
        'azure/gpt-4o',
        'https://weu.example',
        index < cut ? earlier : recent,
      ),
    );
  }
  return readings;
};

const short = summarizeLatencyHistory(
  history(trendNights(LATENCY_TREND_MIN_DAYS - 1, 0.01, 0.02), '2026-07-01', '2026-07-20'),
);
check(
  short.trend === null,
  `fewer than ${LATENCY_TREND_MIN_DAYS} observed nights withholds the trend rather than reporting a direction`,
);

const trended = summarizeLatencyHistory(
  history(trendNights(LATENCY_TREND_MIN_DAYS, 0.01, 0.02), '2026-07-01', '2026-07-20'),
);
check(
  trended.trend !== null && close(trended.trend.ratio, 2),
  'a doubling reads as a ratio of 2 — a rate moves by a factor, where a share moves by points',
);
check(
  trended.trend !== null && trended.trend.earlier.days === 3 && trended.trend.recent.days === 3,
  'and both halves carry the nights they were computed from',
);

const odd = summarizeLatencyHistory(history(trendNights(7, 0.01, 0.02), '2026-07-01', '2026-07-20'));
check(
  odd.trend !== null && odd.trend.earlier.days === 3 && odd.trend.recent.days === 4,
  'an odd number of nights gives the extra one to the recent half — the question is about now',
);

const gapped = summarizeLatencyHistory(
  history(
    [
      observation('2026-07-01', 'azure/gpt-4o', 'https://weu.example', 0.01),
      observation('2026-07-02', 'azure/gpt-4o', 'https://weu.example', 0.01),
      observation('2026-07-03', 'azure/gpt-4o', 'https://weu.example', 0.01),
      observation('2026-07-18', 'azure/gpt-4o', 'https://weu.example', 0.02),
      observation('2026-07-19', 'azure/gpt-4o', 'https://weu.example', 0.02),
      observation('2026-07-20', 'azure/gpt-4o', 'https://weu.example', 0.02),
    ],
    '2026-07-01',
    '2026-07-20',
  ),
);
check(
  gapped.trend !== null && gapped.trend.earlier.days === 3 && gapped.trend.recent.days === 3,
  'a fortnight the scheduler was down shifts the split instead of emptying a half',
);
check(
  gapped.unobservedDays === 14,
  'and those nights are reported as unread rather than filled in with either half',
);

// The property that distinguishes this layer from its two siblings: their trends
// pool counts, so ten times the traffic changes the weights. Nothing here is
// weighted, so a night reported by six keys must read exactly as a night
// reported by one carrying the same values.
const thinNights = trendNights(LATENCY_TREND_MIN_DAYS, 0.01, 0.02);
const thickNights = thinNights.flatMap((reading) =>
  [0, 1, 2, 3, 4, 5].map((index) =>
    observation(reading.date, `alias/${index}`, `https://key-${index}`, reading.secondsPerToken),
  ),
);
const thin = summarizeLatencyHistory(history(thinNights, '2026-07-01', '2026-07-20'));
const thick = summarizeLatencyHistory(history(thickNights, '2026-07-01', '2026-07-20'));
check(
  thin.trend !== null && thick.trend !== null && close(thin.trend.ratio, thick.trend.ratio),
  'six keys reporting a night read exactly as one does — a sample with no weights cannot be pooled',
);
check(
  JSON.stringify(thin.days.map((day) => day.medianSecondsPerToken)) ===
    JSON.stringify(thick.days.map((day) => day.medianSecondsPerToken)),
  'and the nightly series is identical, which is the arithmetic reason this table stores no totals',
);

// ----------------------------------------------------------------- mock half

console.log('\nagainst the mock proxy');

const mock = new MockGatewayClient();
const today = new Date();
const iso = (date: Date): string => date.toISOString().slice(0, 10);
const shift = (days: number): string => {
  const cursor = new Date(today);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return iso(cursor);
};

// A month back from yesterday, so the window contains the 17th/18th regional
// incident whatever today is — the lesson iteration 46 recorded about choosing a
// window around the planted faults rather than around the newest day.
const lastNight = shift(-1);
const nightCount = 31;
const firstNight = shift(-nightCount);

const usage = await mock.fetchUsage(firstNight, lastNight);
const aliases = [
  ...new Set(usage.breakdowns.filter((row) => row.dimension === 'model').map((row) => row.key)),
];

// One sweep per night, exactly as `readLatency` runs it inside the sync — and
// through the same nano encoding the table stores, so a rounding error in the
// column would show up here rather than in production.
const observations: GatewayLatencyObservation[] = [];
let grainViolations = 0;
let roundTripErrors = 0;
for (let index = 0; index < nightCount; index += 1) {
  const night = shiftIso(firstNight, index);
  const page = await mock.fetchModelLatency(night, night, aliases);
  const seen = new Set<string>();
  for (const row of page.rows) {
    if (row.date !== night) continue;
    const id = `${row.model} ${row.key}`;
    if (seen.has(id)) grainViolations += 1;
    seen.add(id);
    const nano = BigInt(Math.round(row.secondsPerToken * 1e9));
    const decoded = Number(nano) / 1e9;
    if (Math.abs(decoded - row.secondsPerToken) > 1e-9) roundTripErrors += 1;
    observations.push(observation(night, row.model, row.key, decoded));
  }
}

check(grainViolations === 0, "one night's sweep answers at most one reading per (alias, key) — the table's grain");
check(roundTripErrors === 0, 'and every reading survives the nano encoding the column stores it in');

const swept = summarizeLatencyHistory({
  from: firstNight,
  to: lastNight,
  recordingSince: firstNight,
  observations,
});

check(
  swept.observedDays.length === nightCount && swept.unobservedDays === 0,
  'a sync every night leaves a recording with no gaps in it',
);

// The same window read in one go, which is what the live card renders.
const window = await mock.fetchModelLatency(firstNight, lastNight, aliases);
const series = new Map<string, GatewayLatency['series'][number]>();
for (const row of window.rows) {
  const id = `${row.model} ${row.key}`;
  const existing = series.get(id);
  if (existing === undefined) {
    series.set(id, {
      model: row.model,
      key: row.key,
      points: [{ date: row.date, secondsPerToken: row.secondsPerToken }],
    });
  } else existing.points.push({ date: row.date, secondsPerToken: row.secondsPerToken });
}
const live = summarizeGatewayLatency({
  from: firstNight,
  to: lastNight,
  models: aliases,
  skippedModels: [],
  series: [...series.values()],
  apiBases: window.apiBases,
  available: true,
  fetchedAt: new Date().toISOString(),
});

check(
  swept.observedKeys === live.observedKeys,
  'the nights reconstruct exactly the pairs one window read reports — the generator is date-keyed, not window-keyed',
);

const ptuRow = swept.keys.find((row) => row.key.includes('neu-ptu'));
check(ptuRow !== undefined, 'the reserved pool that is refusing appears as its own key');
check(
  ptuRow?.elevated === true,
  'and is badged over the recording, as it is over a single window — a longer look is more evidence, not a different question',
);
const siblingRow = swept.keys.find(
  (row) => row.model === ptuRow?.model && row.key !== ptuRow.key,
);
check(
  siblingRow !== undefined && siblingRow.elevated === false,
  'while the sibling covering for it behind the same alias is not',
);

const reasoningRow = swept.keys.find((row) => row.model === 'azure/o4-mini' && !row.key.includes('ptu'));
check(
  reasoningRow !== undefined &&
    (reasoningRow.ratioToGateway ?? 0) > 1 &&
    reasoningRow.elevated === false,
  'the deliberately slower reasoning deployment reads above the median and stays under the badge',
);

// The claim the stored table exists for. A pair hit by the two-day regional
// incident reads it as two nights here; inside a month-long window read the same
// days are averaged into its ordinary rate.
const incidentNight = (date: string) => ['17', '18'].includes(date.slice(8, 10));
const bedrockRow = swept.keys.find((row) => row.model.startsWith('bedrock/'));
check(bedrockRow !== undefined, 'the incident provider carries a key in the recording');
if (bedrockRow !== undefined) {
  const pairReadings = observations.filter(
    (entry) => entry.model === bedrockRow.model && entry.key === bedrockRow.key,
  );
  const incidentValues = pairReadings.filter((entry) => incidentNight(entry.date)).map((entry) => entry.secondsPerToken);
  const ordinaryValues = pairReadings.filter((entry) => !incidentNight(entry.date)).map((entry) => entry.secondsPerToken);
  check(incidentValues.length === 2, 'the window covers both incident nights the mock plants every month');
  check(
    median(incidentValues) > median(ordinaryValues) * 1.4,
    'those nights read materially slower than its ordinary ones — a finding no single window read makes',
  );
  const liveRow = live.rows.find((row) => row.model === bedrockRow.model && row.key === bedrockRow.key);
  check(
    liveRow !== undefined && liveRow.meanSecondsPerToken < median(ordinaryValues) * 1.1,
    'while the same days average away inside the window read, which is why the nights are worth keeping',
  );
}

check(
  swept.trend !== null && swept.trend.earlier.days + swept.trend.recent.days === nightCount,
  'the trend covers every observed night and invents none',
);
check(
  swept.trend !== null && swept.trend.ratio > 0.75 && swept.trend.ratio < 1.35,
  'and reports no drift on a mock that plants none — an incident inside one half moves it, a trend does not appear from nowhere',
);

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('gateway latency history: all checks passed');
