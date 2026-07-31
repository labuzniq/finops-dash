/**
 * Ad-hoc check of the web app's *latency history* view — the card that reads the
 * stored nightly `/model/metrics` sweeps as a sequence. Not a test suite (the
 * repo has none); run it by hand:
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-latency-history-view.ts
 *
 * `verify-gateway-latency-history.ts` already covers the recording and the
 * shared `summarizeLatencyHistory` rule — every window figure a median and
 * provably not a sum, a re-swept night keeping the later reading, two aliases on
 * one endpoint staying two rows, the badge gates, the gap arithmetic and the
 * ratio trend. This script covers only what the *view* adds, which is the
 * drawing and no rule about the gateway at all:
 *
 *  - **the summary passes through untouched**, asserted as deep equality rather
 *    than as a convention somebody could quietly break.
 *  - **the spine**, clamped forward to `recordingSince`: there is no backfill
 *    for this table, so a 60-night window on a four-night recording draws four.
 *  - **three states per cell**, and the third is not "clean" as it is on the two
 *    sibling history cards — there is no clean reading here, only a fast one, a
 *    slow one and a night nobody read.
 *  - **cells that agree with the row.** The pair is the grain, so a cell carries
 *    one reading and never a mean of two; the observed cells are exactly the
 *    nights the shared roll-up counted.
 *  - **`tooShort`**, on both sides of `LATENCY_TREND_MIN_DAYS`, and the sentence
 *    that names which silence a withheld direction is.
 *  - **the badge reason**, which has to be distinct sentences: with no counts in
 *    the payload there is no interval, so "not badged" is either "not much
 *    slower" or "barely seen" and a row rendering neither reads as fast.
 *  - **the four-state health join**, including `mixed` — the state this layer's
 *    key forces, where one `api_base` fronts deployments tonight's reading
 *    disagrees about.
 *
 * The mock half sweeps a run of nights exactly as `readLatency` does — one day
 * at a time, the window's last, one reading per (alias, key) — and runs the view
 * over the result, which is what proves the cells line up with the drawn spine
 * on rows a sync would actually store.
 */
import {
  LATENCY_ELEVATED_RATIO,
  LATENCY_MIN_DAYS,
  LATENCY_TREND_MIN_DAYS,
  summarizeLatencyHistory,
} from '@dash/shared';
import type {
  GatewayDeployment,
  GatewayHealth,
  GatewayLatencyHistory,
  GatewayLatencyObservation,
} from '@dash/shared';
import { MockGatewayClient } from '../src/gateway/mock.js';
import {
  LATENCY_HISTORY_DAYS,
  deriveLatencyHistory,
  hasLatencyHistory,
  latencyHistoryBadgeReason,
  latencyTrendReason,
} from '../../web/src/lib/metrics/gatewayLatencyHistory.js';

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

const reading = (
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
  from: string,
  to: string,
  recordingSince: string | null = observations[0]?.date ?? null,
): GatewayLatencyHistory => ({ from, to, recordingSince, observations });

const deployment = (
  backend: string,
  apiBase: string | null,
  healthy: boolean,
): GatewayDeployment => ({
  modelId: `${backend}@${apiBase ?? 'none'}`,
  model: null,
  backend,
  apiBase,
  provider: null,
  healthy,
  error: healthy ? null : 'Connection refused',
  observedAt: '2026-07-30T02:00:00.000Z',
});

const health = (deployments: GatewayDeployment[]): GatewayHealth => ({
  deployments,
  observedAt: '2026-07-30T02:00:00.000Z',
  available: true,
});

// ------------------------------------------------------------- the silences

console.log('\nthe states of "nothing to show"');

const unanswered = deriveLatencyHistory(null);
check(!unanswered.answered, 'a query in flight has not answered');
check(
  !unanswered.isEmpty && !unanswered.tooShort && unanswered.rows.length === 0,
  'and it claims nothing else: not empty, not short, no rows',
);
check(!hasLatencyHistory(unanswered), 'so the card does not render');

