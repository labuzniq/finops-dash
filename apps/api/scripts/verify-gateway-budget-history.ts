/**
 * Ad-hoc check of the gateway budget *history* — what the governance snapshot
 * read on previous days, which is the one governance fact the proxy does not
 * serve and the dashboard has to keep for itself.
 *
 * Run it by hand (it needs the API's env and a database, like
 * `verify-gateway-seal.ts`):
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-budget-history.ts
 *
 * Two halves, and they fail in different ways.
 *
 * **`deriveBudgetHistory` is pure** and is where every claim about change gets
 * made: a counter that fell rolled its period, a cap that moved was moved by
 * somebody, a utilisation that crossed 100 crossed it on the day we *saw* it.
 * The interesting assertions are the negative ones — a fall smaller than half a
 * cent is float noise and not a period boundary, a day nobody observed is not a
 * flat continuation, and a window reaching before recording started is shorter
 * rather than emptier.
 *
 * **The recording itself is not pure**, and its two rules are asserted against
 * Postgres: a full sync appends exactly one observation per governed object per
 * day (a second sync the same day updates that row instead of adding one), and
 * a ranged backfill appends nothing at all — it does not fetch budgets, so it
 * has no governance state to record and must not invent one.
 *
 * The database half is skipped (loudly) when the gateway has never synced
 * locally, and it removes every row it plants.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { GatewayBudgetObservation, GatewayBudgetScope } from '@dash/shared';
import { db } from '../src/db/client.js';
import { gatewayBudget, gatewayBudgetHistory, refreshJobs } from '../src/db/schema.js';
import { createGatewayClient } from '../src/gateway/index.js';
import { getGatewayBudgetHistory, getGatewayBudgets } from '../src/services/gateway.js';
import { startGatewaySync } from '../src/services/gateway-sync.js';
import {
  deriveBudgetHistory,
  findBudgetHistoryRow,
} from '../../web/src/lib/metrics/gatewayBudgetHistory.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

const near = (a: number, b: number, epsilon = 1e-6) => Math.abs(a - b) < epsilon;

function shiftIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A constructed reading. Everything not named is the boring default. */
function observation(
  date: string,
  spend: number,
  overrides: Partial<GatewayBudgetObservation> = {},
): GatewayBudgetObservation {
  return {
    scope: 'api_key',
    key: 'k-1',
    label: 'coding-assistant',
    date,
    observedAt: `${date}T07:00:00.000Z`,
    spend,
    maxBudget: 1_000,
    softBudget: null,
    budgetDuration: '1mo',
    resetAt: null,
    tpmLimit: null,
    rpmLimit: null,
    blocked: false,
    ...overrides,
  };
}

const BASE = '2026-06-01';
const day = (offset: number) => shiftIso(BASE, offset);

function history(observations: GatewayBudgetObservation[], recordingSince = BASE) {
  return deriveBudgetHistory({
    from: BASE,
    to: day(29),
    recordingSince,
    observations,
  });
}

// -------------------------------------------------- 1. a period that rolled
{
  const observations = [
    observation(day(0), 100),
    observation(day(1), 240),
    observation(day(2), 900),
    // The counter fell: the proxy rolled the budget period overnight.
    observation(day(3), 60),
    observation(day(4), 210),
  ];
  const summary = history(observations);
  const row = findBudgetHistoryRow(summary, 'api_key', 'k-1');

  check(row !== null, 'the constructed key produced no history row');
  check(row?.resets === 1, `expected one reset, got ${row?.resets}`);
  check(row?.periods.length === 1, `expected one closed period, got ${row?.periods.length}`);

  const period = row?.periods[0];
  check(period?.from === day(0) && period?.to === day(2), 'the closed period has the wrong bounds');
  check(
    period !== undefined && near(period.observedTotal, 900),
    'a closed period must carry the last counter seen before the roll, not the first of the next',
  );
  check(period?.contiguous === true, 'consecutive readings across a roll must be contiguous');
  check(period?.over === false, '$900 of a $1,000 cap is not over');

  // The reset is a break in the series, not a fall in spend — the strip has to
  // be able to draw it as one.
  const resetPoint = row?.points.find((point) => point.date === day(3));
  check(resetPoint?.reset === true, 'the day the counter rolled is not marked as a reset');
  check(
    row?.points.filter((point) => point.reset).length === 1,
    'exactly one point should be marked as a reset',
  );
  check(
    row?.events.filter((event) => event.kind === 'reset').length === 1,
    'exactly one reset event should be emitted',
  );
  check(row?.everOver === false, 'nothing here ever went over its cap');
  check(row?.peakUtilization !== null && near(row.peakUtilization, 90), 'peak utilisation is wrong');
}

