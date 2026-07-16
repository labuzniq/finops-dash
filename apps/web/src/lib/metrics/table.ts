import { seatPeriodCost } from '@dash/shared';
import type { CopilotSeat } from '@dash/shared';

/** Sorting and pagination for the per-user table. */

export const ROWS_PER_PAGE = 12;

export type SortKey = 'premiumRequests' | 'acceptance' | 'lastActive' | 'cost';

/** -1 = descending (the default on every column), 1 = ascending. */
export type SortDirection = -1 | 1;

/**
 * The sortable value for a column.
 *
 * Unknown numbers sort below every real one; a never-used seat is the most
 * idle there is, so it sorts as infinitely stale.
 */
function sortValue(seat: CopilotSeat, key: SortKey, rangeDays: number): number {
  switch (key) {
    case 'cost':
      return seatPeriodCost(seat, rangeDays);
    case 'premiumRequests':
      return seat.premiumRequests28d ?? -1;
    case 'acceptance':
      return seat.acceptanceRate ?? -1;
    case 'lastActive':
      return seat.lastActivityDays ?? Number.POSITIVE_INFINITY;
  }
}

export function sortSeats(
  seats: readonly CopilotSeat[],
  key: SortKey,
  direction: SortDirection,
  rangeDays: number,
): CopilotSeat[] {
  return [...seats].sort((a, b) => {
    const left = sortValue(a, key, rangeDays);
    const right = sortValue(b, key, rangeDays);
    // Compare rather than subtract: Infinity - Infinity is NaN, which corrupts the sort.
    if (left === right) return 0;
    return (left < right ? -1 : 1) * direction;
  });
}

export interface Page<T> {
  items: T[];
  /** Clamped — a filter change can strand the current page past the end. */
  index: number;
  count: number;
  /** "13–24 of 1,000" */
  label: string;
}

export function paginate<T>(items: readonly T[], requestedIndex: number): Page<T> {
  const count = Math.max(1, Math.ceil(items.length / ROWS_PER_PAGE));
  const index = Math.min(Math.max(0, requestedIndex), count - 1);
  const start = index * ROWS_PER_PAGE;
  const end = Math.min(items.length, start + ROWS_PER_PAGE);

  return {
    items: items.slice(start, end),
    index,
    count,
    label: `${items.length === 0 ? 0 : start + 1}–${end} of ${items.length.toLocaleString('en-US')}`,
  };
}
