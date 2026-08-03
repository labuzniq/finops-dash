import { IDLE_THRESHOLD_DAYS } from '@dash/shared';
import type { CreditHistory } from '@dash/shared';
import { isoDateLabel } from '../format.js';
import type { SpendUserRow } from './spend.js';

/**
 * The wasted pile, split on when the money stopped.
 *
 * `wastedSpend()` counts logins the org paid a seat for that recorded no AI
 * credits across the range. That test says nothing at all about what happened
 * *before* the range, so a seat nobody has ever spent a credit on and one whose
 * owner was spending until three weeks ago land on the same row — and they are
 * not the same conversation. One is a reclaim; the other is a question about
 * what changed.
 *
 * The signal is the last credit day (`CreditHistory`, from Report 1) rather
 * than seat activity, because credits are the currency of the waste test
 * itself: `lastActivityDays` reports IDE use, so a person active daily can
 * still burn nothing, and splitting a credits-shaped population on an
 * activity-shaped field would produce a cohort called "never used" that means
 * something else entirely.
 */

export const WASTE_COHORTS = ['never', 'dormant', 'lapsed'] as const;
export type WasteCohort = (typeof WASTE_COHORTS)[number];

export interface WasteCohortRow {
  cohort: WasteCohort;
  /** The cohort in the card's voice — names the floor on `never`. */
  label: string;
  seats: number;
  /** Licence money wasted on this cohort. */
  amount: number;
  /** Share of the wasted total, 0..1. Zero when nothing is wasted. */
  share: number;
}

export interface WasteCohortSummary {
  rows: WasteCohortRow[];
  /** First day the per-model report covers — the floor "never" is measured to. */
  floor: string | null;
  /**
   * False when the report begins on or after the range's first day: there is
   * then no history before the window, every wasted seat reads `never` for a
   * reason that is arithmetic rather than a finding, and the split is withheld.
   * Distinct from `WastedSpend.measurable`, which fires when the range itself
   * carries no per-model report at all.
   */
  priorHistory: boolean;
}

const MS_PER_DAY = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

/**
 * Which cohort a login falls in, measured from the range's first day.
 *
 * The gap is anchored to the range start rather than to today so the cohort is
 * a property of the window on screen: a range from March re-opened in August
 * reads as it did in March, and nothing drifts as days pass. The idle roster
 * anchors on today for the opposite reason — it describes a live snapshot.
 *
 * The boundary is `>=`, the same comparison `isIdle` makes, so both waste
 * surfaces cut staleness in the same place.
 */
export function cohortOf(lastCredit: string | undefined, rangeStart: string): WasteCohort {
  if (lastCredit === undefined) return 'never';
  return daysBetween(lastCredit, rangeStart) >= IDLE_THRESHOLD_DAYS ? 'dormant' : 'lapsed';
}

/**
 * A person's last-credit fact, in the roster's voice.
 *
 * `never` names the floor instead of claiming never: a login whose last credit
 * predates the first imported day is indistinguishable from one that never had
 * any, and "never used it" is the claim that gets somebody's seat pulled
 * wrongly. With no floor at all there is nothing to name and nothing to claim.
 */
export function lastCreditLabel(
  lastCredit: string | undefined,
  floor: string | null,
): string {
  if (lastCredit !== undefined) return isoDateLabel(lastCredit);
  return floor === null ? 'No credits recorded' : `None since ${isoDateLabel(floor)}`;
}

/** The cohort in the card's and the chip's voice. */
export function cohortLabel(cohort: WasteCohort, floor: string | null): string {
  if (cohort === 'dormant') return `Dormant · ${IDLE_THRESHOLD_DAYS}d+ before the range`;
  if (cohort === 'lapsed') return `Lapsed · last credit within ${IDLE_THRESHOLD_DAYS}d`;
  return floor === null ? 'No credits recorded' : `No credits since ${isoDateLabel(floor)}`;
}

/** The short form, for chips and group rows where the card carries the floor. */
export function cohortShortLabel(cohort: WasteCohort): string {
  if (cohort === 'dormant') return 'Dormant';
  if (cohort === 'lapsed') return 'Lapsed';
  return 'Never';
}

function isWasted(row: SpendUserRow): boolean {
  return row.licence > 0 && row.credits === 0;
}

/**
 * The wasted total broken out by cohort.
 *
 * Runs the same `licence > 0 && credits === 0` test over the same filtered rows
 * as `wastedSpend()`, so the cohort seats sum to its seat count and the cohort
 * dollars to its wasted total. Every cohort is listed even at zero — the
 * population is known, so zero here is a fact rather than a gap.
 */
export function wasteCohortSummary(
  rows: readonly SpendUserRow[],
  history: CreditHistory,
  rangeStart: string,
): WasteCohortSummary {
  const priorHistory = history.floor !== null && history.floor < rangeStart;

  const seats = new Map<WasteCohort, { seats: number; amount: number }>(
    WASTE_COHORTS.map((cohort) => [cohort, { seats: 0, amount: 0 }]),
  );
  let total = 0;

  for (const row of rows) {
    if (!isWasted(row)) continue;
    const bucket = seats.get(cohortOf(history.lastCreditBefore[row.login], rangeStart));
    if (bucket === undefined) continue;
    bucket.seats += 1;
    bucket.amount += row.licence;
    total += row.licence;
  }

  const cohortRows = WASTE_COHORTS.map((cohort) => {
    const bucket = seats.get(cohort) ?? { seats: 0, amount: 0 };
    return {
      cohort,
      label: cohortLabel(cohort, history.floor),
      seats: bucket.seats,
      amount: bucket.amount,
      share: total > 0 ? bucket.amount / total : 0,
    };
  });

  return { rows: cohortRows, floor: history.floor, priorHistory };
}