// ------------------------------------- 2. a fall smaller than half a cent
{
  // Nano→dollars is a float division, so a counter that did not move can come
  // back a hair lower. Reading that as a period boundary would invent a
  // one-day period every time it happened.
  const summary = history([
    observation(day(0), 500),
    observation(day(1), 499.998),
    observation(day(2), 501),
  ]);
  const row = findBudgetHistoryRow(summary, 'api_key', 'k-1');
  check(row?.resets === 0, 'a sub-cent fall must not be read as a period reset');
  check(row?.periods.length === 0, 'a sub-cent fall must not close a period');
}

// ---------------------------------------------- 3. a cap moved by a person
{
  const summary = history([
    observation(day(0), 900),
    // Lowered under the standing spend: nothing was spent and the key is now
    // over. Both events belong on the day, and the cap event is the explanation.
    observation(day(1), 900, { maxBudget: 800 }),
    observation(day(2), 905, { maxBudget: 800 }),
    // Raised back over it — the ordinary answer to an overrun.
    observation(day(3), 910, { maxBudget: 2_000 }),
  ]);
  const row = findBudgetHistoryRow(summary, 'api_key', 'k-1');

  check(row?.capChanges === 2, `expected two cap changes, got ${row?.capChanges}`);
  const over = row?.events.filter((event) => event.kind === 'over') ?? [];
  check(over.length === 1, `a crossing should be reported once, got ${over.length}`);
  check(over[0]?.date === day(1), 'the crossing must be dated to the day it was seen');
  check(
    over[0] !== undefined && over[0].from !== null && over[0].from < 100,
    'the crossing must carry the utilisation it came from',
  );
  check(row?.everOver === true, 'a key that was over on a recorded day must say so');

  const lowered = row?.events.find((event) => event.kind === 'cap' && event.date === day(1));
  check(
    lowered?.from === 1_000 && lowered?.to === 800,
    'the cap event must carry both the old and the new cap',
  );
}

// ------------------------------------------------- 4. days nobody observed
{
  const summary = history([
    observation(day(0), 100),
    observation(day(1), 300),
    // Three days unobserved, and the counter rolled somewhere inside them.
    observation(day(5), 40),
    observation(day(6), 90),
  ]);
  const row = findBudgetHistoryRow(summary, 'api_key', 'k-1');

  const gap = row?.events.find((event) => event.kind === 'gap');
  check(gap?.date === day(5), 'the gap must be reported on the reading that ends it');
  check(gap?.to === 3, `the gap should count three unobserved days, got ${gap?.to}`);
  check(row?.daysMissing === 3, `expected three missing days, got ${row?.daysMissing}`);
  check(row?.daysObserved === 4, `expected four observed days, got ${row?.daysObserved}`);

  for (const date of [day(2), day(3), day(4)]) {
    const point = row?.points.find((candidate) => candidate.date === date);
    check(point?.observed === false, `${date} was not observed and must not be filled in`);
    check(
      point?.spend === null && point.utilization === null,
      `${date} must carry no numbers at all`,
    );
  }

  const period = row?.periods[0];
  check(
    period?.contiguous === false,
    'a roll seen across a sampling gap must not claim to be contiguous — a whole period may have closed unseen',
  );
}

