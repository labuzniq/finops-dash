import { isIdle } from '@dash/shared';
import type { CopilotSeat } from '@dash/shared';

/** Idle seats, worst first — the reclaim list. Activity semantics, no money. */

export const RECLAIM_LIST_SIZE = 6;

/** Never used beats long-dormant. */
function staleness(seat: CopilotSeat): number {
  return seat.lastActivityDays ?? Number.POSITIVE_INFINITY;
}

export function reclaimCandidates(
  seats: readonly CopilotSeat[],
  limit = RECLAIM_LIST_SIZE,
): CopilotSeat[] {
  return seats
    .filter(isIdle)
    .sort((a, b) => {
      const left = staleness(a);
      const right = staleness(b);
      if (left !== right) return left < right ? 1 : -1;
      // Equal staleness: keep the order deterministic.
      return a.login.localeCompare(b.login);
    })
    .slice(0, limit);
}
