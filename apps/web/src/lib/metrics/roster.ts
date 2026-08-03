import { UNASSIGNED } from './costCentre.js';
import type { CostCentreDimension } from './costCentre.js';
import type { WasteCohort } from './wasteCohort.js';

/**
 * The shape both waste rosters produce and one table renders.
 *
 * The dashboard's two waste surfaces — wasted licence money on the spend page,
 * idle seats on the usage page — each report a number and no people, which is
 * the one thing you cannot act on. A roster puts the names behind the number,
 * grouped by the org dimension whose owner you would actually contact.
 *
 * The two populations stay in separate modules because they are separate
 * questions (see `wastedRoster.ts` and `idleRoster.ts`); what they share is
 * only the grouping, which is this file.
 */

export interface RosterPerson {
  login: string;
  displayName: string;
  /**
   * Every identity field, not only the one currently grouped by: the CSV is
   * flat and carries all three so a recipient can pivot it the other way
   * without re-exporting.
   */
  department: string | null;
  b1Manager: string | null;
  b2Manager: string | null;
  /**
   * The row's right-hand fact, already formatted by the module that built it:
   * licence money on the spend roster, a last-active label on the idle one.
   * Formatted rather than typed because the two carry different units and the
   * table must not pick one of them to be the truth.
   */
  detail: string;
  /**
   * A second right-hand fact, where the roster has one: the last credit day on
   * the wasted roster, absent on the idle one. Optional rather than empty,
   * because a column with nothing in it is worse than no column.
   */
  note?: string;
  /**
   * Which waste cohort this person is in — set by the wasted roster only, and
   * what makes `cohort` groupable. Absent on the idle roster, whose population
   * has no such split.
   */
  cohort?: WasteCohort;
  /**
   * Worst-first sort weight within the group — licence dollars, or staleness
   * in days. Never rendered.
   */
  weight: number;
}

/**
 * What a roster may be grouped by. The org dimensions are the question "who
 * would have this conversation"; `cohort` is the question "which conversation
 * is it", and only the wasted roster carries one.
 */
export type RosterGroupBy = CostCentreDimension | 'cohort';

export interface RosterGroup {
  /**
   * The dimension value, or null for the unassigned bucket. Null is a
   * data-quality remainder — an unmapped identity, or a mapped person with no
   * manager on record — so it ranks last and never drills.
   */
  key: string | null;
  label: string;
  people: RosterPerson[];
  /** Wasted licence money; zero on the idle roster, which carries no money. */
  amount: number;
}

export interface Roster {
  groups: RosterGroup[];
  /** People across every group — the number the source card also reports. */
  people: number;
  /** Money across every group; zero on the idle roster. */
  amount: number;
  /**
   * False when the source cannot tell an unused seat from an unreported one.
   * Callers must render the refusal rather than a roster of everybody.
   */
  measurable: boolean;
}

/**
 * What the two derivation modules hand in. Identical to `RosterPerson` — the
 * grouping reads the identity fields and the table renders them, so nothing is
 * dropped in between.
 */
export type RosterSource = RosterPerson;

export const EMPTY_ROSTER: Roster = { groups: [], people: 0, amount: 0, measurable: true };

/**
 * Group people by one dimension, worst bucket first.
 *
 * Ranking is by money where there is money and by headcount where there is
 * not, so the first row is always the conversation to have first. The
 * unassigned bucket sorts last regardless of size, exactly as in
 * `costCentreRollup` — ranking it among real managers invites reading it as
 * one, and no filter can select "people with no manager".
 *
 * `labelOf` is how a key that is an identifier rather than a name renders: the
 * cohort keys are `never`/`dormant`/`lapsed` and the reader is owed prose. Org
 * dimensions pass nothing, since their key already is their label.
 */
export function groupRoster(
  people: readonly RosterSource[],
  dimension: RosterGroupBy,
  amountOf: (person: RosterSource) => number,
  labelOf?: (key: string) => string,
): Roster {
  const byKey = new Map<string, RosterGroup>();
  let totalAmount = 0;

  for (const person of people) {
    // `cohort` is optional on the shared shape and set on every person of the
    // roster that offers it, so an undefined here is the same absence a null
    // org field is: the unassigned bucket, never a cohort of its own.
    const raw = person[dimension] ?? null;
    const key = raw === '' ? null : raw;
    // Map keys must be strings; the sentinel cannot collide with a real value
    // because a real value is never empty.
    const mapKey = key ?? '';

    const label = key === null ? UNASSIGNED : (labelOf?.(key) ?? key);
    const group = byKey.get(mapKey) ?? { key, label, people: [], amount: 0 };
    const amount = amountOf(person);
    group.people.push(person);
    group.amount += amount;
    byKey.set(mapKey, group);

    totalAmount += amount;
  }

  const groups = [...byKey.values()];

  for (const group of groups) {
    // Compare rather than subtract: a never-used seat weighs Infinity, and
    // Infinity - Infinity is NaN, which corrupts the sort.
    group.people.sort((a, b) => {
      if (a.weight !== b.weight) return a.weight < b.weight ? 1 : -1;
      return a.displayName.localeCompare(b.displayName);
    });
  }

  groups.sort((a, b) => {
    if (a.key === null) return 1;
    if (b.key === null) return -1;
    return b.amount - a.amount || b.people.length - a.people.length || a.label.localeCompare(b.label);
  });

  // Always measurable: the unmeasurable case never reaches here — the caller
  // that cannot tell an unused seat from an unreported one returns
  // `EMPTY_ROSTER` with the flag cleared rather than grouping nobody.
  return { groups, people: people.length, amount: totalAmount, measurable: true };
}