// --------------------------------------------- 5. soft budgets and blocking
{
  const soft = (spend: number, date: string, extra: Partial<GatewayBudgetObservation> = {}) =>
    observation(date, spend, { softBudget: 700, ...extra });

  const summary = history([
    soft(600, day(0)),
    soft(720, day(1)),
    // Still past the soft budget: a state, not a new crossing.
    soft(760, day(2)),
    // Past the hard cap — reported as `over`, and not also as a soft breach.
    soft(1_050, day(3)),
    soft(1_060, day(4), { blocked: true }),
    soft(1_060, day(5), { blocked: true, label: 'coding-assistant-v2' }),
    soft(1_060, day(6), { blocked: false, label: 'coding-assistant-v2', rpmLimit: 120 }),
  ]);
  const row = findBudgetHistoryRow(summary, 'api_key', 'k-1');
  const kinds = (kind: string) => (row?.events ?? []).filter((event) => event.kind === kind);

  check(kinds('soft-breach').length === 1, 'a soft breach must be reported once, not every day');
  check(kinds('soft-breach')[0]?.date === day(1), 'the soft breach is on the wrong day');
  check(kinds('over').length === 1, 'the hard crossing must be reported once');
  check(
    kinds('over')[0]?.date === day(3) &&
      !kinds('soft-breach').some((event) => event.date === day(3)),
    'a day that goes over the hard cap must not also be filed as a soft breach',
  );
  check(kinds('blocked').length === 1 && kinds('unblocked').length === 1, 'block flips missed');
  check(
    kinds('blocked')[0]?.adverse === true && kinds('unblocked')[0]?.adverse === false,
    'being blocked is adverse; being unblocked is not',
  );
  check(kinds('renamed').length === 1, 'a rename is itself a recorded change');
  check(kinds('limits').length === 1, 'a rate-limit change is a recorded change');
  check(row?.everBlocked === true, 'a key blocked on a recorded day must say so');
  check(
    row?.label === 'coding-assistant-v2',
    'the row is labelled with the most recent alias, so history reads under the current name',
  );
}

// -------------------------------------- 6. the spine, and what has no spine
{
  // Recording started three days into the window: the record is shorter, not
  // emptier. There is no backfill for this table and never will be.
  const late = deriveBudgetHistory({
    from: BASE,
    to: day(9),
    recordingSince: day(7),
    observations: [observation(day(7), 10), observation(day(8), 20), observation(day(9), 30)],
  });
  check(late.spineFrom === day(7), 'the spine must start at the first ever observation');
  check(late.dates.length === 3, `expected a three-day spine, got ${late.dates.length}`);
  check(late.dates[0] === day(7) && late.dates[2] === day(9), 'the spine has the wrong bounds');
  check(late.tooShort === false, 'three recorded days is enough to observe change');

  const empty = deriveBudgetHistory(undefined);
  check(empty.isEmpty && empty.tooShort, 'an absent payload is empty and too short');
  check(empty.dates.length === 0 && empty.rows.length === 0, 'an absent payload draws nothing');

  const nothingRecorded = deriveBudgetHistory({
    from: BASE,
    to: day(9),
    recordingSince: null,
    observations: [],
  });
  check(nothingRecorded.isEmpty, 'no observations means no rows');
  check(nothingRecorded.daysRecorded === 0, 'no observations means no recorded days');

  const single = deriveBudgetHistory({
    from: BASE,
    to: day(9),
    recordingSince: BASE,
    observations: [observation(BASE, 42)],
  });
  const singleRow = findBudgetHistoryRow(single, 'api_key', 'k-1');
  check(singleRow?.thin === true, 'one reading is thin — nothing about change can be said');
  check(
    singleRow?.events.length === 0 && singleRow.periods.length === 0,
    'one reading can produce no events and no periods',
  );
  check(single.tooShort === true, 'one recorded day anywhere means the record is too short');
}

