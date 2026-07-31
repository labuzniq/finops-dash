/**
 * Ad-hoc check of the web app's *exception history* view — the card that reads
 * the stored nightly `/model/metrics/exceptions` sweeps as a sequence. Not a
 * test suite (the repo has none); run it by hand:
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-exception-history-view.ts
 *
 * `verify-gateway-exception-history.ts` already covers the recording and the
 * shared `summarizeExceptionHistory` rule — the receipt driven from three sides,
 * the per-night/per-class/per-deployment roll-ups, the unobserved-day arithmetic,
 * and the mix shift's denominator-proof property. This script covers only what
 * the *view* adds, which is the drawing and no rule about the gateway at all:
 *
 *  - **the summary passes through untouched**, asserted as deep equality rather
 *    than as a convention somebody could quietly break.
 *  - **the spine**, clamped forward to `recordingSince`: there is no backfill for
 *    this table, so a 60-night window on a four-night recording draws four.
 *  - **three states per cell**, which is the whole reason the receipt table
 *    exists. A swept night that recorded nothing is *clean*; a night with no
 *    receipt is *unread*; drawing them the same way is the one lie this layer is
 *    built to avoid.
 *  - **cells that agree with the row**: a class's nightly cells must sum to the
 *    class's own window count, so the strip and the roll-up cannot drift.
 *  - **`tooShort`**, asserted on both sides of `EXCEPTION_TREND_MIN_DAYS` and
 *    against a sparse window, because the gate counts nights *swept* rather than
 *    nights elapsed.
 *  - **the withheld-shift sentence**, which has to be several different ones:
 *    too few nights, a half that recorded nothing, a class outside the split, and
 *    a class new in the recent half are four different silences.
 *  - **the health join**, in all three states, with `unread` never reading as
 *    healthy.
 *
 * The mock half sweeps one night at a time exactly as `readExceptions` does — the
 * window's last day, aliases ranked, a receipt per night — and runs the view over
 * the result, which is what proves the cells line up with the drawn spine on rows
 * a sync would actually store.
 */
import { EXCEPTION_TREND_MIN_DAYS, summarizeExceptionHistory } from '@dash/shared';
import type {
  GatewayDeployment,
  GatewayExceptionHistory,
  GatewayExceptionObservation,
  GatewayExceptionSweep,
  GatewayHealth,
} from '@dash/shared';
import { MockGatewayClient } from '../src/gateway/mock.js';
import {
  EXCEPTION_HISTORY_DAYS,
  deriveExceptionHistory,
  hasExceptionHistory,
  mixShiftReason,
} from '../../web/src/lib/metrics/gatewayExceptionHistory.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
};

function shiftIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

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
  from: string,
  to: string,
  recordingSince: string | null = sweeps[0]?.date ?? observations[0]?.date ?? null,
): GatewayExceptionHistory => ({ from, to, recordingSince, observations, sweeps });

// ------------------------------------------------------------- the silences

console.log('\nthe states of "nothing to show"');

const unanswered = deriveExceptionHistory(null);
check(!unanswered.answered, 'a query in flight has not answered');
check(
  !unanswered.isEmpty && !unanswered.tooShort && unanswered.classes.length === 0,
  'and it claims nothing else: not empty, not short, no classes',
);
check(!hasExceptionHistory(unanswered), 'so the card does not render');

const never = deriveExceptionHistory(history([], [], '2026-06-01', '2026-07-30', null));
check(
  never.answered && never.isEmpty,
  'a table with no sweep ever filed has answered and is empty — the recording has not started',
);
check(
  !hasExceptionHistory(never),
  'and the card stands down rather than drawing a clean sheet a refused sweep would draw too',
);
check(
  never.total === 0 && never.worstDay === null && never.biggestShift === null,
  'with no total, no worst night and no shift invented out of it',
);