const emptyView = deriveLatencyHistory(history([], '2026-06-01', '2026-07-30', null));
check(
  emptyView.answered && emptyView.isEmpty,
  'a table with no rows at all has answered and is empty — the recording has not started',
);
check(
  !hasLatencyHistory(emptyView),
  'and the card stands down rather than drawing an empty strip a quiet gateway would draw too',
);
check(
  emptyView.medianSecondsPerToken === null && emptyView.worstDay === null,
  'with no rate and no slowest night invented out of it',
);
check(
  latencyTrendReason(emptyView) === 'no night has been recorded yet',
  'and the withheld direction names the empty recording rather than a short one',
);

// ------------------------------------------------------------------ the spine

console.log('\nthe drawn spine');

const late = shiftIso('2026-07-30', -3);
const shortRun = [0, 1, 2, 3].map((offset) =>
  reading(shiftIso(late, offset), 'azure/gpt-4o', 'https://eu2.openai.azure.com', 0.02),
);
const shortView = deriveLatencyHistory(
  history(shortRun, shiftIso('2026-07-30', -(LATENCY_HISTORY_DAYS - 1)), '2026-07-30', late),
);
check(
  shortView.spineFrom === late && shortView.dates.length === 4,
  'a 60-night window on a four-night recording draws four nights, not 56 empty ones',
);
check(
  shortView.daysRecorded === 4 && shortView.daysMissed === 0,
  'and none of those four reads as a night the sweep missed',
);
check(
  shortView.rows.every((row) => row.cells.length === 4),
  'every row carries exactly one cell per drawn night',
);

const early = deriveLatencyHistory(
  history(shortRun, shiftIso('2026-07-30', -9), '2026-07-30', '2026-01-01'),
);
check(
  early.spineFrom === shiftIso('2026-07-30', -9) && early.dates.length === 10,
  'a recording older than the window does not push the spine back past what was asked for',
);
check(
  early.daysMissed === 6,
  'and the six nights inside the window with no reading are counted as missed, not drawn as fast',
);

// -------------------------------------------------------- the shared summary

console.log('\nthe view adds no rule about the gateway');

const passthrough = history(
  [
    reading('2026-07-01', 'azure/gpt-4o', 'base-a', 0.02),
    reading('2026-07-02', 'azure/gpt-4o', 'base-a', 0.03),
    reading('2026-07-01', 'azure/o4-mini', 'base-b', 0.05),
  ],
  '2026-07-01',
  '2026-07-03',
  '2026-07-01',
);
const passthroughView = deriveLatencyHistory(passthrough);
check(
  JSON.stringify(passthroughView.summary) === JSON.stringify(summarizeLatencyHistory(passthrough)),
  'the summary the card renders is the shared derivation verbatim, field for field',
);
check(
  passthroughView.medianSecondsPerToken === passthroughView.summary.medianSecondsPerToken &&
    passthroughView.elevatedKeys ===
      passthroughView.summary.keys.filter((key) => key.elevated).length,
  'and every headline number is read off it rather than recomputed',
);
check(
  passthroughView.medianTokensPerSecond !== null &&
    Math.abs(
      passthroughView.medianTokensPerSecond * (passthroughView.medianSecondsPerToken ?? 1) - 1,
    ) < 1e-9,
  'the friendly unit is the reciprocal and nothing else — no token count is ever multiplied in',
);

// ------------------------------------------------------------- the three states

console.log('\nthree cell states, and the third is not "clean"');

