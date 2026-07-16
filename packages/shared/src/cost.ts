/**
 * The Copilot cost model. Single source of truth — the API and the web app
 * both derive from these functions so a price change lands in one place.
 */

import type { CopilotSeat, Plan } from './types.js';

/** USD per seat per month. */
export const PLAN_PRICE: Record<Plan, number> = {
  Business: 19,
  Enterprise: 39,
};

/** Premium requests included per seat per month before overage kicks in. */
export const PREMIUM_ALLOWANCE: Record<Plan, number> = {
  Business: 300,
  Enterprise: 1_000,
};

/** USD billed per premium request beyond the allowance. */
export const OVERAGE_RATE = 0.04;

/** GitHub reports premium request usage over a rolling 28-day window. */
export const PREMIUM_WINDOW_DAYS = 28;

/** Licenses bill monthly; a month is normalised to 30 days for daily blending. */
export const BILLING_MONTH_DAYS = 30;

/** A seat idle this long is reclaimable spend. */
export const IDLE_THRESHOLD_DAYS = 30;

/** The window a seat must have been used in to count as utilised. */
export const ACTIVE_WINDOW_DAYS = 28;

/** Monthly overage for a seat. Unknown request counts cost nothing, not zero-usage. */
export function premiumOverage(plan: Plan, premiumRequests28d: number | null): number {
  if (premiumRequests28d === null) return 0;
  return Math.max(0, premiumRequests28d - PREMIUM_ALLOWANCE[plan]) * OVERAGE_RATE;
}

/** What one seat costs over `rangeDays`: prorated license plus prorated overage. */
export function seatPeriodCost(seat: CopilotSeat, rangeDays: number): number {
  const license = PLAN_PRICE[seat.plan] * (rangeDays / BILLING_MONTH_DAYS);
  const overage =
    premiumOverage(seat.plan, seat.premiumRequests28d) * (rangeDays / PREMIUM_WINDOW_DAYS);
  return license + overage;
}

/** Used within `withinDays`. Never-used seats are never active. */
export function isActiveWithin(seat: CopilotSeat, withinDays: number): boolean {
  return seat.lastActivityDays !== null && seat.lastActivityDays <= withinDays;
}

/** Idle = dormant past the threshold, or never used at all. */
export function isIdle(seat: CopilotSeat): boolean {
  return seat.lastActivityDays === null || seat.lastActivityDays >= IDLE_THRESHOLD_DAYS;
}

/** Monthly license spend on seats nobody is using. */
export function wastedMonthlySpend(seats: readonly CopilotSeat[]): number {
  return seats.filter(isIdle).reduce((total, seat) => total + PLAN_PRICE[seat.plan], 0);
}