// The one silence this layer can *report*: swept, and nothing failed. It is a
// finding rather than an absence, and it is only distinguishable from the one
// above because the sweep files a receipt.
const cleanRun = deriveExceptionHistory(
  history(
    [],
    [0, 1, 2].map((offset) => sweep(shiftIso('2026-07-01', offset), 4, 0, 0)),
    '2026-07-01',
    '2026-07-03',
  ),
);
check(
  hasExceptionHistory(cleanRun) && cleanRun.classes.length === 0,
  'three swept nights that recorded nothing still render — a clean gateway is a reading',
);
check(
  cleanRun.daysSwept === 3 && cleanRun.daysClean === 3 && cleanRun.daysMissed === 0,
  'and all three count as swept, clean and not missed',
);
check(
  cleanRun.days.every((day) => day.observed && day.clean && day.total === 0),
  'every drawn night is observed-and-clean rather than a hole',
);

// -------------------------------------------------------------- the passthrough

console.log('\nthe view adds no rule about the gateway');

const base = history(
  [
    observation('2026-07-01', 'azure/gpt-4o', 'gpt-4o-https://neu.example', 'RateLimitError', 30),
    observation('2026-07-02', 'azure/gpt-4o', 'gpt-4o-https://neu.example', 'Timeout', 4),
  ],
  [sweep('2026-07-01', 3, 1, 30), sweep('2026-07-02', 3, 1, 4)],
  '2026-07-01',
  '2026-07-02',
);
check(
  JSON.stringify(deriveExceptionHistory(base).summary) ===
    JSON.stringify(summarizeExceptionHistory(base)),
  'the shared summary is passed through verbatim — every claim about the gateway is the shared one',
);

// ------------------------------------------------------------------ the spine

console.log('\nthe drawn spine');

const lateStart = shiftIso('2026-07-30', -3);
const short = deriveExceptionHistory(
  history(
    [observation(lateStart, 'azure/gpt-4o', 'a-https://x', 'RateLimitError', 2)],
    [0, 1, 2, 3].map((offset) => sweep(shiftIso(lateStart, offset))),
    shiftIso('2026-07-30', -(EXCEPTION_HISTORY_DAYS - 1)),
    '2026-07-30',
    lateStart,
  ),
);
check(
  short.spineFrom === lateStart && short.dates.length === 4,
  `a ${EXCEPTION_HISTORY_DAYS}-night window on a four-night recording draws four nights`,
);
check(
  short.dates[0] === lateStart && short.dates[3] === '2026-07-30',
  'from the first night ever swept to the window end, with no back-padding',
);

const older = deriveExceptionHistory(
  history(
    [observation('2026-07-28', 'azure/gpt-4o', 'a-https://x', 'RateLimitError', 2)],
    [sweep('2026-07-28')],
    '2026-07-26',
    '2026-07-30',
    '2026-05-01',
  ),
);
check(
  older.spineFrom === '2026-07-26' && older.dates.length === 5,
  'a recording older than the window does not widen it — the clamp only ever moves forward',
);
check(
  older.daysSwept === 1 && older.daysMissed === 4,
  'and the four nights with no receipt are missed rather than clean',
);

// ------------------------------------------------------------- the three states

console.log('\nthree states per cell, never two');

const mixedRun = deriveExceptionHistory(
  history(
    [
      observation('2026-07-01', 'azure/gpt-4o', 'a-https://x', 'RateLimitError', 10),
      observation('2026-07-03', 'azure/gpt-4o', 'a-https://x', 'Timeout', 3),
    ],
    // The 2nd was swept and found nothing; the 4th was never swept.
    [sweep('2026-07-01', 3, 1, 10), sweep('2026-07-02', 3, 0, 0), sweep('2026-07-03', 3, 1, 3)],
    '2026-07-01',
    '2026-07-04',
  ),
);
check(
  mixedRun.days.map((day) => `${day.observed ? (day.clean ? 'clean' : 'recorded') : 'unread'}`).join(',') ===
    'recorded,clean,recorded,unread',
  'the gateway strip reads recorded, clean, recorded, unread across the four nights',
);
const rateLimit = mixedRun.classes.find((row) => row.class === 'rate-limit');
check(
  rateLimit?.cells.map((cell) => cell.state).join(',') === 'recorded,clean,clean,unobserved',
  'a class strip calls a swept night without that class clean and an unswept one unobserved',
);
check(
  rateLimit?.cells[3]?.count === 0 && rateLimit?.cells[1]?.count === 0,
  'both carry a zero count — the count cannot be read without the state, which is the point',
);
check(
  mixedRun.daysSwept === 3 && mixedRun.daysClean === 1 && mixedRun.daysMissed === 1,
  'three swept, one of them clean, one missed — the receipt is what separates the last two',
);
check(
  mixedRun.classes.every(
    (row) => row.cells.reduce((sum, cell) => sum + cell.count, 0) === row.count,
  ),
  'and every class’s cells sum to its own window count, so the strip cannot drift from the roll-up',
);

