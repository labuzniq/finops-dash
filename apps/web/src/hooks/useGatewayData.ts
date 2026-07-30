import { useQuery } from '@tanstack/react-query';
import type { DateRange, GatewayUsage } from '@dash/shared';
import { fetchGatewayStatus, fetchGatewayUsage } from '../api/client.js';
import type { GatewayStatus } from '../api/client.js';
import type { ComparisonWindow } from '../lib/metrics/gatewayCompare.js';
import type { ForecastRange } from '../lib/metrics/gatewayForecast.js';
import { spendRangeBounds } from './useSpendData.js';

/**
 * LLM-gateway usage for the selected range — the LiteLLM counterpart to
 * `useSpendData`, and deliberately the same shape: one fetch per range, every
 * KPI, chart and drill-down derived client-side.
 *
 * The range bounds come from `spendRangeBounds` so the gateway view and the
 * Copilot spend view always mean the same calendar days by "last 28 days".
 */

export function useGatewayData(range: DateRange) {
  const { from, to } = spendRangeBounds(range);
  return useQuery<GatewayUsage>({
    queryKey: ['gateway', from, to],
    queryFn: () => fetchGatewayUsage(from, to),
  });
}

/**
 * The window immediately before the visible one, fetched only once the current
 * one has answered — its bounds are derived from the *trimmed* spine, which
 * does not exist until the data does. A second fetch rather than one widened
 * range keeps each query cached under the days it actually covers, so stepping
 * 7d → 28d → 7d re-reads nothing.
 *
 * `null` while there is nothing to compare (empty spine, or a prior window
 * older than what the proxy retains) — the query simply does not run.
 */
export function useGatewayComparisonData(window: ComparisonWindow | null) {
  return useQuery<GatewayUsage>({
    queryKey: ['gateway', window?.from ?? 'none', window?.to ?? 'none'],
    queryFn: () => fetchGatewayUsage(window?.from ?? '', window?.to ?? ''),
    enabled: window !== null,
  });
}

/**
 * The current calendar month plus the four weeks before it — the month-end
 * forecast's own window, deliberately independent of the range picker: a
 * projection is only meaningful against the period a budget is set in.
 *
 * Its bounds move once a day and once a month, so it caches for the day, and
 * at 58 days at most it is always inside the proxy's 90-day retention. Gated on
 * the gateway being configured at all, since nothing on the page would render
 * the answer.
 */
export function useGatewayForecastData(range: ForecastRange, enabled: boolean) {
  return useQuery<GatewayUsage>({
    queryKey: ['gateway', range.from, range.to],
    queryFn: () => fetchGatewayUsage(range.from, range.to),
    enabled,
  });
}

/**
 * Whether a gateway source is configured at all. Static for the process
 * lifetime — the API reads it from env at boot — so it never refetches.
 */
export function useGatewayStatus() {
  return useQuery<GatewayStatus>({
    queryKey: ['gateway', 'status'],
    queryFn: fetchGatewayStatus,
    staleTime: Infinity,
  });
}
