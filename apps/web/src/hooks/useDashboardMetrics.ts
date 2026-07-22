import { useMemo } from 'react';
import { rangeDayCount } from '@dash/shared';
import type { CopilotSeat } from '@dash/shared';
import { filterSeats } from '../lib/metrics/filter.js';
import { reclaimCandidates } from '../lib/metrics/idle.js';
import { paginate, sortSeats } from '../lib/metrics/table.js';
import type { Page } from '../lib/metrics/table.js';
import { buildUtilization } from '../lib/metrics/utilization.js';
import type { Utilization } from '../lib/metrics/utilization.js';
import type { DashboardState } from '../state/dashboardState.js';

/**
 * Every seat-derived value on the usage page, in one memoised pipeline.
 *
 * Usage semantics only — money comes from the billing reports and lives in
 * the spend section (`useSpendData` + `lib/metrics/spend.ts`), never here.
 *
 * At 1,000 seats the whole derivation runs in ~10ms, so recomputing on each
 * state change is cheaper than any caching scheme would be. The memo keys
 * split the work so that, say, paging doesn't re-derive the utilisation.
 */

export interface DashboardMetrics {
  filteredSeats: CopilotSeat[];
  utilization: Utilization;
  page: Page<CopilotSeat>;
  /** Idle seats, worst first — the reclaim list. */
  reclaim: CopilotSeat[];
  idleCount: number;
  /** Premium requests across the filtered seats, prorated to the range. */
  premiumRequestsUsed: number;
}

export function useDashboardMetrics(
  seats: readonly CopilotSeat[],
  state: DashboardState,
): DashboardMetrics {
  const filteredSeats = useMemo(
    () =>
      filterSeats(seats, {
        editor: state.editor,
        language: state.language,
        search: state.search,
        scope: state.seatScope,
      }),
    [seats, state.editor, state.language, state.search, state.seatScope],
  );

  const utilization = useMemo(() => buildUtilization(filteredSeats), [filteredSeats]);
  const reclaim = useMemo(() => reclaimCandidates(filteredSeats), [filteredSeats]);

  const rangeDays = rangeDayCount(state.range);

  const sorted = useMemo(
    () => sortSeats(filteredSeats, state.sortKey, state.sortDirection),
    [filteredSeats, state.sortKey, state.sortDirection],
  );

  const page = useMemo(() => paginate(sorted, state.page), [sorted, state.page]);

  const premiumRequestsUsed = useMemo(
    () =>
      Math.round(
        filteredSeats.reduce((total, seat) => total + (seat.premiumRequests28d ?? 0), 0) *
          (rangeDays / 28),
      ),
    [filteredSeats, rangeDays],
  );

  return {
    filteredSeats,
    utilization,
    page,
    reclaim,
    idleCount: utilization.buckets
      .filter((bucket) => bucket.key === 'dormant' || bucket.key === 'never')
      .reduce((total, bucket) => total + bucket.count, 0),
    premiumRequestsUsed,
  };
}
