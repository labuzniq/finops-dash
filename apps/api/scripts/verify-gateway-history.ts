/**
 * Ad-hoc check of the web app's monthly ledger — the card that reads
 * `gateway_month` as a series. Not a test suite (the repo has none) — run it by
 * hand, with the API's env loaded for the Postgres section:
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-history.ts
 *
 * The seal itself is covered elsewhere: `verify-gateway-seal.ts` proves a month
 * is sealed only when complete and that a re-seal revises rather than
 * overwrites. What is left, and what this script is for, is what happens when
 * those records are read as a *history*:
 *
 *  - **An unsealed month is a hole, never a zero.** It is the one way this card
 *    could lie, and it lies twice if allowed to: a zero bar in the strip reads
 *    as a free month, and a month-over-month change measured *across* the hole
 *    turns a missing August into a doubled September. So an unsealed month
 *    carries nulls, sits outside every total, and kills the comparison of the
 *    month after it rather than reaching past it.
 *  - **The sum is over the sealed months only, and is legal.** Calendar months
 *    are disjoint spans of one gateway-wide total, which is the single axis on
 *    this page that may be added — unlike the overlapping breakdown dimensions
 *    and unlike budget counters on their own periods. The check is that the
 *    total moves by exactly the month it gained and by nothing else.
 *  - **Only the current statement counts.** The route filters superseded
 *    revisions, but the payload type carries `supersededAt`, so a superseded row
 *    reaching the module must not be read as the month's cost — and a month
 *    whose *only* row is superseded is a hole, not a bill.
 *  - **The ledger outlives the proxy's window.** A sealed month whose last day
 *    is older than the retention floor is history this database alone holds;
 *    that is a property of the row, and the card marks it.
 *
 * The Postgres half plants a pair of months (plus a superseded revision) shaped
 * like the ones earlier syncs would have written, reads them back through the
 * same `listGatewaySeals()` the route calls, and deletes exactly what it
 * planted — the plant/assert/restore shape the seal-revision and
 * budget-history scripts use, for the same reason: a dev database has no
 * multi-month history to read, and the feature is about months it does not have.
 */
import type { GatewayMetrics, GatewaySeal, GatewaySeals } from '@dash/shared';
import {
  deriveLedger,
  hasLedger,
  ledgerPeak,
  MAX_LEDGER_MONTHS,
  shiftMonth,
} from '../../web/src/lib/metrics/gatewayHistory.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};

/** Today, fixed: every answer here moves at midnight. */
const TODAY = '2026-07-15';
/** `today − 90`, the same floor the page computes. */
const FLOOR = '2026-04-16';
const OPTIONS = { todayIso: TODAY, retentionFloorIso: FLOOR };

function metrics(spend: number, over: Partial<GatewayMetrics> = {}): GatewayMetrics {
  return {
    spend,
    requests: 1_000,
    successfulRequests: 980,
    failedRequests: 20,
    promptTokens: 800_000,
    completionTokens: 200_000,
    totalTokens: 1_000_000,
    cacheReadTokens: 100_000,
    cacheCreationTokens: 10_000,
    ...over,
  };
}

/** Last calendar day of `YYYY-MM`, UTC. */
function monthEnd(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return new Date(Date.UTC(year, index, 0)).toISOString().slice(0, 10);
}

function seal(month: string, spend: number, over: Partial<GatewaySeal> = {}): GatewaySeal {
  return {
    month,
    monthStart: `${month}-01`,
    monthEnd: monthEnd(month),
    days: Number(monthEnd(month).slice(8)),
    sealedAt: `${monthEnd(month)}T23:30:00.000Z`,
    sealedBy: 'scheduler',
    revision: 1,
    supersededAt: null,
    total: metrics(spend),
    ...over,
  };
}

/** The route answers newest first; the module must not depend on the order. */
function payload(...seals: GatewaySeal[]): GatewaySeals {
  return { seals: [...seals].sort((a, b) => (a.month < b.month ? 1 : -1)) };
}

console.log('\n== Silence ==');
{
  const pending = deriveLedger(undefined, OPTIONS);
  check(
    !pending.answered && pending.months.length === 0 && !hasLedger(pending),
    'a pending query answers nothing rather than an empty ledger',
  );

  const none = deriveLedger({ seals: [] }, OPTIONS);
  check(
    none.answered && none.sealedCount === 0 && !hasLedger(none),
    'a gateway with no sealed month answers, and the page stands the card down',
  );
  check(
    none.totalSpend === 0 && none.meanMonthlySpend === null && none.trend === null,
    'and it invents no mean and no direction out of nothing',
  );
}

