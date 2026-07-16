import { ACTIVE_WINDOW_DAYS, isActiveWithin, seatPeriodCost } from '@dash/shared';
import type { CopilotSeat } from '@dash/shared';
import { EMPTY } from '../format.js';

/**
 * Optional grouping for the per-user usage & cost table. `none` keeps the flat
 * paginated list; the others collapse seats into labelled sections so cost and
 * headcount can be read per model, per activity state, or per editor.
 */

export type GroupBy = 'none' | 'model' | 'activity' | 'editor';

export interface SeatGroup {
  /** Stable identity for the React key. */
  key: string;
  label: string;
  seats: CopilotSeat[];
  count: number;
  /** Summed seat cost over the range — the section's contribution to spend. */
  totalCost: number;
}

/** The bucket a seat falls in for the chosen dimension. */
function groupValue(seat: CopilotSeat, groupBy: Exclude<GroupBy, 'none'>): string {
  switch (groupBy) {
    case 'model':
      return seat.topModel ?? EMPTY;
    case 'activity':
      return isActiveWithin(seat, ACTIVE_WINDOW_DAYS) ? 'Active' : 'Inactive';
    case 'editor':
      return seat.editor ?? EMPTY;
  }
}

/**
 * Collapse already-sorted seats into groups. Seat order inside each group is
 * preserved (so the table's active sort still holds), and groups themselves are
 * ordered by total cost, richest first — the same descending-cost intuition the
 * flat table opens with.
 */
export function groupSeats(
  seats: readonly CopilotSeat[],
  groupBy: GroupBy,
  rangeDays: number,
): SeatGroup[] {
  if (groupBy === 'none') return [];

  const byKey = new Map<string, SeatGroup>();
  for (const seat of seats) {
    const label = groupValue(seat, groupBy);
    let group = byKey.get(label);
    if (!group) {
      group = { key: label, label, seats: [], count: 0, totalCost: 0 };
      byKey.set(label, group);
    }
    group.seats.push(seat);
    group.count += 1;
    group.totalCost += seatPeriodCost(seat, rangeDays);
  }

  return [...byKey.values()].sort((a, b) => b.totalCost - a.totalCost);
}
