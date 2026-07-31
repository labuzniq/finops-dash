/**
 * Ad-hoc check of the gateway month seal — the statement held still at month
 * close. Run it by hand (it needs the API's env and a database, like
 * `verify-gateway-range-sync.ts`):
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-seal.ts
 *
 * Two halves, failing in different ways.
 *
 * **`resolveMonthSeal` is pure** and is where the calendar lives: a month may
 * only be sealed once it has ended *and* every one of its days is stored. The
 * second condition is the interesting one — a month with a hole in it sums to
 * less than it cost, and the refusal has to name the missing days rather than
 * count them, because the fix is `POST /api/refresh/gateway?from=&to=` and the
 * caller needs a range to ask for.
 *
 * **The seal itself is not pure** and its whole value is that it can disagree
 * with the daily rows later. That is asserted against Postgres: seal a complete
 * month, check the totals and the per-payer lines reproduce what the chargeback
 * card derives from the same rows, then delete a day and require the seal to
 * *stay put* while the derivation moves — which is exactly the drift the card
 * reports. A seal that quietly re-agreed would have destroyed the only evidence
 * that a bill had been revised.
 *
 * The database section is skipped (loudly) when the gateway has never synced
 * locally, and it restores what it deletes before it finishes.
 */
import { eq, inArray } from 'drizzle-orm';
import { GATEWAY_PAYER_DIMENSIONS, resolveMonthSeal, sealDrift, sumGatewayMetrics } from '@dash/shared';
import { db } from '../src/db/client.js';
import { gatewayBreakdownDaily, gatewayDaily, gatewayMonth, refreshJobs } from '../src/db/schema.js';
import { createGatewayClient } from '../src/gateway/index.js';
import {
  GatewaySealError,
  checkMonthSeal,
  getGatewaySeal,
  listGatewaySeals,
  sealClosedMonths,
  sealGatewayMonth,
} from '../src/services/gateway-seal.js';
import { getGatewayUsage } from '../src/services/gateway.js';
import { startGatewaySync } from '../src/services/gateway-sync.js';
import { deriveChargeback } from '../../web/src/lib/metrics/gatewayChargeback.js';
import type { ChargebackDimension } from '../../web/src/lib/metrics/gatewayChargeback.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

