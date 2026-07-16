import { PLAN_PRICE, isIdle } from '@dash/shared';
import type { CopilotSeat } from '@dash/shared';

/** Idle seats, worst first — the reclaim list in the wasted-spend panel. */

export const RECLAIM_LIST_SIZE = 6;

export interface ReclaimCandidate {
  seat: CopilotSeat;
  /** What reclaiming this seat saves per month. */
  monthlyCost: number;
}

/** Never used beats long-dormant; ties break toward the pricier seat. */
function staleness(seat: CopilotSeat): number {
  return seat.lastActivityDays ?? Number.POSITIVE_INFINITY;
}

export function reclaimCandidates(
  seats: readonly CopilotSeat[],
  limit = RECLAIM_LIST_SIZE,
): ReclaimCandidate[] {
  return seats
    .filter(isIdle)
    .sort((a, b) => {
      const left = staleness(a);
      const right = staleness(b);
      if (left !== right) return left < right ? 1 : -1;
      return PLAN_PRICE[b.plan] - PLAN_PRICE[a.plan];
    })
    .slice(0, limit)
    .map((seat) => ({ seat, monthlyCost: PLAN_PRICE[seat.plan] }));
}