// ------------------------------------------------------------------- tooShort

console.log('\ntoo short for a mix shift');

const nightsFor = (n: number, type = 'RateLimitError') =>
  Array.from({ length: n }, (_, index) =>
    observation(shiftIso('2026-07-01', index), 'azure/gpt-4o', 'a-https://x', type, 10),
  );
const receiptsFor = (n: number) =>
  Array.from({ length: n }, (_, index) => sweep(shiftIso('2026-07-01', index), 3, 1, 10));

const justUnder = deriveExceptionHistory(
  history(
    nightsFor(EXCEPTION_TREND_MIN_DAYS - 1),
    receiptsFor(EXCEPTION_TREND_MIN_DAYS - 1),
    '2026-07-01',
    shiftIso('2026-07-01', EXCEPTION_TREND_MIN_DAYS - 2),
  ),
);
check(
  justUnder.tooShort && justUnder.summary.trend === null && justUnder.biggestShift === null,
  `${EXCEPTION_TREND_MIN_DAYS - 1} swept nights is too short and the shift is withheld`,
);
const justOver = deriveExceptionHistory(
  history(
    nightsFor(EXCEPTION_TREND_MIN_DAYS),
    receiptsFor(EXCEPTION_TREND_MIN_DAYS),
    '2026-07-01',
    shiftIso('2026-07-01', EXCEPTION_TREND_MIN_DAYS - 1),
  ),
);
check(
  !justOver.tooShort && justOver.summary.trend !== null,
  'and one more night is enough for both halves, so a direction appears',
);
check(
  justOver.summary.trend !== null &&
    justOver.summary.trend.earlier.days + justOver.summary.trend.recent.days ===
      EXCEPTION_TREND_MIN_DAYS,
  'the two halves cover every swept night and invent none',
);
check(
  justOver.biggestShift?.deltaPoints === 0,
  'an unchanging mix moves zero points — the counts are identical night to night',
);

// A scheduler that missed four of nine nights swept five, and the gate counts
// what was read rather than what the calendar holds.
const sparse = deriveExceptionHistory(
  history(
    [0, 2, 4, 6, 8].map((offset) =>
      observation(shiftIso('2026-07-01', offset), 'azure/gpt-4o', 'a-https://x', 'RateLimitError', 5),
    ),
    [0, 2, 4, 6, 8].map((offset) => sweep(shiftIso('2026-07-01', offset), 3, 1, 5)),
    '2026-07-01',
    '2026-07-09',
  ),
);
check(
  sparse.dates.length === 9 && sparse.daysSwept === 5 && sparse.daysMissed === 4,
  'a nine-night window swept on five draws nine and counts five',
);
check(
  sparse.tooShort,
  'and it is still too short for a shift — the gate counts nights swept, not nights elapsed',
);

// -------------------------------------------------------- the withheld sentence

console.log('\na withheld direction says why');

check(
  mixShiftReason(justUnder, justUnder.classes[0]!).includes(
    `${EXCEPTION_TREND_MIN_DAYS} a half-over-half split needs`,
  ),
  'too few swept nights names the gate and the count so far',
);