/** Every day of `YYYY-MM`, inclusive. */
function monthDays(month: string): string[] {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const end = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return Array.from({ length: end }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

// ------------------------------------------------ 1. a complete closed month

{
  const days = monthDays('2026-06');
  const seal = resolveMonthSeal('2026-06', days, '2026-07-31');
  check(seal.sealable, `a complete June was refused: ${seal.reason}`);
  check(seal.blocker === null, `a sealable month carries blocker ${seal.blocker}`);
  check(seal.expectedDays === 30, `June is ${seal.expectedDays} days long`);
  check(seal.storedDays === 30, `June stored ${seal.storedDays} days`);
  check(seal.missingDays.length === 0, `a complete month listed ${seal.missingDays.length} missing`);

  // Days either side of the month must not count towards it, in either
  // direction: a stray May row cannot make June complete, and it must not be
  // summed into it either (the seal filters on the same bounds).
  const padded = resolveMonthSeal('2026-06', [...days, '2026-05-31', '2026-07-01'], '2026-07-31');
  check(padded.storedDays === 30, `padding the neighbours made June ${padded.storedDays} days`);
}

// ---------------------------------------------------------- 2. a month in flight

{
  const inFlight = resolveMonthSeal('2026-07', monthDays('2026-07').slice(0, 30), '2026-07-31');
  check(!inFlight.sealable, 'the month in flight was sealable');
  check(inFlight.blocker === 'in_flight', `July on the 31st blocks with ${inFlight.blocker}`);
  check(
    inFlight.reason?.includes('2026-08-01') === true,
    `the refusal does not name the first day it can be sealed: ${inFlight.reason}`,
  );

  // The boundary: the last day of a month is still the month in flight, and the
  // day after it is not. Sealing on the 31st would record a 30-day July.
  const lastDay = resolveMonthSeal('2026-07', monthDays('2026-07'), '2026-07-31');
  check(lastDay.blocker === 'in_flight', 'a month is sealable on its own last day');
  const dayAfter = resolveMonthSeal('2026-07', monthDays('2026-07'), '2026-08-01');
  check(dayAfter.sealable, `July was refused on 1 August: ${dayAfter.reason}`);
}

// ------------------------------------------- 3. the sync's own one-day lag

{
  // The sync ends at yesterday UTC, so on the 1st the month that just closed is
  // one day short. That must read as `incomplete` and not as `in_flight`: the
  // difference is that one is fixed by waiting and the other by a backfill, and
  // only the second names a range.
  const shortByOne = resolveMonthSeal('2026-06', monthDays('2026-06').slice(0, 29), '2026-07-01');
  check(shortByOne.blocker === 'incomplete', `a month short by its last day blocks with ${shortByOne.blocker}`);
  check(
    shortByOne.missingDays.join() === '2026-06-30',
    `the missing day is reported as ${shortByOne.missingDays.join()}`,
  );
  check(
    shortByOne.reason?.includes('2026-06-30') === true,
    `the refusal does not name the day: ${shortByOne.reason}`,
  );
}

// ------------------------------------------------- 4. holes, emptiness, February

{
  const days = monthDays('2026-06');
  const holed = resolveMonthSeal(
    '2026-06',
    days.filter((day) => day !== '2026-06-11' && day !== '2026-06-12'),
    '2026-07-31',
  );
  check(!holed.sealable, 'a month with a two-day hole was sealable');
  check(holed.blocker === 'incomplete', `a holed month blocks with ${holed.blocker}`);
  check(
    holed.missingDays.join() === '2026-06-11,2026-06-12',
    `the hole is reported as ${holed.missingDays.join()}`,
  );
  check(
    holed.expectedDays - holed.storedDays === 2,
    'the missing-day count is not derivable from expected − stored',
  );

  const empty = resolveMonthSeal('2026-01', [], '2026-07-31');
  check(empty.blocker === 'empty', `a month with no rows blocks with ${empty.blocker}`);
  check(empty.storedDays === 0, `an unstored month reports ${empty.storedDays} stored days`);

  // The list is a sample; the count never is. A month nobody synced must not
  // enumerate all 31 days into a UI string.
  const nothingStored = resolveMonthSeal('2026-03', ['2026-03-01'], '2026-07-31');
  check(nothingStored.missingDays.length === 12, `the sample is ${nothingStored.missingDays.length} days`);
  check(
    nothingStored.expectedDays - nothingStored.storedDays === 30,
    'the full missing count was lost to the sample',
  );

  check(resolveMonthSeal('2024-02', [], '2026-07-31').expectedDays === 29, 'leap February is not 29 days');
  check(resolveMonthSeal('2026-02', [], '2026-07-31').expectedDays === 28, 'common February is not 28 days');
  check(
    resolveMonthSeal('2026-12', monthDays('2026-12'), '2027-01-05').sealable,
    'December could not be sealed in January — the year rolled the month over',
  );
}

// ----------------------------------------------- 5. the seal itself, in Postgres

const client = createGatewayClient();
if (client === null) {
  console.warn('\nGATEWAY_SOURCE is off — skipping the database section');
} else {
  const stored = (
    await db.select({ date: gatewayDaily.date }).from(gatewayDaily).orderBy(gatewayDaily.date)
  ).map((row) => row.date);

  const today = new Date().toISOString().slice(0, 10);
  const candidate = [...new Set(stored.map((day) => day.slice(0, 7)))]
    .reverse()
    .find((month) => resolveMonthSeal(month, stored, today).sealable);

  if (candidate === undefined) {
    console.warn(
      `\nno closed month is fully stored (${stored.length} days) — run POST /api/refresh/gateway first; skipping the database section`,
    );
  } else {
    const month = candidate;
    console.log(`sealing ${month} (the newest complete closed month stored)`);

    // 5a. the seal reproduces the daily rows it was taken from
    const first = await sealGatewayMonth(month, { force: true, sealedBy: 'manual' });
    const usage = await getGatewayUsage(`${month}-01`, first.monthEnd);
    const liveTotal = sumGatewayMetrics(usage.daily);

    check(first.days === usage.daily.length, `sealed ${first.days} days, the table holds ${usage.daily.length}`);
    check(
      Math.abs(first.total.spend - liveTotal.spend) < 0.005,
      `sealed $${first.total.spend.toFixed(2)} against a live $${liveTotal.spend.toFixed(2)}`,
    );
    check(
      first.total.totalTokens === liveTotal.totalTokens && first.total.requests === liveTotal.requests,
      'the sealed counters do not match the daily rows',
    );
    check(sealDrift(first, liveTotal).matches, 'a freshly taken seal already reports drift');

    // 5b. only payer dimensions are recorded, and each one reproduces the
    // statement the card derives from the same rows. This is the whole claim:
    // a seal is a statement, not a re-slice — if the two ever disagree the
    // exported bill and the screen would too.
    const sealedDimensions = [...new Set(first.lines.map((line) => line.dimension))].sort();
    check(
      sealedDimensions.join() === [...GATEWAY_PAYER_DIMENSIONS].sort().join(),
      `sealed dimensions are ${sealedDimensions.join()}`,
    );

    for (const dimension of GATEWAY_PAYER_DIMENSIONS) {
      const statement = deriveChargeback(
        usage.daily,
        usage.breakdowns,
        {
          month,
          monthStart: `${month}-01`,
          monthEnd: first.monthEnd,
          priorStart: `${month}-01`,
          priorEnd: `${month}-01`,
          from: `${month}-01`,
          to: first.monthEnd,
          priorComparable: false,
        },
        dimension as ChargebackDimension,
      );
      const sealedLines = first.lines.filter((line) => line.dimension === dimension);
      check(
        sealedLines.length === statement.lines.length,
        `${dimension}: sealed ${sealedLines.length} lines, the statement derives ${statement.lines.length}`,
      );
      for (const line of statement.lines) {
        const sealedLine = sealedLines.find((candidateLine) => candidateLine.key === line.key);
        check(sealedLine !== undefined, `${dimension}: ${line.key} is missing from the seal`);
        check(
          sealedLine === undefined || Math.abs(sealedLine.spend - line.metrics.spend) < 0.005,
          `${dimension}/${line.key}: sealed $${sealedLine?.spend.toFixed(2)} vs derived $${line.metrics.spend.toFixed(2)}`,
        );
      }
      // The overlap rule survives the seal: each payer dimension is a slice of
      // the same month, never a part of a whole to be added to the others.
      const allocated = sealedLines.reduce((sum, line) => sum + line.spend, 0);
      check(
        allocated <= first.total.spend + 0.005,
        `${dimension}: sealed lines allocate $${allocated.toFixed(2)} of a $${first.total.spend.toFixed(2)} month`,
      );
    }

    // 5c. re-sealing is explicit
    let refusal: GatewaySealError | null = null;
    try {
      await sealGatewayMonth(month);
    } catch (error) {
      refusal = error instanceof GatewaySealError ? error : null;
      if (refusal === null) throw error;
    }
    check(refusal !== null, 'a sealed month was re-sealed without force');
    check(refusal?.code === 'sealed', `re-sealing failed with ${refusal?.code}`);

    // 5d. the month in flight is refused through the service, not just the
    // pure resolver — the route's 400 depends on it.
    let inFlight: GatewaySealError | null = null;
    try {
      await sealGatewayMonth(today.slice(0, 7), { force: true });
    } catch (error) {
      inFlight = error instanceof GatewaySealError ? error : null;
      if (inFlight === null) throw error;
    }
    check(inFlight?.code === 'in_flight', `the month in flight refused with ${inFlight?.code}`);

    // 5e. drift: the daily rows move, the seal does not
    const victim = usage.daily[Math.floor(usage.daily.length / 2)]?.date;
    if (victim === undefined) {
      check(false, 'the sealed month reported no days');
    } else {
      await db.delete(gatewayDaily).where(inArray(gatewayDaily.date, [victim]));
      await db.delete(gatewayBreakdownDaily).where(inArray(gatewayBreakdownDaily.date, [victim]));

      const holed = await checkMonthSeal(month);
      check(!holed.sealable, `${month} is still sealable with ${victim} deleted`);
      check(holed.blocker === 'incomplete', `a holed month blocks with ${holed.blocker}`);
      check(holed.missingDays.includes(victim), `${victim} is not named in ${holed.missingDays.join()}`);

      // `force` re-issues a statement; it does not waive the completeness rule,
      // or a re-seal during an outage would quietly book a short month.
      let forced: GatewaySealError | null = null;
      try {
        await sealGatewayMonth(month, { force: true });
      } catch (error) {
        forced = error instanceof GatewaySealError ? error : null;
        if (forced === null) throw error;
      }
      check(forced?.code === 'incomplete', `force re-sealed a holed month (${forced?.code ?? 'no error'})`);

      const afterDelete = await getGatewaySeal(month);
      check(
        afterDelete !== null && Math.abs(afterDelete.total.spend - first.total.spend) < 0.005,
        'the seal moved when the daily rows did',
      );
      const revised = sumGatewayMetrics(
        (await getGatewayUsage(`${month}-01`, first.monthEnd)).daily,
      );
      const drift = sealDrift(first, revised);
      check(!drift.matches, 'a month missing a day reports no drift against its seal');
      check(drift.spendDelta < 0, `losing a day drifted by ${drift.spendDelta.toFixed(2)}`);

      // The scheduler's pass must not quietly repair that: a sealed month is
      // never re-sealed implicitly, which is what keeps the drift visible.
      const sweep = await sealClosedMonths('scheduler');
      check(!sweep.sealed.includes(month), `the scheduler re-sealed ${month} on its own`);

      // Put the day back the way the coverage note's Fill button would.
      const job = await startGatewaySync({ from: victim, to: victim });
      const settled = await waitForJob(job.id);
      check(settled?.status === 'succeeded', `restoring ${victim} ${settled?.status}: ${settled?.error}`);
      const restored = await checkMonthSeal(month);
      check(restored.sealable, `${month} did not become sealable again: ${restored.reason}`);
    }

    // 5f. an explicit re-seal issues the revised statement
    const second = await sealGatewayMonth(month, { force: true, sealedBy: 'manual' });
    check(
      Date.parse(second.sealedAt) >= Date.parse(first.sealedAt),
      'the re-seal carries an older timestamp than the seal it replaced',
    );
    const finalUsage = await getGatewayUsage(`${month}-01`, first.monthEnd);
    check(
      sealDrift(second, sumGatewayMetrics(finalUsage.daily)).matches,
      'the re-seal does not match the rows it was taken from',
    );

    const seals = await listGatewaySeals();
    check(seals.some((seal) => seal.month === month), `${month} is missing from the seal list`);
    check(
      seals.every((seal, index) => index === 0 || (seals[index - 1]?.month ?? '') >= seal.month),
      'the seal list is not newest-first',
    );
    // One *current* row per month, whatever happened above. The superseded
    // revisions stay — that is what verify-gateway-seal-history.ts is about —
    // but exactly one of them may claim to be the bill.
    const rows = await db
      .select({ month: gatewayMonth.month, supersededAt: gatewayMonth.supersededAt })
      .from(gatewayMonth);
    const current = rows.filter((row) => row.month === month && row.supersededAt === null);
    check(current.length === 1, `${month} carries ${current.length} current seal rows`);
    check(
      seals.filter((entry) => entry.month === month).length === 1,
      `${month} appears more than once in the seal list`,
    );
  }
}

/** Poll a job row until it settles — `startJob` runs the work in the background. */
async function waitForJob(id: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const [row] = await db.select().from(refreshJobs).where(eq(refreshJobs.id, id));
    if (row && (row.status === 'succeeded' || row.status === 'failed')) return row;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nall gateway seal checks passed');
process.exit(0);
