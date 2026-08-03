import type { CopilotSeat } from '@dash/shared';
import { lastActiveLabel } from '../format.js';
import type { CostCentreDimension } from './costCentre.js';
import { idleSeats, staleness } from './idle.js';
import { groupRoster } from './roster.js';
import type { Roster, RosterSource } from './roster.js';

/**
 * The names behind the `IDLE SEATS` KPI — seats unused for 30 days or never
 * used at all, grouped by the manager or department you would contact.
 *
 * Activity semantics, no money: the seat's plan price is known, but this page
 * deliberately holds no dollars (`KpiRow`: "money lives in the spend
 * section"). The money-shaped question is the spend page's wasted roster,
 * which counts a different population — a seat used every day can still burn
 * no AI credits.
 *
 * Population and ordering both come from `idle.ts`, so this roster and the
 * reclaim list rank the same seats the same way.
 */

function toSource(seat: CopilotSeat): RosterSource {
  return {
    login: seat.login,
    displayName: seat.displayName,
    department: seat.department,
    b1Manager: seat.b1Manager,
    b2Manager: seat.b2Manager,
    detail: lastActiveLabel(seat.lastActivityDays),
    // Infinity for a never-used seat, which is the most idle there is.
    weight: staleness(seat),
  };
}

/**
 * Idle-seat roster.
 *
 * Always measurable: `lastActivityDays` comes from the seats endpoint itself,
 * so a null there means "never used" rather than "not reported" — unlike the
 * spend roster, there is no missing second report to confuse it with.
 */
export function idleRoster(
  seats: readonly CopilotSeat[],
  dimension: CostCentreDimension,
): Roster {
  const people = idleSeats(seats).map(toSource);

  // No money on this page, so every group weighs nothing and the ranking
  // falls through to headcount.
  return groupRoster(people, dimension, () => 0);
}
