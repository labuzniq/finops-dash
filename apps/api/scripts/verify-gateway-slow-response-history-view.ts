/**
 * Ad-hoc check of the web app's *hang history* view — the card that reads the
 * stored nightly `/model/metrics/slow_responses` sweeps as a sequence. Not a
 * test suite (the repo has none); run it by hand:
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-slow-response-history-view.ts
 *
 * `verify-gateway-slow-response-history.ts` already covers the recording and the
 * shared `summarizeSlowResponseHistory` rule — the pooled counts, both badge
 * gates restated over them, `excessSlow` summing to zero, the unobserved-day
 * arithmetic, and the half-over-half trend pooled rather than averaged. This
 * script covers only what the *view* adds, which is the drawing and no rule
 * about the gateway at all:
 *
 *  - **the summary passes through untouched.** The card's every claim about the
 *    gateway must be the shared function's, asserted as deep equality rather
 *    than as a convention somebody could quietly break.
 *  - **the spine**, clamped forward to `recordingSince`. There is no backfill for
 *    this table — the sweep asks about one settled day and files the answer — so
 *    a 60-night window on a four-night recording draws four nights.
 *  - **three states per cell.** An unread night is a hole in the row strip and in
 *    the gateway strip. A clean night and a night the sweep never ran leave the
 *    same absence of rows behind and are opposite claims.
 *  - **cells that agree with the row.** Two aliases behind one endpoint on one
 *    night are two disjoint counts of it, so the cell is their sum and the row's
 *    pooled counts are the sum of its own cells.
 *  - **`tooShort`**, asserted on both sides of `SLOW_RESPONSE_TREND_MIN_DAYS`:
 *    below it a direction is a fact about the age of the recording.
 *  - **the badge reason**, which has to be three different sentences, because
 *    "not badged" means "inside the noise", "not material" or "barely seen".
 *
 * The mock half simulates a run of nightly syncs exactly as `readSlowResponses`
 * does — one day at a time, the window's last — and runs the view over the
 * result, which is what proves the cells line up with the drawn spine on rows a
 * sync would actually store.
 */
import {
  SLOW_RESPONSE_ELEVATED_RATIO,
  SLOW_RESPONSE_MIN_COUNT,
  SLOW_RESPONSE_TREND_MIN_DAYS,
  UNKEYED_DEPLOYMENT,
  summarizeSlowResponseHistory,
} from '@dash/shared';
import type { GatewaySlowResponseHistory, GatewaySlowResponseObservation } from '@dash/shared';
import { MockGatewayClient } from '../src/gateway/mock.js';
import {
  SLOW_RESPONSE_HISTORY_DAYS,
  deriveSlowResponseHistory,
  hangBadgeReason,
  hasSlowResponseHistory,
} from '../../web/src/lib/metrics/gatewaySlowResponseHistory.js';

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
  from: string,
  to: string,
  recordingSince: string | null = observations[0]?.date ?? null,
): GatewaySlowResponseHistory => ({ from, to, recordingSince, observations });

// ------------------------------------------------------------- the silences

console.log('\nthe three states of "nothing to show"');

const unanswered = deriveSlowResponseHistory(null);
check(!unanswered.answered, 'a query in flight has not answered');
check(
  !unanswered.isEmpty && !unanswered.tooShort && unanswered.rows.length === 0,
  'and it claims nothing else: not empty, not short, no rows',
);
check(!hasSlowResponseHistory(unanswered), 'so the card does not render');

const emptyView = deriveSlowResponseHistory(
  history([], '2026-06-01', '2026-07-30', null),
);
check(
  emptyView.answered && emptyView.isEmpty,
  'a table with no rows at all has answered and is empty — the recording has not started',
);
check(
  !hasSlowResponseHistory(emptyView),
  'and the card stands down rather than drawing an empty strip a quiet gateway would draw too',
);
check(
  emptyView.share === null && emptyView.worstDay === null,
  'with no rate and no worst night invented out of it',
);

// ------------------------------------------------------------------ the spine

console.log('\nthe drawn spine');

