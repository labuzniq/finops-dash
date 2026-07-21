/**
 * Seat-activity thresholds and predicates. These are usage semantics, not
 * money — the cost model was deleted with the billing-report redesign, but
 * utilisation and idle-seat views still derive from these.
 */

import type { CopilotSeat } from './types.js';

/** A seat idle this long is reclaimable. */
export const IDLE_THRESHOLD_DAYS = 30;

/** The window a seat must have been used in to count as utilised. */
export const ACTIVE_WINDOW_DAYS = 28;

/** Used within `withinDays`. Never-used seats are never active. */
export function isActiveWithin(seat: CopilotSeat, withinDays: number): boolean {
  return seat.lastActivityDays !== null && seat.lastActivityDays <= withinDays;
}

/** Idle = dormant past the threshold, or never used at all. */
export function isIdle(seat: CopilotSeat): boolean {
  return seat.lastActivityDays === null || seat.lastActivityDays >= IDLE_THRESHOLD_DAYS;
}
