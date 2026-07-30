/**
 * Ad-hoc check of the web app's unusual-spend derivations against a real
 * mock-source payload. Not a test suite (the repo has none) — run it by hand:
 *
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-anomaly.ts
 *
 * It sits outside apps/api's tsconfig `include` on purpose: it imports the web
 * app's metrics modules, which do not belong in the API's build.
 */
import { MockGatewayClient } from '../src/gateway/mock.js';
import { nanoToDollars } from '../src/lib/nano.js';
import { EMPTY_GATEWAY_METRICS, GATEWAY_DIMENSIONS } from '@dash/shared';
import type { GatewayBreakdownPoint, GatewayDailyPoint, GatewayUsage } from '@dash/shared';
import { deriveGateway } from '../../web/src/lib/metrics/gateway.js';
import {
  attributeAnomaly,
  detectSpendAnomalies,
  DEFAULT_ANOMALY_OPTIONS,
} from '../../web/src/lib/metrics/gatewayAnomaly.js';

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

const from = iso(-(DAYS - 1));
const to = iso(0);
const usage = await pull(from, iso(-1));
const summary = deriveGateway(usage, from, to);

// ---------------------------------------------------------------- detection

const anomalies = detectSpendAnomalies(summary.daily);
console.log(
  `${summary.daily.length}d spine · ${anomalies.length} unusual day(s) · $${summary.totals.spend.toFixed(2)} total`,
);
for (const anomaly of anomalies) {
  console.log(
    `  ${anomaly.date}  $${anomaly.spend.toFixed(2)} vs $${anomaly.baseline.toFixed(2)} baseline · +${(anomaly.excessShare * 100).toFixed(0)}% · z=${anomaly.score === null ? 'n/a' : anomaly.score.toFixed(1)}`,
  );
}

// The mock runs a twice-monthly re-embedding batch on the 9th and the 23rd.
// A weekend burst is deliberately *not* expected to register: weekend traffic
// collapses to ~16% of a weekday, so six times a 14%-weight key still lands
// below the working-week median. Only the weekday bursts are overruns.
const isWeekend = (date: string): boolean => {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
};
const burstDays = summary.daily
  .slice(DEFAULT_ANOMALY_OPTIONS.minHistory)
  .filter((day) => [9, 23].includes(Number(day.date.slice(8, 10))))
  .map((day) => day.date);
const weekdayBursts = burstDays.filter((day) => !isWeekend(day));
check(
  weekdayBursts.length >= 2,
  `expected ≥2 judged weekday burst days in ${DAYS}d, found ${weekdayBursts.length}`,
);

const flagged = new Set(anomalies.map((anomaly) => anomaly.date));
for (const day of weekdayBursts) {
  check(flagged.has(day), `${day}: mock batch burst was not flagged`);
}
for (const day of flagged) {
  check(burstDays.includes(day), `${day}: flagged a day the mock did not burst on`);
}

// Weekends collapse to ~16% of a weekday and must never read as anomalous:
// only overruns are flagged, and a card that fires every Saturday is a card
// nobody reads.
const weekendFlagged = [...flagged].filter(isWeekend);
check(weekendFlagged.length === 0, `weekend days flagged as overruns: ${weekendFlagged.join(', ')}`);

// The first `minHistory` days are never judged — no baseline exists yet.
const earliestJudged = summary.daily[DEFAULT_ANOMALY_OPTIONS.minHistory]?.date ?? '';
check(
  anomalies.every((anomaly) => anomaly.date >= earliestJudged),
  'a day inside the minimum-history prefix was judged',
);
check(
  anomalies.every((anomaly) => anomaly.excess > 0 && anomaly.spend > anomaly.baseline),
  'an anomaly was reported without an overrun',
);
check(
  anomalies.every(
    (anomaly, index) => index === 0 || (anomalies[index - 1]?.excess ?? 0) >= anomaly.excess,
  ),
  'anomalies are not ordered by the size of the overrun',
);

