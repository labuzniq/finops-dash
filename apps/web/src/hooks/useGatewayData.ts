import { useQuery } from '@tanstack/react-query';
import type { DateRange, GatewayUsage } from '@dash/shared';
import { fetchGatewayStatus, fetchGatewayUsage } from '../api/client.js';
import type { GatewayStatus } from '../api/client.js';
import type { ComparisonWindow } from '../lib/metrics/gatewayCompare.js';
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