// ------------------------------- 7. uncapped rows, and the worst-first order
{
  const summary = deriveBudgetHistory({
    from: BASE,
    to: day(3),
    recordingSince: BASE,
    observations: [
      // Uncapped: no utilisation to speak of, and never "over".
      observation(day(0), 4_000, { key: 'k-free', label: 'copilot-agents', maxBudget: null }),
      observation(day(1), 5_000, { key: 'k-free', label: 'copilot-agents', maxBudget: null }),
      observation(day(0), 300, { key: 'k-ok', label: 'support' }),
      observation(day(1), 420, { key: 'k-ok', label: 'support' }),
      observation(day(0), 900, { key: 'k-over', label: 'etl' }),
      observation(day(1), 1_100, { key: 'k-over', label: 'etl' }),
    ],
  });

  const free = findBudgetHistoryRow(summary, 'api_key', 'k-free');
  check(free?.peakUtilization === null, 'an uncapped row has no utilisation peak');
  check(free?.everOver === false, 'an uncapped row can never be over a cap it does not have');
  check(free !== null && near(free.peakSpend, 5_000), 'an uncapped row still has a spend peak');
  check(
    free?.points.every((point) => point.utilization === null),
    'an uncapped row must draw no utilisation at all',
  );

  check(summary.rows[0]?.key === 'k-over', 'the row that went over its cap must rank first');
  check(summary.everOver === 1, 'exactly one object went over');
  check(summary.capChanges === 0, 'no caps moved here');
}

console.log(`pure derivation: ${failures.length === 0 ? 'ok' : `${failures.length} failure(s)`}`);

// ============================================================== Postgres half

const client = createGatewayClient();
const [anyBudget] = await db.select().from(gatewayBudget).limit(1);

