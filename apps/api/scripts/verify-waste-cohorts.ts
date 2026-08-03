/**
 * Ad-hoc check of the wasted-spend cohort split. Not a test suite (the repo has
 * none) — run it by hand:
 *
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-waste-cohorts.ts
 *
 * It sits outside apps/api's tsconfig `include` on purpose: it imports the web
 * app's metrics modules, which do not belong in the API's build.
 *
 * The split's whole job is to say which of three conversations a wasted seat
 * is, so what it has to prove is that it never says one it cannot support:
 *
 * - the cohorts **reconcile** — seats sum to `wastedSpend().seats` and dollars
 *   to `wastedSpend().wasted`, over the same rows, so the card cannot disagree
 *   with itself;
 * - the boundary is the one `isIdle` uses, tested on both sides of it and on it;
 * - the anchor is the range start, not today: the same rows in the same range
 *   produce the same cohorts whenever the page is opened;
 * - a chip narrows the roster to exactly the people it counted, and the roster's
 *   dollars are that cohort's dollars;
 * - grouping by cohort reproduces the same buckets as the chips;
 * - "never" is never asserted — the label names the floor instead;
 * - the two guards stay apart: an unmeasurable range (no credits at all) still
 *   refuses, and a range with no history before it withholds only the split;
 * - the CSV is flat and complete, carrying the cohort and the date on every row
 *   whichever way the screen is grouped.
 */

import { IDLE_THRESHOLD_DAYS } from '@dash/shared';
import type { CreditHistory } from '@dash/shared';
import { buildRosterCsv } from '../../web/src/lib/exportCsv.js';
import { wastedSpend } from '../../web/src/lib/metrics/spend.js';
import type { SpendUserRow } from '../../web/src/lib/metrics/spend.js';
import { wastedRoster } from '../../web/src/lib/metrics/wastedRoster.js';
import { cohortOf, wasteCohortSummary } from '../../web/src/lib/metrics/wasteCohort.js';
import type { WasteCohort } from '../../web/src/lib/metrics/wasteCohort.js';

const MS_PER_DAY = 86_400_000;

function iso(from: string, offsetDays: number): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) + offsetDays * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

const RANGE_START = '2026-07-06';
const FLOOR = '2026-04-01';

/** One spend row. `credits` is the only thing that decides waste; the rest is identity. */
function row(
  login: string,
  licence: number,
  credits: number,
  department: string | null,
  b1: string | null,
): SpendUserRow {
  return {
    login,
    displayName: `${login} name`,
    mapped: b1 !== null,
    department,
    b1Manager: b1,
    b2Manager: b1 === null ? null : 'b2-root',
    credits,
    gross: licence + credits,
    discount: 0,
    net: licence + credits,
    licence,
  };
}

// Four wasted seats, one per cohort plus a second `never`, and two seats that
// are not wasted at all: one that spent credits in range, one with no licence.
const ROWS: SpendUserRow[] = [
  row('never-a', 19, 0, 'Platform', 'ana'),
  row('never-b', 19, 0, 'Payments', 'bo'),
  // Exactly on the boundary — dormant, the same way `isIdle` reads 30 days.
  row('dormant-edge', 39, 0, 'Platform', 'ana'),
  row('dormant-old', 19, 0, null, null),
  // One day inside the threshold — lapsed.
  row('lapsed', 19, 0, 'Payments', 'bo'),
  row('spender', 19, 12.5, 'Platform', 'ana'),
  row('no-licence', 0, 0, 'Platform', 'ana'),
];

const HISTORY: CreditHistory = {
  floor: FLOOR,
  lastCreditBefore: {
    'dormant-edge': iso(RANGE_START, -IDLE_THRESHOLD_DAYS),
    'dormant-old': iso(RANGE_START, -200),
    lapsed: iso(RANGE_START, -(IDLE_THRESHOLD_DAYS - 1)),
    // Not wasted, so it must never reach a cohort at all.
    spender: iso(RANGE_START, -3),
  },
};

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

const cohortRow = (cohort: WasteCohort) => {
  const found = summary.rows.find((candidate) => candidate.cohort === cohort);
  if (found === undefined) throw new Error(`no ${cohort} row`);
  return found;
};

const summary = wasteCohortSummary(ROWS, HISTORY, RANGE_START);
const waste = wastedSpend(ROWS);