// A half that recorded nothing has no mix, and every class "moving to zero"
// would be a statement about the split rather than about the gateway.
const emptyHalf = deriveExceptionHistory(
  history(
    [0, 1, 2].map((offset) =>
      observation(shiftIso('2026-07-01', offset), 'azure/gpt-4o', 'a-https://x', 'RateLimitError', 5),
    ),
    receiptsFor(6),
    '2026-07-01',
    shiftIso('2026-07-01', 5),
  ),
);
check(
  emptyHalf.summary.trend === null && !emptyHalf.tooShort,
  'six swept nights whose recent half recorded nothing withhold the shift without being short',
);
check(
  mixShiftReason(emptyHalf, emptyHalf.classes[0]!).includes('one half of the window recorded nothing'),
  'and the sentence says that rather than repeating the length gate',
);

// A class present only in the recent half is *new*, which is a different reading
// from a class that grew — and the one the card badges.
const arrived: GatewayExceptionObservation[] = [];
for (let index = 0; index < 6; index += 1) {
  const date = shiftIso('2026-07-01', index);
  arrived.push(observation(date, 'azure/gpt-4o', 'a-https://x', 'RateLimitError', 20));
  if (index >= 3) arrived.push(observation(date, 'azure/gpt-4o', 'a-https://x', 'Timeout', 20));
}
const newClass = deriveExceptionHistory(
  history(arrived, receiptsFor(6), '2026-07-01', shiftIso('2026-07-01', 5)),
);
const timeout = newClass.classes.find((row) => row.class === 'timeout');
check(
  timeout?.newInRecentHalf === true && (timeout?.shiftPoints ?? 0) > 0,
  'a class first recorded in the recent half is flagged new and moves the mix upward',
);
check(
  mixShiftReason(newClass, timeout!).includes('new in the recent half'),
  'and its sentence says so rather than quoting a share',
);
check(
  newClass.biggestShift?.class === 'timeout' || newClass.biggestShift?.class === 'rate-limit',
  'the headline shift is the largest move in either direction, whichever class it lands on',
);
check(
  new Set([
    mixShiftReason(justUnder, justUnder.classes[0]!),
    mixShiftReason(emptyHalf, emptyHalf.classes[0]!),
    mixShiftReason(newClass, timeout!),
    mixShiftReason(newClass, newClass.classes.find((row) => row.class === 'rate-limit')!),
  ]).size === 4,
  'four withheld-or-stated cases, four distinct sentences — a missing direction is never one message',
);

// ------------------------------------------------------------- the health join

console.log('\nthe join to tonight’s health reading');

const deployment = (backend: string, apiBase: string | null, healthy: boolean): GatewayDeployment => ({
  id: `${backend}-${apiBase ?? 'none'}`,
  backend,
  model: null,
  provider: 'azure',
  apiBase,
  healthy,
  error: healthy ? null : 'connection refused',
  errorStatus: healthy ? null : 503,
  checkedAt: '2026-07-30T02:00:00.000Z',
});
const health: GatewayHealth = {
  deployments: [
    deployment('azure/gpt-4o-neu', 'https://neu.example', false),
    deployment('azure/gpt-4o-weu', 'https://weu.example', true),
  ],
  checkedAt: '2026-07-30T02:00:00.000Z',
};

const joined = deriveExceptionHistory(
  history(
    [
      observation('2026-07-01', 'azure/gpt-4o', 'azure/gpt-4o-neu-https://neu.example', 'APIError', 40),
      observation('2026-07-01', 'azure/gpt-4o', 'azure/gpt-4o-weu-https://weu.example', 'Timeout', 6),
      observation('2026-07-01', 'azure/gpt-4o', 'azure/gpt-4o-gone-https://gone.example', 'APIError', 3),
    ],
    [sweep('2026-07-01', 3, 3, 49)],
    '2026-07-01',
    '2026-07-01',
  ),
  { health },
);
const verdict = (key: string) =>
  joined.deployments.find((row) => row.deployment.startsWith(key))?.health;
check(verdict('azure/gpt-4o-neu') === 'failing', 'a deployment the reading found failing reads failing');
check(verdict('azure/gpt-4o-weu') === 'healthy', 'one the reading found up reads healthy');
check(
  verdict('azure/gpt-4o-gone') === 'unread',
  'and one the reading does not name reads unread — an absent row is silence, never health',
);
check(
  deriveExceptionHistory(
    history(
      [observation('2026-07-01', 'azure/gpt-4o', 'azure/gpt-4o-neu-https://neu.example', 'APIError', 40)],
      [sweep('2026-07-01')],
      '2026-07-01',
      '2026-07-01',
    ),
  ).deployments[0]?.health === 'unread',
  'with no reading at all every deployment is unread rather than healthy',
);