console.log('\n== A run of consecutive months ==');
{
  const ledger = deriveLedger(
    payload(seal('2026-04', 1_000), seal('2026-05', 1_100), seal('2026-06', 1_210)),
    OPTIONS,
  );
  check(ledger.months.length === 3, 'three sealed months, and nothing in flight (July) on the list');
  check(
    ledger.months[0]?.month === '2026-06' && ledger.months[2]?.month === '2026-04',
    'the list is newest-first, the way a ledger is read',
  );
  check(
    Math.abs(ledger.totalSpend - 3_310) < 0.005 && ledger.sealedCount === 3,
    `the total is the sum of the months ($${ledger.totalSpend.toFixed(2)})`,
  );
  check(
    ledger.meanMonthlySpend !== null && Math.abs(ledger.meanMonthlySpend - 3_310 / 3) < 0.005,
    'the mean divides by the sealed months, not by the span',
  );

  const may = ledger.months.find((row) => row.month === '2026-05');
  check(
    may?.comparedWith === '2026-04' && Math.abs((may?.spendDelta ?? 0) - 100) < 0.005,
    'each month is compared against the calendar month before it',
  );
  check(
    may?.spendPercent !== null && Math.abs((may?.spendPercent ?? 0) - 10) < 0.001,
    `and the percentage is off the previous month's own spend (${may?.spendPercent?.toFixed(2)}%)`,
  );
  const april = ledger.months.find((row) => row.month === '2026-04');
  check(
    april?.spendDelta === null && april?.comparedWith === null,
    'the oldest month compares against nothing rather than against zero',
  );

  check(
    ledger.trend !== null &&
      ledger.trend.months === 3 &&
      Math.abs(ledger.trend.percentPerMonth - 10) < 0.001 &&
      ledger.trend.direction === 'rising',
    `the trend compounds rather than averages (${ledger.trend?.percentPerMonth.toFixed(2)}%/mo over ${ledger.trend?.months})`,
  );
  check(
    ledger.unsealedCount === 0 && ledger.revisedCount === 0,
    'nothing is unsealed and nothing has been revised',
  );
  check(
    Math.abs(ledgerPeak(ledger) - 1_210) < 0.005,
    'the strip scales to the tallest month, not to the newest',
  );
}

console.log('\n== A month with no statement ==');
{
  const ledger = deriveLedger(
    payload(seal('2026-03', 1_000), seal('2026-05', 2_000), seal('2026-06', 2_100)),
    OPTIONS,
  );
  const april = ledger.months.find((row) => row.month === '2026-04');
  check(
    ledger.months.length === 4 && april !== undefined && !april.sealed,
    'the missing month is on the list as itself rather than skipped',
  );
  check(
    april?.total === null && april?.spendDelta === null && april?.costPerMillion === null,
    'and carries nulls throughout — a zero bar is how a free month would draw',
  );
  const may = ledger.months.find((row) => row.month === '2026-05');
  check(
    may?.spendDelta === null && may?.comparedWith === null,
    'the month after the hole compares against nothing: a change across a hole is not month-over-month',
  );
  check(
    Math.abs(ledger.totalSpend - 5_100) < 0.005 && ledger.unsealedCount === 1,
    'the total is over the sealed months only, and the hole is counted separately',
  );
  check(
    ledger.trend !== null && ledger.trend.months === 2 && ledger.trend.from === '2026-05',
    'the trend runs back only as far as the hole — a run that jumped it would not be one',
  );

  const single = deriveLedger(payload(seal('2026-04', 1_000), seal('2026-06', 900)), OPTIONS);
  check(
    single.trend === null,
    'and a newest month standing alone has no direction at all, however many months precede the hole',
  );
}

console.log('\n== The spine ends at the last closed month ==');
{
  const ledger = deriveLedger(payload(seal('2026-04', 1_000)), OPTIONS);
  check(
    ledger.months[0]?.month === '2026-06' && !ledger.months[0].sealed,
    'a month that closed and never got sealed is the newest row, not an absent one',
  );
  check(
    ledger.months.every((row) => row.month !== '2026-07'),
    'the month in flight is not on the ledger — it cannot be sealed and is not missing',
  );
  check(ledger.unsealedCount === 2, 'both closed-but-unsealed months are counted');
}

