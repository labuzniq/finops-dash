import { isIdle } from '@dash/shared';
import type { CopilotSeat } from '@dash/shared';

/** Idle seats, worst first. Activity semantics, no money. */

/** Never used beats long-dormant. */
export function staleness(seat: CopilotSeat): number {
  return seat.lastActivityDays ?? Number.POSITIVE_INFINITY;
}

/**
 * Every idle seat, most stale first — the population and the ordering the
 * roster renders. One definition, so nothing can rank these seats two ways.
 */
export function idleSeats(seats: readonly CopilotSeat[]): CopilotSeat[] {
  return seats.filter(isIdle).sort((a, b) => {
    const left = staleness(a);
    const right = staleness(b);
    if (left !== right) return left < right ? 1 : -1;
    // Equal staleness: keep the order deterministic.
    return a.login.localeCompare(b.login);
  });
}