// ----------------------------------------------------------------- mock half

console.log('\nthe mock, swept one night at a time and then drawn');

const mock = new MockGatewayClient();
// Ends on the 20th deliberately: the mock plants its regional incident on the
// 17th and 18th, and a run that misses it cannot demonstrate the one thing this
// card adds over the live read.
const lastNight = '2026-07-20';
const nights = 12;
const aliases = ['azure/gpt-4o', 'azure/o4-mini', 'bedrock/anthropic.claude-sonnet-4-v1:0'];

const swept: GatewayExceptionObservation[] = [];
const receipts: GatewayExceptionSweep[] = [];
for (let index = nights - 1; index >= 0; index -= 1) {
  const date = shiftIso(lastNight, -index);
  const page = await mock.fetchModelExceptions(date, date, aliases);
  let total = 0;
  const deployments = new Set<string>();
  for (const row of page.rows) {
    for (const entry of row.exceptions) {
      if (entry.count <= 0) continue;
      swept.push(observation(date, row.model, row.deployment, entry.type, entry.count));
      deployments.add(row.deployment);
      total += entry.count;
    }
  }
  receipts.push(sweep(date, aliases.length, deployments.size, total));
}

const firstNight = shiftIso(lastNight, -(nights - 1));
const view = deriveExceptionHistory(
  history(swept, receipts, firstNight, lastNight, firstNight),
  { health: null },
);

check(hasExceptionHistory(view), 'twelve stored nights render');
check(
  view.dates.length === nights && view.daysSwept === nights && view.daysMissed === 0,
  'the drawn spine is the twelve nights the sync filed, with no holes',
);
check(
  view.classes.every((row) => row.cells.length === nights),
  'and every class row carries one cell per drawn night',
);
check(
  view.classes.every((row) => row.cells.reduce((sum, cell) => sum + cell.count, 0) === row.count),
  'each class’s cells sum to its own window count on real generated rows too',
);
check(
  view.days.reduce((sum, day) => sum + day.total, 0) === view.total,
  'and the nights sum to the window total — counts add because error-log rows are disjoint',
);
check(
  view.classes.reduce((sum, row) => sum + row.count, 0) === view.total,
  'as do the classes, which is the same addition read the other way',
);
check(
  Math.abs(view.classes.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9,
  'every share is a share of what was recorded and they sum to one',
);

const incident = view.days.filter((day) => day.date === '2026-07-17' || day.date === '2026-07-18');
const ordinary = view.days.filter(
  (day) => day.observed && day.date !== '2026-07-17' && day.date !== '2026-07-18',
);
const meanOf = (days: typeof ordinary) =>
  days.length === 0 ? 0 : days.reduce((sum, day) => sum + day.total, 0) / days.length;
check(
  incident.length === 2 && meanOf(incident) > meanOf(ordinary),
  'the planted regional incident records more than an ordinary night',
);
check(
  view.worstDay !== null && (view.worstDay.date === '2026-07-17' || view.worstDay.date === '2026-07-18'),
  'and it is the worst night of the window',
);
check(
  incident.every((day) => day.dominantClass === 'backend'),
  'read as a backend-class night rather than as more of everything — the mix is the statement',
);
check(
  !view.tooShort && view.biggestShift !== null,
  'twelve swept nights are enough for a mix shift, so the headline is stated rather than withheld',
);
check(
  view.deployments.every((row) => row.health === 'unread'),
  'with no health reading supplied, every deployment row reads unread rather than up',
);

console.log(
  `\n${failures.length === 0 ? 'all checks passed' : `${failures.length} FAILED`}\n${failures
    .map((message) => `  - ${message}`)
    .join('\n')}`,
);
process.exit(failures.length === 0 ? 0 : 1);