if (client === null) {
  console.log('\nGATEWAY_SOURCE is off — skipping the database half.');
} else if (anyBudget === undefined) {
  console.log('\nNo budgets stored — run a gateway sync first; skipping the database half.');
} else {
  const today = new Date().toISOString().slice(0, 10);

  // ---------------------------------------- 8. a full sync records one day
  {
    const job = await startGatewaySync();
    const settled = await waitForJob(job.id);
    check(settled?.status === 'succeeded', `the gateway sync did not succeed: ${settled?.status}`);

    const snapshot = await getGatewayBudgets();
    const todayRows = await db
      .select()
      .from(gatewayBudgetHistory)
      .where(eq(gatewayBudgetHistory.date, today));

    check(
      todayRows.length === snapshot.budgets.length,
      `today's record holds ${todayRows.length} rows against ${snapshot.budgets.length} governed objects`,
    );

    // The record and the snapshot came out of the same fetch, so they must
    // agree to the nano — including the nulls, which are the whole reason this
    // table has no defaults.
    const recorded = new Map(todayRows.map((row) => [`${row.scope}:${row.key}`, row]));
    for (const budget of snapshot.budgets) {
      const row = recorded.get(`${budget.scope}:${budget.key}`);
      if (row === undefined) {
        check(false, `${budget.key} is in the snapshot but not in today's record`);
        continue;
      }
      check(
        near(Number(row.spendNano) / 1e9, budget.spend, 1e-6),
        `${budget.key}: recorded spend disagrees with the snapshot`,
      );
      check(
        (row.maxBudgetNano === null) === (budget.maxBudget === null),
        `${budget.key}: an uncapped budget must stay null in the record, never become 0`,
      );
      check(row.blocked === budget.blocked, `${budget.key}: recorded block flag disagrees`);
    }

    // A second sync the same day updates that day's row rather than adding one:
    // the table grows with the calendar, not with the scheduler.
    const before = todayRows.length;
    const second = await startGatewaySync();
    await waitForJob(second.id);
    const after = await db
      .select()
      .from(gatewayBudgetHistory)
      .where(eq(gatewayBudgetHistory.date, today));
    check(
      after.length === before,
      `a second sync the same day added rows (${before} → ${after.length}) — the day key is not doing its job`,
    );
  }

  // ------------------------- 9. a ranged backfill records no governance at all
  {
    const before = await db.select().from(gatewayBudgetHistory);
    const from = shiftIso(today, -4);
    const to = shiftIso(today, -3);
    const job = await startGatewaySync({ from, to });
    const settled = await waitForJob(job.id);
    check(settled?.status === 'succeeded', `the backfill did not succeed: ${settled?.status}`);
    const after = await db.select().from(gatewayBudgetHistory);
    check(
      after.length === before.length,
      `a ranged backfill appended ${after.length - before.length} governance observations — it does not fetch budgets and must record none`,
    );
  }

  // -------------------- 10. the read route, and the derivation over real rows
  {
    const capped = await db.select().from(gatewayBudget);
    const target = capped.find((row) => row.maxBudgetNano !== null && row.maxBudgetNano > 0n);
    if (target === undefined) {
      console.log('No capped budget stored — skipping the planted-history section.');
    } else {
      const cap = Number(target.maxBudgetNano) / 1e9;
      // Six days of readings that a sync run on those days would have written:
      // a climb into an overrun, a roll, and one day nobody looked.
      const planted: { date: string; spend: number }[] = [
        { date: shiftIso(today, -7), spend: cap * 0.2 },
        { date: shiftIso(today, -6), spend: cap * 0.5 },
        { date: shiftIso(today, -5), spend: cap * 0.95 },
        // -4 deliberately absent: the scheduler did not run.
        { date: shiftIso(today, -3), spend: cap * 1.08 },
        { date: shiftIso(today, -2), spend: cap * 0.04 },
        { date: shiftIso(today, -1), spend: cap * 0.3 },
      ];

      await db.insert(gatewayBudgetHistory).values(
        planted.map((entry) => ({
          scope: target.scope,
          key: target.key,
          date: entry.date,
          label: target.label,
          spendNano: BigInt(Math.round(entry.spend * 1e9)),
          maxBudgetNano: target.maxBudgetNano,
          softBudgetNano: target.softBudgetNano,
          budgetDuration: target.budgetDuration,
          resetAt: target.resetAt,
          tpmLimit: target.tpmLimit,
          rpmLimit: target.rpmLimit,
          blocked: target.blocked,
          observedAt: new Date(`${entry.date}T07:00:00.000Z`),
        })),
      );

      try {
        const payload = await getGatewayBudgetHistory(60);
        check(
          payload.recordingSince === planted[0]?.date,
          `recordingSince should be the earliest stored day (${planted[0]?.date}), got ${payload.recordingSince}`,
        );
        check(payload.to === today, 'the window must end today');

        const summary = deriveBudgetHistory(payload);
        const scope = target.scope as GatewayBudgetScope;
        const row = findBudgetHistoryRow(summary, scope, target.key);

        check(row !== null, 'the planted object produced no history row through Postgres');
        check(
          row?.daysObserved === planted.length + 1,
          `expected ${planted.length + 1} readings (six planted plus today), got ${row?.daysObserved}`,
        );
        check(row?.daysMissing === 1, `expected the one unobserved day, got ${row?.daysMissing}`);
        check(row?.everOver === true, 'the planted overrun was not detected through Postgres');
        check(row?.resets === 1, `expected one reset through Postgres, got ${row?.resets}`);
        check(
          row?.periods[0]?.contiguous === true,
          'the planted roll is across consecutive days and must read as contiguous',
        );
        check(
          row?.periods[0] !== undefined && near(row.periods[0].observedTotal, cap * 1.08, 0.01),
          'the closed period must carry the last counter seen before the roll',
        );
        const gap = row?.events.find((event) => event.kind === 'gap');
        check(gap?.to === 1, 'the one skipped day must be reported as a gap of one');

        // Money survived Postgres exactly, which is the whole point of storing
        // it as bigint nano rather than as a float.
        const observed = payload.observations.find(
          (entry) => entry.key === target.key && entry.date === planted[2]?.date,
        );
        check(
          observed !== undefined && near(observed.spend, cap * 0.95, 1e-6),
          'a planted counter did not survive the nano round trip',
        );
      } finally {
        await db.delete(gatewayBudgetHistory).where(
          and(
            eq(gatewayBudgetHistory.scope, target.scope),
            eq(gatewayBudgetHistory.key, target.key),
            inArray(
              gatewayBudgetHistory.date,
              planted.map((entry) => entry.date),
            ),
          ),
        );
      }

      const leftovers = await db
        .select()
        .from(gatewayBudgetHistory)
        .where(
          and(
            eq(gatewayBudgetHistory.key, target.key),
            inArray(
              gatewayBudgetHistory.date,
              planted.map((entry) => entry.date),
            ),
          ),
        );
      check(leftovers.length === 0, 'the planted rows were not cleaned up');
    }
  }
}

/** Poll a job row until it settles — `startJob` runs the work in the background. */
async function waitForJob(id: string) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
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
console.log('\nall gateway budget history checks passed');
process.exit(0);