const late = shiftIso('2026-07-30', -3);
const shortRun = [0, 1, 2, 3].map((offset) =>
  observation(shiftIso(late, offset), 'azure/gpt-4o', 'https://eu2.openai.azure.com', 1_000, 4),
);
const shortView = deriveSlowResponseHistory(
  history(shortRun, shiftIso('2026-07-30', -(SLOW_RESPONSE_HISTORY_DAYS - 1)), '2026-07-30', late),
);
check(
  shortView.spineFrom === late && shortView.dates.length === 4,
  'a 60-night window on a four-night recording draws four nights, not 56 empty ones',
);
check(
  shortView.dates[0] === late && shortView.dates[3] === '2026-07-30',
  'and the drawn spine runs from the first night ever filed to the window end',
);
check(
  shortView.daysRecorded === 4 && shortView.daysMissed === 0,
  'every drawn night carries a sweep, so none is reported missing',
);

const older = deriveSlowResponseHistory(
  history(shortRun, '2026-07-24', '2026-07-30', '2026-01-01'),
);
check(
  older.spineFrom === '2026-07-24' && older.dates.length === 7,
  'a recording older than the window leaves the window alone — the clamp only ever moves forward',
);
check(
  older.daysMissed === 3,
  'and the three nights inside it with no sweep are counted as missed rather than as clean',
);

// --------------------------------------------------------------- the cells

console.log('\nthree states per cell, never two');

const key = 'https://eu2.openai.azure.com';
const gaps = deriveSlowResponseHistory(
  history(
    [
      observation('2026-07-01', 'azure/gpt-4o', key, 1_000, 0),
      // 2026-07-02: the sweep did not run.
      observation('2026-07-03', 'azure/gpt-4o', key, 1_000, 30),
    ],
    '2026-07-01',
    '2026-07-03',
    '2026-07-01',
  ),
);
const cells = gaps.rows[0]?.cells ?? [];
check(cells.length === 3, 'the row carries one cell per drawn night');
check(cells[0]?.state === 'clean', 'a night with a sweep and no hang is clean');
check(cells[1]?.state === 'unobserved', 'a night with no sweep is a hole, never a clean cell');
check(cells[2]?.state === 'hangs', 'and a night with a hang is its own state');
check(
  cells[1]?.share === null && cells[1]?.total === 0,
  'an unread night carries no share and no denominator — nothing is filled in',
);
check(
  gaps.days[1]?.observed === false && gaps.daysMissed === 1,
  'and the gateway strip has the same hole on the same night',
);
check(
  gaps.worstDay?.date === '2026-07-03',
  'the worst night is the observed one with the highest share',
);
check(
  gaps.days[0]?.observed === true && gaps.worstDay?.date !== '2026-07-01',
  'and a night with no hangs never wins it, however many requests it grouped',
);

const twoAliases = deriveSlowResponseHistory(
  history(
    [
      observation('2026-07-01', 'azure/gpt-4o', key, 600, 6),
      observation('2026-07-01', 'azure/o4-mini', key, 400, 2),
    ],
    '2026-07-01',
    '2026-07-01',
    '2026-07-01',
  ),
);
const merged = twoAliases.rows[0];
check(
  merged?.cells[0]?.total === 1_000 && merged?.cells[0]?.slow === 8,
  'two aliases behind one endpoint on one night are two disjoint counts of it, so the cell adds them',
);
check(
  merged?.total === 1_000 && merged?.slow === 8,
  'and the row pools to the same numbers its cells carry',
);
check(
  merged?.models.join(',') === 'azure/gpt-4o,azure/o4-mini',
  'with both aliases named on the row, since the endpoint is what the proxy grouped by',
);

// -------------------------------------------------------------- passthrough

console.log('\nthe view adds no rule about the gateway');

const mixedRun: GatewaySlowResponseObservation[] = [];
for (let index = 0; index < 8; index += 1) {
  const date = shiftIso('2026-07-01', index);
  mixedRun.push(observation(date, 'azure/gpt-4o', 'https://eu2.openai.azure.com', 4_000, 12));
  mixedRun.push(observation(date, 'azure/o4-mini', 'https://neu-ptu.openai.azure.com', 500, 40));
  mixedRun.push(observation(date, 'bedrock/claude', UNKEYED_DEPLOYMENT, 3_000, 9));
}
const mixedHistory = history(mixedRun, '2026-07-01', '2026-07-08', '2026-07-01');
const mixed = deriveSlowResponseHistory(mixedHistory);
check(
  JSON.stringify(mixed.summary) === JSON.stringify(summarizeSlowResponseHistory(mixedHistory)),
  'the summary is the shared derivation verbatim — every claim about the gateway lives there',
);
check(
  mixed.total === mixed.summary.total &&
    mixed.slow === mixed.summary.slow &&
    mixed.share === mixed.summary.share,
  'and the headline numbers are read off it rather than recomputed',
);
check(
  mixed.rows.map((row) => row.key).join('|') === mixed.summary.keys.map((row) => row.key).join('|'),
  'the row order is the shared ranking, untouched',
);
check(
  mixed.rows.reduce((sum, row) => sum + row.slow, 0) === mixed.slow,
  'every hang is attributed to exactly one endpoint row',
);
check(
  mixed.elevatedKeys === mixed.summary.keys.filter((row) => row.elevated).length,
  'and the badged count is the shared one — this card adds no threshold',
);
check(
  mixed.rows.find((row) => row.key === UNKEYED_DEPLOYMENT)?.isUnkeyed === true,
  'the api_base-less bucket is flagged as unattributable rather than drawn as an endpoint',
);
check(
  mixed.rows.filter((row) => row.isUnkeyed).length === 1,
  'and nothing else is: it is the proxy’s own GROUP BY bucket, not a state a real endpoint takes',
);

