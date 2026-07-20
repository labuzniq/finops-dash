import { useMemo } from 'react';
import { rangeDayCount, wastedMonthlySpend } from '@dash/shared';
import type { CopilotSeat, SpendPoint } from '@dash/shared';
import { buildChartGeometry } from '../lib/metrics/chart.js';
import type { ChartGeometry } from '../lib/metrics/chart.js';
import { filterSeats } from '../lib/metrics/filter.js';
import { reclaimCandidates } from '../lib/metrics/idle.js';
import type { ReclaimCandidate } from '../lib/metrics/idle.js';
import { paginate, sortSeats } from '../lib/metrics/table.js';
import type { Page } from '../lib/metrics/table.js';
import { summariseSpend } from '../lib/metrics/spend.js';
import type { SpendSummary } from '../lib/metrics/spend.js';
import { buildUtilization } from '../lib/metrics/utilization.js';
import type { Utilization } from '../lib/metrics/utilization.js';
import type { DashboardState } from '../state/dashboardState.js';

/**
 * Every derived value on the page, in one memoised pipeline.
 *
 * At 1,000 seats the whole derivation runs in ~10ms, so recomputing on each
 * state change is cheaper than any caching scheme would be. The memo keys
 * split the work so that, say, paging doesn't re-derive the chart.
 */

export interface DashboardMetrics {
  filteredSeats: CopilotSeat[];
  spend: SpendSummary;
  chart: ChartGeometry;
  utilization: Utilization;
  page: Page<CopilotSeat>;
  reclaim: ReclaimCandidate[];
  /** Average spend per seat that was actually used in the last 28 days. */
  avgCostPerActiveUser: number;
  wastedMonthly: number;
  idleCount: number;
  /** Premium requests across the filtered seats, prorated to the range. */
  premiumRequestsUsed: number;
}

export function useDashboardMetrics(
  seats: readonly CopilotSeat[],
  series: readonly SpendPoint[],
  state: DashboardState,
): DashboardMetrics {
  const filteredSeats = useMemo(
    () => filterSeats(seats, { editor: state.editor, language: state.language, search: state.search }),
    [seats, state.editor, state.language, state.search],
  );

  // The API's series is org-wide; scale it to whatever the filters left standing.
  const ratio = seats.length === 0 ? 0 : filteredSeats.length / seats.length;

  const spend = useMemo(
    () => summariseSpend(series, state.range, ratio),
    [series, state.range, ratio],
  );

  const chart = useMemo(() => buildChartGeometry(spend.points), [spend.points]);
  const utilization = useMemo(() => buildUtilization(filteredSeats), [filteredSeats]);
  const reclaim = useMemo(() => reclaimCandidates(filteredSeats), [filteredSeats]);

  const rangeDays = rangeDayCount(state.range);

  const sorted = useMemo(
    () => sortSeats(filteredSeats, state.sortKey, state.sortDirection, rangeDays),
    [filteredSeats, state.sortKey, state.sortDirection, rangeDays],
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

  const wastedMonthly = useMemo(() => wastedMonthlySpend(filteredSeats), [filteredSeats]);

  return {
    filteredSeats,
    spend,
    chart,
    utilization,
    page,
    reclaim,
    avgCostPerActiveUser: utilization.activeCount === 0 ? 0 : spend.total / utilization.activeCount,
    wastedMonthly,
    idleCount: utilization.buckets
      .filter((bucket) => bucket.key === 'dormant' || bucket.key === 'never')
      .reduce((total, bucket) => total + bucket.count, 0),
    premiumRequestsUsed,
  };
}