const states = deriveLatencyHistory(
  history(
    [
      reading('2026-07-01', 'azure/gpt-4o', 'base-a', 0.02),
      reading('2026-07-02', 'azure/gpt-4o', 'base-a', 0.02),
      // Third night: three times its own median, which is what the cell tone is
      // measured against — the row's ratio column already answers "slow for the
      // gateway", so the strip answers "slow for itself".
      reading('2026-07-03', 'azure/gpt-4o', 'base-a', 0.06),
      // Fourth night unread for this pair, and read for another, so the night is
      // observed gateway-wide while this row's cell is a hole.
      reading('2026-07-04', 'azure/o4-mini', 'base-b', 0.02),
    ],
    '2026-07-01',
    '2026-07-04',
    '2026-07-01',
  ),
);
const stateRow = states.rows.find((row) => row.key === 'base-a');
check(
  stateRow?.cells.map((cell) => cell.state).join(',') === 'fast,fast,slow,unobserved',
  'a pair reads fast, fast, slow, unread across four nights — never "clean", which this layer has no such thing as',
);
check(
  stateRow?.cells[3]?.secondsPerToken === null,
  'and the unread night carries no reading at all rather than the window median filled in',
);
check(
  states.days.every((day) => day.observed) && states.daysMissed === 0,
  'the gateway strip still reads all four nights as observed — another pair reported the fourth',
);
check(
  stateRow?.cells.filter((cell) => cell.state !== 'unobserved').length === stateRow?.daysObserved,
  'the observed cells are exactly the nights the shared roll-up counted for the pair',
);
check(
  stateRow !== undefined &&
    stateRow.cells[2]?.ratioToOwnMedian !== null &&
    (stateRow.cells[2]?.ratioToOwnMedian ?? 0) >= LATENCY_ELEVATED_RATIO,
  'the slow cell is at or past the same ratio the badge uses, applied to the pair rather than the gateway',
);

// --------------------------------------------------------------- the pair grain

console.log('\nthe grain keeps the alias');

const twoAliases = deriveLatencyHistory(
  history(
    [
      reading('2026-07-01', 'azure/gpt-4o', 'https://weu.openai.azure.com', 0.02),
      reading('2026-07-01', 'azure/o4-mini', 'https://weu.openai.azure.com', 0.08),
      reading('2026-07-02', 'azure/gpt-4o', 'https://weu.openai.azure.com', 0.02),
      reading('2026-07-02', 'azure/o4-mini', 'https://weu.openai.azure.com', 0.08),
    ],
    '2026-07-01',
    '2026-07-02',
    '2026-07-01',
  ),
);
check(
  twoAliases.rows.length === 2,
  'two aliases behind one endpoint stay two rows — two averages over two workloads, with no weight to combine them',
);
check(
  twoAliases.rows.every((row) => row.cells.filter((cell) => cell.state !== 'unobserved').length === 2),
  'and each keeps its own cells rather than one row carrying both readings',
);
check(
  twoAliases.rows[0]?.cells[0]?.secondsPerToken === 0.08 &&
    twoAliases.rows[1]?.cells[0]?.secondsPerToken === 0.02,
  'the slower alias sorts first and its cell carries its own reading, not the endpoint mean of 0.05',
);
check(
  twoAliases.days[0]?.keys === 2 && twoAliases.days[0]?.models === 2,
  'the night reports two pairs across two aliases — the coverage that fades the bar rather than shortening it',
);

// --------------------------------------------------------------- a re-sweep

const reswept = deriveLatencyHistory(
  history(
    [
      reading('2026-07-01', 'azure/gpt-4o', 'base-a', 0.02),
      reading('2026-07-01', 'azure/gpt-4o', 'base-a', 0.06),
    ],
    '2026-07-01',
    '2026-07-01',
    '2026-07-01',
  ),
);
check(
  reswept.rows[0]?.cells[0]?.secondsPerToken === 0.06,
  'a night swept twice draws the later reading, never the mean of the two — that mean is the pooling this layer forbids',
);

// ------------------------------------------------------------------ tooShort

console.log('\na direction is withheld until the recording can carry one');