const ptuRow = mixed.rows.find((row) => row.key.includes('neu-ptu'));
check(
  ptuRow?.elevated === true,
  'the endpoint at 8% against a window of ~1.3% clears both gates over the pooled counts',
);
check(
  ptuRow !== undefined && ptuRow.cells.every((cell) => cell.state === 'hangs'),
  'and every one of its nights recorded a hang, which is what makes it a fault rather than an evening',
);

// ------------------------------------------------------------------- tooShort

console.log('\ntoo short for a direction');

const nightsFor = (n: number) =>
  Array.from({ length: n }, (_, index) =>
    observation(shiftIso('2026-07-01', index), 'azure/gpt-4o', key, 1_000, 5),
  );

const justUnder = deriveSlowResponseHistory(
  history(
    nightsFor(SLOW_RESPONSE_TREND_MIN_DAYS - 1),
    '2026-07-01',
    shiftIso('2026-07-01', SLOW_RESPONSE_TREND_MIN_DAYS - 2),
    '2026-07-01',
  ),
);
check(
  justUnder.tooShort && justUnder.summary.trend === null,
  `${SLOW_RESPONSE_TREND_MIN_DAYS - 1} observed nights is too short and the trend is withheld`,
);
const justOver = deriveSlowResponseHistory(
  history(
    nightsFor(SLOW_RESPONSE_TREND_MIN_DAYS),
    '2026-07-01',
    shiftIso('2026-07-01', SLOW_RESPONSE_TREND_MIN_DAYS - 1),
    '2026-07-01',
  ),
);
check(
  !justOver.tooShort && justOver.summary.trend !== null,
  'and one more night is enough for both halves, so the direction appears',
);
check(
  justOver.summary.trend !== null &&
    justOver.summary.trend.earlier.days + justOver.summary.trend.recent.days ===
      SLOW_RESPONSE_TREND_MIN_DAYS,
  'the two halves cover every observed night and invent none',
);

// A scheduler that missed four of nine nights has five observed ones, and the
// gate counts what was read rather than what the calendar holds.
const sparse = deriveSlowResponseHistory(
  history(
    [0, 2, 4, 6, 8].map((offset) =>
      observation(shiftIso('2026-07-01', offset), 'azure/gpt-4o', key, 1_000, 5),
    ),
    '2026-07-01',
    '2026-07-09',
    '2026-07-01',
  ),
);
check(
  sparse.dates.length === 9 && sparse.daysRecorded === 5 && sparse.daysMissed === 4,
  'a nine-night window read on five nights draws nine and records five',
);
check(
  sparse.tooShort,
  'and it is still too short for a direction — the gate counts nights read, not nights elapsed',
);

// ---------------------------------------------------------- the badge reason

console.log('\nan unbadged row says which gate refused it');