// ------------------------------------------------------ 1. the reconciliation

{
  const seats = summary.rows.reduce((sum, candidate) => sum + candidate.seats, 0);
  const amount = summary.rows.reduce((sum, candidate) => sum + candidate.amount, 0);

  check(waste.seats === 5, `wastedSpend counted ${waste.seats} seats, expected 5`);
  check(seats === waste.seats, `cohort seats ${seats} !== card seats ${waste.seats}`);
  check(amount === waste.wasted, `cohort dollars ${amount} !== card dollars ${waste.wasted}`);
  check(
    summary.rows.reduce((sum, candidate) => sum + candidate.share, 0) === 1,
    'cohort shares do not sum to 1',
  );
  check(summary.rows.length === 3, `${summary.rows.length} cohorts, expected 3`);
}

// -------------------------------------------------------------- 2. the cuts

{
  check(cohortRow('never').seats === 2, `${cohortRow('never').seats} never seats, expected 2`);
  check(cohortRow('dormant').seats === 2, `${cohortRow('dormant').seats} dormant, expected 2`);
  check(cohortRow('lapsed').seats === 1, `${cohortRow('lapsed').seats} lapsed, expected 1`);
  check(cohortRow('never').amount === 38, `never dollars ${cohortRow('never').amount}, expected 38`);
  check(
    cohortRow('dormant').amount === 58,
    `dormant dollars ${cohortRow('dormant').amount}, expected 58`,
  );

  // The boundary is `>=`, exactly as `isIdle` reads it — one day either side.
  check(
    cohortOf(iso(RANGE_START, -IDLE_THRESHOLD_DAYS), RANGE_START) === 'dormant',
    'a gap of exactly the idle threshold is not dormant',
  );
  check(
    cohortOf(iso(RANGE_START, -(IDLE_THRESHOLD_DAYS - 1)), RANGE_START) === 'lapsed',
    'a gap one day inside the threshold is not lapsed',
  );
  check(cohortOf(undefined, RANGE_START) === 'never', 'no credit day is not never');
}

// ------------------------------------------------- 3. the anchor is the range

{
  // The same rows read against a later range start must age: the anchor is the
  // window, so re-opening it months later cannot re-cohort anybody, while
  // *moving* the window must.
  const later = wasteCohortSummary(ROWS, HISTORY, iso(RANGE_START, 60));
  check(
    later.rows.find((candidate) => candidate.cohort === 'lapsed')?.seats === 0,
    'a window 60 days later still reports a lapsed seat',
  );
  const again = wasteCohortSummary(ROWS, HISTORY, RANGE_START);
  check(
    JSON.stringify(again.rows) === JSON.stringify(summary.rows),
    'the same rows and range produced two different splits',
  );
}

// ------------------------------------------------------- 4. the roster agrees

{
  const all = wastedRoster(ROWS, 'b1Manager', HISTORY, RANGE_START);
  check(all.people === waste.seats, `roster names ${all.people}, card counts ${waste.seats}`);
  check(all.amount === waste.wasted, `roster totals ${all.amount}, card totals ${waste.wasted}`);

  for (const cohort of ['never', 'dormant', 'lapsed'] as const) {
    const filtered = wastedRoster(ROWS, 'b1Manager', HISTORY, RANGE_START, cohort);
    check(
      filtered.people === cohortRow(cohort).seats,
      `${cohort} chip counts ${cohortRow(cohort).seats} but selects ${filtered.people}`,
    );
    check(
      filtered.amount === cohortRow(cohort).amount,
      `${cohort} chip totals ${cohortRow(cohort).amount} but selects ${filtered.amount}`,
    );
    check(
      filtered.groups.every((group) =>
        group.people.every((person) => person.cohort === cohort),
      ),
      `the ${cohort} roster contains somebody from another cohort`,
    );
  }

  // Grouping by cohort must reproduce the chips, buckets and dollars alike.
  const grouped = wastedRoster(ROWS, 'cohort', HISTORY, RANGE_START);
  check(grouped.groups.length === 3, `${grouped.groups.length} cohort groups, expected 3`);
  for (const group of grouped.groups) {
    const cohort = group.key as WasteCohort;
    check(
      group.people.length === cohortRow(cohort).seats && group.amount === cohortRow(cohort).amount,
      `the ${cohort} group disagrees with the ${cohort} cohort row`,
    );
  }
  check(
    grouped.groups.every((group) => group.key !== null),
    'grouping by cohort produced an unassigned bucket',
  );
  // The dormant group is the dearest, so it ranks first — money before headcount.
  check(grouped.groups[0]?.key === 'dormant', `cohort groups lead with ${grouped.groups[0]?.key}`);

  // A person with no manager still groups, and the unassigned bucket still
  // ranks last however dear it is.
  const byB1 = wastedRoster(ROWS, 'b1Manager', HISTORY, RANGE_START);
  check(byB1.groups[byB1.groups.length - 1]?.key === null, 'the unassigned bucket did not rank last');
}

