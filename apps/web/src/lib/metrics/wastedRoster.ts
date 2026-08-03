import { usd } from '../format.js';
import type { CostCentreDimension } from './costCentre.js';
import { EMPTY_ROSTER, groupRoster } from './roster.js';
import type { Roster, RosterSource } from './roster.js';
import type { SpendUserRow } from './spend.js';

/**
 * The names behind `wastedSpend()` — licensed logins that recorded no AI
 * credits across the range, grouped by the manager or department you would
 * contact about them.
 *
 * The test is character-for-character the one in `wastedSpend()` and runs over
 * the same filtered rows, so the card's seat count and this roster's person
 * count cannot disagree. Any drift between them is a bug in one of the two.
 */

function isWasted(row: SpendUserRow): boolean {
  return row.licence > 0 && row.credits === 0;
}

function toSource(row: SpendUserRow): RosterSource {
  return {
    login: row.login,
    displayName: row.displayName,
    department: row.department,
    b1Manager: row.b1Manager,
    b2Manager: row.b2Manager,
    detail: usd(row.licence, 2),
    // Worst first is dearest first: the seat costing most is the one worth a
    // conversation, whatever plan it happens to be on.
    weight: row.licence,
  };
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
 */
export function wastedRoster(
  rows: readonly SpendUserRow[],
  dimension: CostCentreDimension,
): Roster {
  let credits = 0;
  for (const row of rows) credits += row.credits;
  if (credits <= 0) return { ...EMPTY_ROSTER, measurable: false };

  const people = rows.filter(isWasted).map(toSource);

  return groupRoster(people, dimension, (person) => person.weight);
}