const gateRun: GatewaySlowResponseObservation[] = [];
for (let index = 0; index < 6; index += 1) {
  const date = shiftIso('2026-07-01', index);
  // Baseline keys carry most of the traffic, or the outliers drag the very
  // window share they are being measured against — the fixture trap every badge
  // check in this repo has hit.
  gateRun.push(observation(date, 'azure/gpt-4o', 'base-a', 20_000, 200));
  gateRun.push(observation(date, 'azure/gpt-4o', 'base-b', 20_000, 200));
  gateRun.push(observation(date, 'azure/o4-mini', 'material', 2_000, 100));
  gateRun.push(observation(date, 'azure/o4-mini', 'measurable', 6_000, 90));
  gateRun.push(observation(date, 'azure/gpt-4o', 'below', 4_000, 20));
}
// Read on one night only, and badly that night: 20% of its requests hung, far
// above anything else here, on four hangs. The interval passes it and the floor
// is what refuses it — the materiality gate the reliability card needed for the
// opposite reason, since two calls both hanging is unlikely at 1% and still not
// a finding.
gateRun.push(observation('2026-07-01', 'azure/gpt-4o', 'quiet', 20, 4));
const gates = deriveSlowResponseHistory(
  history(gateRun, '2026-07-01', shiftIso('2026-07-01', 5), '2026-07-01'),
);
const rowFor = (name: string) => gates.rows.find((row) => row.key === name);
const reasonFor = (name: string) => {
  const row = rowFor(name);
  return row === undefined ? '' : hangBadgeReason(row, gates.share);
};

check(rowFor('material')?.elevated === true, 'the endpoint at 5% against a ~1% window is badged');
check(
  reasonFor('material').includes('× the window rate over'),
  'and its reason states the ratio and the evidence behind it',
);
check(
  rowFor('measurable')?.elevated === false &&
    reasonFor('measurable').includes(`under the ${SLOW_RESPONSE_ELEVATED_RATIO}×`),
  'an endpoint measurably above the window rate but under the ratio is refused by materiality',
);
check(
  rowFor('below')?.elevated === false && reasonFor('below').includes('inside the noise'),
  'an endpoint at the window rate is refused by the interval, and says so in those words',
);
check(
  rowFor('quiet')?.elevated === false &&
    reasonFor('quiet').includes(`under the ${SLOW_RESPONSE_MIN_COUNT}`),
  `an endpoint with fewer than ${SLOW_RESPONSE_MIN_COUNT} hangs is refused by the floor whatever its share`,
);
check(
  new Set(['material', 'measurable', 'below', 'quiet'].map(reasonFor)).size === 4,
  'four rows, four distinct sentences — "not badged" is never one message',
);
check(
  hangBadgeReason(gates.rows[0]!, null) === 'no window rate to compare against',
  'and with no window rate the card compares nothing rather than assuming a baseline',
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

const swept: GatewaySlowResponseObservation[] = [];
for (let index = nights - 1; index >= 0; index -= 1) {
  const date = shiftIso(lastNight, -index);
  const page = await mock.fetchModelSlowResponses(date, date, aliases);
  for (const row of page.rows) swept.push(observation(date, row.model, row.key, row.total, row.slow));
}

const firstNight = shiftIso(lastNight, -(nights - 1));
const view = deriveSlowResponseHistory(history(swept, firstNight, lastNight, firstNight));

check(hasSlowResponseHistory(view), 'twelve stored nights render');
check(
  view.dates.length === nights && view.daysRecorded === nights && view.daysMissed === 0,
  'the drawn spine is the twelve nights the sync filed, with no holes',
);
check(
  view.rows.every((row) => row.cells.length === nights),
  'and every endpoint row carries one cell per drawn night',
);
check(
  view.rows.every(
    (row) =>
      row.cells.reduce((sum, cell) => sum + cell.slow, 0) === row.slow &&
      row.cells.reduce((sum, cell) => sum + cell.total, 0) === row.total,
  ),
  'each row pools to exactly what its own cells carry — the strip and the number cannot disagree',
);
check(
  view.days.reduce((sum, day) => sum + day.slow, 0) === view.slow,
  'and the gateway strip adds back to the window total, because these are disjoint counts',
);
check(
  view.rows.every((row) => row.cells.filter((cell) => cell.state !== 'unobserved').length === row.daysObserved),
  'observed nights on the strip are the observed nights the shared roll-up counted',
);

const ptu = view.rows.find((row) => row.key.includes('neu-ptu'));
check(ptu?.elevated === true, 'the refusing reserved pool is the badged endpoint over the run');
check(
  view.elevatedKeys === 1,
  'and it is the only one, so the badge still names an endpoint rather than half of them',
);
check(
  view.worstDay !== null && ['17', '18'].includes(view.worstDay.date.slice(8, 10)),
  'the worst night is one of the two the mock plants a regional incident on',
);
check(
  view.worstDay !== null && view.worstDay.keys > 0 && view.worstDay.share !== null,
  'and it carries how many endpoints reported it, which is what fades the bar rather than shortening it',
);
check(
  view.summary.trend !== null && !view.tooShort,
  'twelve nights is enough for a direction, so the card draws one',
);

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('gateway slow-response history view: all checks passed');
