import type { CreditHistory } from '@dash/shared';
import { usd } from '../format.js';
import { EMPTY_ROSTER, groupRoster } from './roster.js';
import type { Roster, RosterGroupBy, RosterSource } from './roster.js';
import type { SpendUserRow } from './spend.js';
import { cohortOf, cohortShortLabel, lastCreditLabel } from './wasteCohort.js';
import type { WasteCohort } from './wasteCohort.js';

/**
 * The names behind `wastedSpend()` — licensed logins that recorded no AI
 * credits across the range, grouped by the manager or department you would
 * contact about them, and carrying the cohort that says which conversation it
 * is: never spent a credit, dormant, or lapsed only recently.
 *
 * The test is character-for-character the one in `wastedSpend()` and runs over
 * the same filtered rows, so the card's seat count and this roster's person
 * count cannot disagree. Any drift between them is a bug in one of the two.
 */

function isWasted(row: SpendUserRow): boolean {
  return row.licence > 0 && row.credits === 0;
}

function toSource(row: SpendUserRow, history: CreditHistory, rangeStart: string): RosterSource {
  const lastCredit = history.lastCreditBefore[row.login];

  return {
    login: row.login,
    displayName: row.displayName,
    department: row.department,
    b1Manager: row.b1Manager,
    b2Manager: row.b2Manager,
    detail: usd(row.licence, 2),
    note: lastCreditLabel(lastCredit, history.floor),
    cohort: cohortOf(lastCredit, rangeStart),
    // Worst first is dearest first: the seat costing most is the one worth a
    // conversation, whatever plan it happens to be on.
    weight: row.licence,
  };
}

/**
 * Group labels for the cohort dimension — `groupRoster` hands back a bare map
 * key, and a key that is not a cohort can only be a bug, so it renders as
 * itself rather than being silently relabelled as one.
 */
function groupLabel(key: string): string {
  if (key === 'never' || key === 'dormant' || key === 'lapsed') return cohortShortLabel(key);
  return key;
}

/**
 * Wasted-seat roster for the range.
 *
 * When the range carries no credits anywhere, every login reads as unused for
 * two indistinguishable reasons — nobody used it, or Report 1 was never
 * imported — so the roster is empty and `measurable` is false. That is the
 * same coarse guard `wastedSpend()` applies, and for the same reason: naming
 * a thousand people on the strength of a missing import is worse than naming
 * none.
 *
 * `cohort` narrows the population **before** grouping, so a group's bar, its
 * dollars, the chip that selected it and the export all describe the same
 * people. Filtering after grouping would leave the bars sized to a population
 * the table is no longer showing.
 */
export function wastedRoster(
  rows: readonly SpendUserRow[],
  dimension: RosterGroupBy,
  history: CreditHistory,
  rangeStart: string,
  cohort: WasteCohort | null = null,
): Roster {
  let credits = 0;
  for (const row of rows) credits += row.credits;
  if (credits <= 0) return { ...EMPTY_ROSTER, measurable: false };

  const people = rows
    .filter(isWasted)
    .map((row) => toSource(row, history, rangeStart))
    .filter((person) => cohort === null || person.cohort === cohort);

  return groupRoster(people, dimension, (person) => person.weight, groupLabel);
}