console.log('\n== Superseded statements ==');
{
  const ledger = deriveLedger(
    payload(
      seal('2026-05', 900, { revision: 1, supersededAt: '2026-06-02T10:00:00.000Z' }),
      seal('2026-05', 1_000, { revision: 2 }),
      seal('2026-06', 1_000),
    ),
    OPTIONS,
  );
  check(
    ledger.months.filter((row) => row.month === '2026-05').length === 1,
    'a month with two statements is one row',
  );
  const may = ledger.months.find((row) => row.month === '2026-05');
  check(
    Math.abs((may?.total?.spend ?? 0) - 1_000) < 0.005 && may?.revision === 2,
    'and it is the current statement, not the one it replaced',
  );
  check(ledger.revisedCount === 1, 'the correction is visible without opening the revision chain');

  // Inside the span on purpose: a withdrawn statement must read as a *hole*,
  // which is only visible when the month sits between two months that have one.
  const orphan = deriveLedger(
    payload(
      seal('2026-04', 800),
      seal('2026-05', 900, { supersededAt: '2026-06-02T10:00:00.000Z' }),
      seal('2026-06', 1_000),
    ),
    OPTIONS,
  );
  check(
    orphan.months.find((row) => row.month === '2026-05')?.sealed === false,
    'a month whose only statement is superseded is a hole, not a bill',
  );
  check(
    Math.abs(orphan.totalSpend - 1_800) < 0.005 && orphan.unsealedCount === 1,
    'and the withdrawn dollars are in no total — the ledger is short by exactly that month',
  );
}

console.log('\n== Beyond the proxy’s window ==');
{
  const ledger = deriveLedger(
    payload(seal('2026-02', 800), seal('2026-03', 900), seal('2026-06', 1_000)),
    OPTIONS,
  );
  check(
    ledger.beyondRetentionCount === 2,
    `two sealed months ended before the retention floor (${FLOOR}) and exist nowhere else`,
  );
  const march = ledger.months.find((row) => row.month === '2026-03');
  const june = ledger.months.find((row) => row.month === '2026-06');
  check(
    march?.reproducible === false && june?.reproducible === true,
    'the flag is a property of the month’s last day, not of its age in months',
  );
  const edge = deriveLedger(payload(seal('2026-04', 500)), {
    todayIso: TODAY,
    retentionFloorIso: '2026-04-30',
  });
  check(
    edge.months.find((row) => row.month === '2026-04')?.reproducible === true,
    'a month whose last day is exactly the floor is still reproducible',
  );
}

console.log('\n== Arithmetic that must not be invented ==');
{
  const ledger = deriveLedger(
    payload(
      seal('2026-05', 0, { total: metrics(0, { requests: 0, totalTokens: 0 }) }),
      seal('2026-06', 500),
    ),
    OPTIONS,
  );
  const may = ledger.months.find((row) => row.month === '2026-05');
  check(
    may?.costPerMillion === null && may?.costPerRequest === null,
    'a month that moved no tokens has no unit rate rather than a zero one',
  );
  const june = ledger.months.find((row) => row.month === '2026-06');
  check(
    june?.spendPercent === null && Math.abs((june?.spendDelta ?? 0) - 500) < 0.005,
    'growth out of a $0 month is no number, while the dollar change is still one',
  );
  check(ledger.trend === null, 'and the trend refuses to compound out of zero');

  const priced = deriveLedger(payload(seal('2026-06', 5)), OPTIONS).months[0];
  check(
    priced?.costPerMillion !== null && Math.abs((priced?.costPerMillion ?? 0) - 5) < 0.001,
    'the blended rate is the month’s own spend over its own tokens',
  );

  const falling = deriveLedger(
    payload(seal('2026-05', 1_000), seal('2026-06', 500)),
    OPTIONS,
  );
  check(
    falling.trend?.direction === 'falling' &&
      Math.abs((falling.trend?.percentPerMonth ?? 0) + 50) < 0.001,
    'a halving reads as −50%/mo and as falling',
  );
  const flat = deriveLedger(payload(seal('2026-05', 1_000), seal('2026-06', 1_003)), OPTIONS);
  check(flat.trend?.direction === 'flat', 'and a 0.3% month is flat rather than a direction');
}

console.log('\n== The window, and what it hides ==');
{
  const months = ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
  const ledger = deriveLedger(
    payload(...months.map((month, index) => seal(month, 100 * (index + 1)))),
    { ...OPTIONS, limit: 3 },
  );
  check(
    ledger.months.length === 3 && ledger.months[2]?.month === '2026-04',
    'the list is capped at the most recent months',
  );
  check(
    ledger.truncated === 4,
    `and says how many sealed months it is not drawing (${ledger.truncated})`,
  );
  check(
    Math.abs(ledger.totalSpend - (500 + 600 + 700)) < 0.005,
    'the totals are over the months shown, which is what the footnote claims',
  );
  check(MAX_LEDGER_MONTHS >= 12, `the default window covers at least a year (${MAX_LEDGER_MONTHS})`);
}

console.log('\n== Month arithmetic ==');
{
  check(shiftMonth('2026-01', -1) === '2025-12', 'a month before January is last December');
  check(shiftMonth('2026-12', 1) === '2027-01', 'and a month after December is next January');
  check(shiftMonth('2026-07', 0) === '2026-07', 'a shift of nothing is the same month');
  const leap = deriveLedger(payload(seal('2024-02', 100)), {
    todayIso: '2024-03-02',
    retentionFloorIso: '2023-12-03',
  });
  check(
    leap.months[0]?.days === 29 && leap.months[0]?.month === '2024-02',
    'a leap February seals 29 days',
  );
}