// -------------------------------------------------------- 5. never is a floor

{
  const roster = wastedRoster(ROWS, 'cohort', HISTORY, RANGE_START, 'never');
  const person = roster.groups[0]?.people[0];
  check(person !== undefined, 'the never roster named nobody');
  check(
    person?.note === `None since ${'Apr 1'}`,
    `never reads "${person?.note ?? ''}" rather than naming the floor`,
  );
  check(
    summary.rows.every((candidate) => !candidate.label.toLowerCase().startsWith('never')),
    'a cohort label asserts "never"',
  );
  check(cohortRow('never').label.includes('Apr 1'), 'the never label does not name the floor');

  // With nothing imported at all there is no floor to name and none is invented.
  const noFloor = wasteCohortSummary(ROWS, { floor: null, lastCreditBefore: {} }, RANGE_START);
  check(noFloor.priorHistory === false, 'an empty history claims prior history');
  check(
    noFloor.rows.find((candidate) => candidate.cohort === 'never')?.label === 'No credits recorded',
    'an empty history invents a floor',
  );
}

// ------------------------------------------------------------- 6. the guards

{
  // No credits anywhere in the range: the roster refuses, exactly as before.
  const noCredits = ROWS.map((candidate) => ({ ...candidate, credits: 0 }));
  const refused = wastedRoster(noCredits, 'b1Manager', HISTORY, RANGE_START);
  check(!refused.measurable, 'a range with no credits produced a measurable roster');
  check(refused.people === 0, 'a range with no credits named people');

  // History that begins inside the range: the split is withheld, but the
  // roster itself is untouched — the two guards are different questions.
  const insideFloor: CreditHistory = { ...HISTORY, floor: RANGE_START };
  const withheld = wasteCohortSummary(ROWS, insideFloor, RANGE_START);
  check(!withheld.priorHistory, 'a floor on the range start still claims prior history');
  const stillNamed = wastedRoster(ROWS, 'b1Manager', insideFloor, RANGE_START);
  check(
    stillNamed.measurable && stillNamed.people === waste.seats,
    'withholding the split also withheld the roster',
  );
}

// ---------------------------------------------------------------- 7. the CSV

{
  const roster = wastedRoster(ROWS, 'cohort', HISTORY, RANGE_START);
  const csv = buildRosterCsv(roster, 'licence_usd', 'last_credit');
  const lines = csv.split('\n');

  check(
    lines[0] === 'user_login,name,department,b1_manager,b2_manager,cohort,last_credit,licence_usd',
    `unexpected header: ${lines[0] ?? ''}`,
  );
  check(lines.length === waste.seats + 1, `${lines.length - 1} rows, expected ${waste.seats}`);
  // No cell here contains a comma, so a plain split counts the columns — the
  // point is that an unmapped person still fills every one of them rather than
  // ending the row early.
  check(
    lines.slice(1).every((line) => line.split(',').length === 8),
    'a CSV row is missing a column',
  );
  // Flat and complete: grouped by cohort on screen, still carrying every
  // identity field, so the recipient can re-cut it by manager.
  check(
    lines.slice(1).some((line) => line.includes('"ana"')),
    'the export dropped the manager it was not grouped by',
  );
  check(
    lines.slice(1).every((line) => /"(never|dormant|lapsed)"/.test(line)),
    'a CSV row carries no cohort',
  );

  // The idle roster passes no note header and gets no cohort column.
  const plain = buildRosterCsv(roster, 'licence_usd');
  check(
    plain.split('\n')[0] === 'user_login,name,department,b1_manager,b2_manager,licence_usd',
    'omitting the note header still produced cohort columns',
  );
}

// ------------------------------------------------------------------- verdict

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('\nall waste cohort checks passed');