const belowGate: GatewayLatencyObservation[] = [];
for (let index = 0; index < LATENCY_TREND_MIN_DAYS - 1; index += 1) {
  belowGate.push(reading(shiftIso('2026-07-01', index), 'azure/gpt-4o', 'base-a', 0.02));
}
const shortTrend = deriveLatencyHistory(
  history(belowGate, '2026-07-01', shiftIso('2026-07-01', LATENCY_TREND_MIN_DAYS - 2), '2026-07-01'),
);
check(
  shortTrend.tooShort && shortTrend.summary.trend === null,
  `${LATENCY_TREND_MIN_DAYS - 1} observed nights is short of the gate, so no direction is drawn`,
);
check(
  latencyTrendReason(shortTrend).includes(`a split needs ${LATENCY_TREND_MIN_DAYS}`),
  'and the card says the missing direction is about the age of the recording, not about the backends',
);

// The recent half has to be slower as a *half*: each side of the split is a
// median of its nights, so one slow night at the end moves nothing.
const atGate = [
  ...belowGate.slice(0, 3),
  ...[3, 4, 5].map((offset) => reading(shiftIso('2026-07-01', offset), 'azure/gpt-4o', 'base-a', 0.04)),
];
const longTrend = deriveLatencyHistory(
  history(atGate, '2026-07-01', shiftIso('2026-07-01', LATENCY_TREND_MIN_DAYS - 1), '2026-07-01'),
);
check(
  !longTrend.tooShort && longTrend.summary.trend !== null,
  `one night more and the split is legal, so a direction appears at exactly ${LATENCY_TREND_MIN_DAYS}`,
);
check(
  longTrend.summary.trend !== null && longTrend.summary.trend.ratio > 1,
  'and it is a ratio above 1 for a recording that got slower — never a difference of two rates',
);

const sparse: GatewayLatencyObservation[] = [];
for (let index = 0; index < LATENCY_TREND_MIN_DAYS - 1; index += 1) {
  sparse.push(reading(shiftIso('2026-07-01', index * 4), 'azure/gpt-4o', 'base-a', 0.02));
}
const sparseView = deriveLatencyHistory(
  history(sparse, '2026-07-01', shiftIso('2026-07-01', 30), '2026-07-01'),
);
check(
  sparseView.tooShort && sparseView.dates.length === 31,
  'a month-long spine with five readings in it is still too short — the gate counts nights read, not nights drawn',
);

// --------------------------------------------------------- the badge reason

console.log('\nan unbadged row says which gate refused it');

const gateRun: GatewayLatencyObservation[] = [];
for (let index = 0; index < 6; index += 1) {
  const date = shiftIso('2026-07-01', index);
  // Five baseline pairs against the outliers, for the fixture trap every badge
  // check in this repo has hit: the gateway median is computed from the rows
  // under test, so the baseline has to own it.
  gateRun.push(reading(date, 'azure/gpt-4o', 'base-a', 0.02));
  gateRun.push(reading(date, 'azure/gpt-4o', 'base-b', 0.02));
  gateRun.push(reading(date, 'azure/gpt-4o', 'base-c', 0.02));
  gateRun.push(reading(date, 'azure/gpt-4o', 'base-d', 0.021));
  gateRun.push(reading(date, 'azure/gpt-4o', 'base-e', 0.019));
  // Materially slower, on every night: 4× the median.
  gateRun.push(reading(date, 'azure/o4-mini', 'material', 0.08));
  // Measurably slower and under the ratio: 1.2×.
  gateRun.push(reading(date, 'azure/o4-mini', 'measurable', 0.024));
}
// Slower than everything and read on two nights only — refused by the evidence
// gate, which is what this layer has instead of a significance test.
gateRun.push(reading('2026-07-01', 'azure/o4-mini', 'thin', 0.2));
gateRun.push(reading('2026-07-02', 'azure/o4-mini', 'thin', 0.2));

const gates = deriveLatencyHistory(
  history(gateRun, '2026-07-01', shiftIso('2026-07-01', 5), '2026-07-01'),
);
const rowFor = (name: string) => gates.rows.find((row) => row.key === name);
const reasonFor = (name: string) => {
  const row = rowFor(name);
  return row === undefined ? '' : latencyHistoryBadgeReason(row);
};