/* ---------------------------------------------------------------------------
 * Postgres — the same derivation over rows a sync would have written.
 * ------------------------------------------------------------------------ */

console.log('\n== Postgres round trip ==');

const { db } = await import('../src/db/client.js');
const { gatewayMonth } = await import('../src/db/schema.js');
const { listGatewaySeals } = await import('../src/services/gateway-seal.js');
const { inArray } = await import('drizzle-orm');

/** Months far enough back that no real seal can collide with them. */
const PLANTED = ['2023-09', '2023-11'];
const plantedSet = new Set(PLANTED);

function row(month: string, spendNano: bigint, revision: number, supersededAt: Date | null) {
  return {
    month,
    revision,
    supersededAt,
    monthStart: `${month}-01`,
    monthEnd: monthEnd(month),
    days: Number(monthEnd(month).slice(8)),
    sealedAt: new Date(`${monthEnd(month)}T23:30:00.000Z`),
    sealedBy: 'scheduler',
    spendNano,
    requests: 1_000,
    successfulRequests: 980,
    failedRequests: 20,
    promptTokens: 800_000,
    completionTokens: 200_000,
    totalTokens: 1_000_000,
    cacheReadTokens: 100_000,
    cacheCreationTokens: 10_000,
  };
}

const before = await listGatewaySeals();
if (before.some((entry) => plantedSet.has(entry.month))) {
  console.error(
    `\nRefusing to plant: ${PLANTED.join(', ')} already carry a seal. This script deletes what it plants, and it must not delete a real statement.\n`,
  );
  process.exit(1);
}

try {
  await db.insert(gatewayMonth).values([
    // A first statement that was later corrected — it must not be read.
    row('2023-09', 1_000_000_000_000n, 1, new Date('2023-10-05T09:00:00.000Z')),
    row('2023-09', 1_250_000_000_000n, 2, null),
    row('2023-11', 2_500_000_000_000n, 1, null),
  ]);

  const seals = await listGatewaySeals();
  // Wide enough to reach the planted months; the default window is checked
  // separately below, because it is what the page actually renders.
  const ledger = deriveLedger({ seals }, { ...OPTIONS, limit: 60 });

  const september = ledger.months.find((entry) => entry.month === '2023-09');
  check(
    september?.sealed === true && Math.abs((september.total?.spend ?? 0) - 1_250) < 0.005,
    `the corrected statement is the one that came back ($${september?.total?.spend.toFixed(2)})`,
  );
  check(
    september?.revision === 2 && ledger.revisedCount >= 1,
    'and it is marked as a revision without the superseded row reaching the module',
  );
  check(
    seals.filter((entry) => entry.month === '2023-09').length === 1,
    'the route itself filters the superseded revision, so the module never sees it',
  );
  check(
    ledger.months.find((entry) => entry.month === '2023-10')?.sealed === false,
    'the month between two seals is a hole, exactly as the constructed case says',
  );
  check(
    ledger.months.find((entry) => entry.month === '2023-11')?.spendDelta === null,
    'and it kills the comparison of the month after it out of Postgres too',
  );
  check(
    ledger.beyondRetentionCount >= 2,
    'both planted months are older than the retention floor — history only this database holds',
  );
  check(
    ledger.months[0]?.month === '2026-06',
    'the spine still ends at the last closed month, however old the oldest seal is',
  );

  const nano = ledger.months
    .filter((entry) => entry.sealed && plantedSet.has(entry.month))
    .reduce((sum, entry) => sum + (entry.total?.spend ?? 0), 0);
  check(
    Math.abs(nano - 3_750) < 0.005,
    `nano-dollars survive the round trip as dollars ($${nano.toFixed(2)})`,
  );

  // What the page renders: the same seals through the default window, where
  // both planted months fall outside it and must be counted rather than lost.
  const capped = deriveLedger({ seals }, OPTIONS);
  check(
    capped.months.length <= MAX_LEDGER_MONTHS &&
      capped.months.every((entry) => !plantedSet.has(entry.month)),
    `the default window holds ${capped.months.length} months and does not reach 2023`,
  );
  check(
    capped.truncated >= PLANTED.length,
    `and reports the ${capped.truncated} sealed months it is not drawing rather than dropping them silently`,
  );
} finally {
  await db.delete(gatewayMonth).where(inArray(gatewayMonth.month, PLANTED));
}

const after = await listGatewaySeals();
check(
  after.length === before.length &&
    after.every((entry, index) => entry.month === before[index]?.month),
  `the planted months were removed and the table is as it was (${after.length} seals)`,
);

console.log(
  failures.length === 0
    ? '\nAll ledger checks passed.\n'
    : `\n${failures.length} FAILED:\n${failures.map((message) => `  - ${message}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