// A flat series has no spread, so the robust score is undefined — the relative
// gate alone must still catch a doubling, and must not fire on a nudge.
const flat = Array.from({ length: 20 }, (_, index) => ({
  date: iso(-40 + index),
  ...EMPTY_GATEWAY_METRICS,
  spend: 100,
}));
check(detectSpendAnomalies(flat).length === 0, 'a perfectly flat series produced an anomaly');

const spiked = flat.map((day, index) => (index === 15 ? { ...day, spend: 400 } : day));
const spikeHits = detectSpendAnomalies(spiked);
check(spikeHits.length === 1, `a single injected spike produced ${spikeHits.length} anomalies`);
check(spikeHits[0]?.date === spiked[15]?.date, 'the injected spike was flagged on the wrong day');
check(spikeHits[0]?.score === null, 'a flat baseline should have no robust score to report');

const nudged = flat.map((day, index) => (index === 15 ? { ...day, spend: 110 } : day));
check(detectSpendAnomalies(nudged).length === 0, 'a 10% nudge cleared the materiality gate');

// A window that starts from nothing is new traffic, not an anomaly.
const waking = flat.map((day, index) => ({ ...day, spend: index < 12 ? 0 : 100 }));
check(detectSpendAnomalies(waking).length === 0, 'traffic starting from zero was flagged');

// -------------------------------------------------------------- attribution

const worst = anomalies[0];
if (worst === undefined) {
  console.error('no anomaly to attribute — detection failed above');
  process.exit(1);
}

console.log(`\nattributing ${worst.date} (+$${worst.excess.toFixed(2)} over the median)`);

for (const dimension of GATEWAY_DIMENSIONS) {
  if (summary.breakdowns[dimension].length === 0) continue;

  const attribution = attributeAnomaly(usage.breakdowns, dimension, worst.date, summary.daily);
  const signed = attribution.contributors.reduce((total, row) => total + row.excess, 0);

  // The load-bearing invariant: attribution uses a trailing *mean* precisely
  // because means add up, so a full-coverage dimension's per-key overruns must
  // reproduce the gateway's overrun exactly. `mcp_server` slices a subset of
  // the same requests and can only account for part of it.
  if (dimension === 'mcp_server') {
    check(
      Math.abs(signed) <= Math.abs(attribution.excess) + 1e-6,
      `${dimension}: subset overran more than the gateway did`,
    );
  } else {
    check(
      Math.abs(signed - attribution.excess) < 1e-6,
      `${dimension}: contributions sum to ${signed.toFixed(6)}, gateway overran ${attribution.excess.toFixed(6)}`,
    );
  }

  check(
    attribution.contributors.every(
      (row, index) => index === 0 || (attribution.contributors[index - 1]?.excess ?? 0) >= row.excess,
    ),
    `${dimension}: contributors are not ordered by overrun`,
  );

  const top = attribution.contributors[0];
  check(top !== undefined, `${dimension}: no contributor for a flagged day`);
  check(
    top === undefined || Math.abs((top.share ?? 0) - top.excess / attribution.excess) < 1e-9,
    `${dimension}: share is not the contributor's part of the overrun`,
  );

  console.log(
    `  ${dimension.padEnd(11)} top ${top?.label ?? top?.key ?? '—'} +$${(top?.excess ?? 0).toFixed(2)} (${((top?.share ?? 0) * 100).toFixed(0)}% of the overrun)`,
  );
}

// The mock bursts the `batch`-tagged data-platform key, so the tag dimension
// must name it — attribution that cannot find a known culprit is decoration.
const byTag = attributeAnomaly(usage.breakdowns, 'tag', worst.date, summary.daily);
check(byTag.contributors[0]?.key === 'batch', `tag attribution named ${byTag.contributors[0]?.key}, not batch`);
check(
  (byTag.contributors[0]?.share ?? 0) > 0.5,
  'the batch tag should own most of the overrun it caused',
);

// A day the spine does not carry has nothing to attribute, and says so rather
// than dividing by a window that does not exist.
const missing = attributeAnomaly(usage.breakdowns, 'model', '1999-01-01', summary.daily);
check(missing.contributors.length === 0, 'attributed an overrun on a day outside the spine');
check(missing.excess === 0 && missing.baseline === 0, 'a day outside the spine reported a baseline');

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log('\nall anomaly invariants hold');