check(
  rowFor('material')?.elevated === true,
  'a pair reading 4× the gateway median on six nights is badged',
);
check(
  reasonFor('material').includes('× the gateway median across'),
  'and its reason states the ratio and the nights behind it',
);
check(
  rowFor('measurable')?.elevated === false &&
    reasonFor('measurable').includes(`under the ${LATENCY_ELEVATED_RATIO}×`),
  'a pair slower than the median but under the ratio is refused by materiality, and says so',
);
check(
  rowFor('thin')?.elevated === false && reasonFor('thin').includes(`under the ${LATENCY_MIN_DAYS}`),
  `a pair read on fewer than ${LATENCY_MIN_DAYS} nights is refused by the evidence gate whatever its rate`,
);
check(
  new Set(['material', 'measurable', 'thin'].map(reasonFor)).size === 3,
  'three rows, three distinct sentences — "not badged" is never one message',
);
check(
  gates.elevatedKeys === 1,
  'and exactly one pair clears both gates, so the badge names an endpoint rather than half of them',
);

// ------------------------------------------------------------ the health join

console.log('\nthe four-state health join');

const joinView = deriveLatencyHistory(
  history(
    [
      reading('2026-07-01', 'azure/gpt-4o', 'https://weu.openai.azure.com', 0.02),
      reading('2026-07-01', 'azure/gpt-4o', 'https://neu.openai.azure.com', 0.02),
      reading('2026-07-01', 'azure/gpt-4o', 'https://eus.openai.azure.com', 0.02),
      reading('2026-07-01', 'azure/gpt-4o', 'https://unnamed.openai.azure.com', 0.02),
    ],
    '2026-07-01',
    '2026-07-01',
    '2026-07-01',
  ),
  {
    health: health([
      deployment('azure/gpt-4o-weu', 'https://weu.openai.azure.com/openai/deployments/gpt-4o', true),
      deployment('azure/gpt-4o-neu', 'https://neu.openai.azure.com/openai/deployments/gpt-4o', false),
      // Two deployments on one base the reading disagrees about — the state this
      // layer's key forces, since /model/metrics keys on the base alone.
      deployment('azure/gpt-4o-eus', 'https://eus.openai.azure.com/openai/deployments/gpt-4o', true),
      deployment('azure/gpt-4o-eus2', 'https://eus.openai.azure.com/openai/deployments/gpt-4o-2', false),
    ]),
  },
);
const healthFor = (key: string) => joinView.rows.find((row) => row.key === key)?.health;
check(healthFor('https://weu.openai.azure.com') === 'healthy', 'a base the reading answered for is healthy');
check(healthFor('https://neu.openai.azure.com') === 'failing', 'a base the reading found refusing is failing');
check(
  healthFor('https://eus.openai.azure.com') === 'mixed',
  'a base fronting deployments the reading disagrees about is mixed — the rate belongs to neither',
);
check(
  healthFor('https://unnamed.openai.azure.com') === 'unread',
  'and a base tonight’s reading does not name is unread, never healthy',
);
check(
  joinView.joinedKeys === 3 && joinView.failingJoined === 1 && joinView.mixedJoins === 1,
  'the counts the card leads with follow from the same join rather than from a second pass',
);
check(
  deriveLatencyHistory(
    history([reading('2026-07-01', 'azure/gpt-4o', 'base-a', 0.02)], '2026-07-01', '2026-07-01'),
  ).rows[0]?.health === 'unread',
  'with no health payload at all every row is unread — silence, not a healthy gateway',
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

const swept: GatewayLatencyObservation[] = [];
for (let index = nights - 1; index >= 0; index -= 1) {
  const date = shiftIso(lastNight, -index);
  const page = await mock.fetchModelLatency(date, date, aliases);
  // The sync's own rule: one reading per (alias, key), the day it asked about,
  // last one winning.
  const byPair = new Map<string, GatewayLatencyObservation>();
  for (const row of page.rows) {
    if (row.date !== date) continue;
    if (!Number.isFinite(row.secondsPerToken) || row.secondsPerToken <= 0) continue;
    byPair.set(`${row.model} ${row.key}`, reading(date, row.model, row.key, row.secondsPerToken));
  }
  swept.push(...byPair.values());
}

const firstNight = shiftIso(lastNight, -(nights - 1));
const observedAt = new Date().toISOString();
const view = deriveLatencyHistory(history(swept, firstNight, lastNight, firstNight), {
  health: {
    deployments: (await mock.fetchHealth()).map((row) => ({
      modelId: row.id,
      // Resolved by the sync in production; irrelevant to this join, which runs
      // on the backend and base alone.
      model: null,
      backend: row.backend,
      apiBase: row.apiBase,
      provider: row.provider,
      healthy: row.healthy,
      error: row.error,
      observedAt,
    })),
    observedAt,
    available: true,
  },
});

check(hasLatencyHistory(view), 'twelve stored nights render');
check(
  view.dates.length === nights && view.daysRecorded === nights && view.daysMissed === 0,
  'the drawn spine is the twelve nights the sync filed, with no holes',
);
check(
  view.rows.every((row) => row.cells.length === nights),
  'and every pair row carries one cell per drawn night',
);
check(
  view.rows.every(
    (row) => row.cells.filter((cell) => cell.state !== 'unobserved').length === row.daysObserved,
  ),
  'the observed cells of each row are exactly the nights the shared roll-up counted for it',
);
check(
  view.rows.every((row) => {
    const values = row.cells
      .filter((cell) => cell.secondsPerToken !== null)
      .map((cell) => cell.secondsPerToken as number)
      .sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const expected =
      values.length === 0
        ? 0
        : values.length % 2 === 1
          ? values[middle]!
          : (values[middle - 1]! + values[middle]!) / 2;
    return Math.abs(expected - row.medianSecondsPerToken) < 1e-12;
  }),
  'each row is the median of exactly its own drawn cells — the strip and the number cannot disagree',
);
check(
  view.days.every((day) => day.keys > 0 && day.models > 0),
  'every drawn night reports how many pairs and aliases produced it, which fades the bar rather than shortening it',
);
check(
  view.rows.every((row) => row.medianSecondsPerToken > 0 && row.tokensPerSecond !== null),
  'no reading round-trips to zero — a non-positive rate is a parse failure, not an instant deployment',
);

const slowest = view.slowest;
check(
  slowest !== null && slowest.medianSecondsPerToken === view.rows[0]?.medianSecondsPerToken,
  'the slowest pair is the head of the ranking rather than a second computation',
);
check(
  view.summary.trend !== null && !view.tooShort,
  'twelve nights is enough for a direction, so the card draws one',
);
check(
  view.worstDay !== null &&
    view.worstDay.medianSecondsPerToken !== null &&
    view.days.every(
      (day) => !day.observed || (day.medianSecondsPerToken ?? 0) <= (view.worstDay?.medianSecondsPerToken ?? 0),
    ),
  'and the slowest night is the maximum of the drawn nightly medians, never of a pair reading',
);
check(
  view.rows.some((row) => row.health !== 'unread'),
  'the health join lands on the mock’s own endpoints rather than reading as silence everywhere',
);

// A window read in one call must agree with the same nights swept one at a time
// on the pair medians — the stored table is the sweep, not a re-derivation.
const oneShot = await mock.fetchModelLatency(firstNight, lastNight, aliases);
const oneShotPairs = new Set(oneShot.rows.map((row) => `${row.model} ${row.key}`));
check(
  view.rows.every((row) => oneShotPairs.has(`${row.model} ${row.key}`)),
  'every pair the nightly sweeps stored is a pair the same window answered in one call',
);

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('gateway latency history view: all checks passed');
