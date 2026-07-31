import { useQuery } from '@tanstack/react-query';
import type {
  DateRange,
  GatewayBudgets,
  GatewayCoverage,
  GatewayProbe,
  GatewaySealHistory,
  GatewaySeals,
  GatewayUsage,
} from '@dash/shared';
import {
  fetchGatewayBudgets,
  fetchGatewayCoverage,
  fetchGatewayProbe,
  fetchGatewaySealHistory,
  fetchGatewaySeals,
  fetchGatewayStatus,
  fetchGatewayUsage,
} from '../api/client.js';
import type { GatewayStatus } from '../api/client.js';
import type { ChargebackRange } from '../lib/metrics/gatewayChargeback.js';
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
 * One billing month plus the one before it — the chargeback statement's own
 * window, picked by month rather than read off the range picker because an
 * invoice period is a calendar month and nothing else.
 *
 * Both months come in one request (62 days at most, inside retention by
 * construction) so every line on the statement carries a prior-month figure
 * without a second round trip, and switching between the offered months
 * re-reads only the months not already cached.
 */
export function useGatewayChargebackData(range: ChargebackRange, enabled: boolean) {
  return useQuery<GatewayUsage>({
    queryKey: ['gateway', range.from, range.to],
    queryFn: () => fetchGatewayUsage(range.from, range.to),
    enabled,
  });
}

/**
 * The proxy's current budgets and limits — one row per key and per team, with
 * no date range and no history: it is configuration plus the counter for the
 * period in flight, replaced wholesale by every sync.
 *
 * Cached under a key with no bounds in it for exactly that reason, and gated on
 * the gateway being configured. A proxy that refuses the management routes to
 * an analytics-only credential answers an empty list rather than an error, so
 * "no budgets" and "no permission" look the same here — the card says so.
 */
export function useGatewayBudgets(enabled: boolean) {
  return useQuery<GatewayBudgets>({
    queryKey: ['gateway', 'budgets'],
    queryFn: fetchGatewayBudgets,
    enabled,
  });
}

/**
 * Which days are stored — the query every other gateway query is bounded by.
 *
 * It has to answer before the page can honestly clamp its pickers, so it runs
 * on mount alongside the usage fetch rather than being gated on it. Until it
 * does, the page falls back to the proxy's retention window, which is the
 * narrower and therefore safe answer: it can hide stored history for a moment,
 * but it can never offer a range that has nothing behind it.
 *
 * Invalidated by a sync like the usage queries, since a sync is the only thing
 * that adds a day.
 */
export function useGatewayCoverage(enabled: boolean) {
  return useQuery<GatewayCoverage>({
    queryKey: ['gateway', 'coverage'],
    queryFn: fetchGatewayCoverage,
    enabled,
  });
}

/**
 * The months that have been sealed.
 *
 * A handful of rows with no bounds, cached like the coverage read and
 * invalidated by the same sync prefix — a sync is the only thing that takes a
 * seal. The chargeback card uses it twice: to label a statement as the one that
 * was issued, and to notice when the daily rows have moved away from it.
 */
export function useGatewaySeals(enabled: boolean) {
  return useQuery<GatewaySeals>({
    queryKey: ['gateway', 'months'],
    queryFn: fetchGatewaySeals,
    enabled,
  });
}

/**
 * Every statement one month has carried, for a month that has been re-sealed.
 *
 * Deliberately gated on that: `enabled` is the caller's answer to "does this
 * month have more than one revision", which the seal list already carries, so
 * an ordinary month costs no extra request. Cached per month under the same
 * `gateway` prefix the sync invalidates.
 */
export function useGatewaySealHistory(month: string, enabled: boolean) {
  return useQuery<GatewaySealHistory>({
    queryKey: ['gateway', 'months', month, 'revisions'],
    queryFn: () => fetchGatewaySealHistory(month),
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

/**
 * A live connection check, run on demand.
 *
 * The one gateway query that does not run on mount: it costs a round trip to
 * the proxy per route, so a page that renders it would probe the corporate
 * gateway every time someone opened Data sources. `refetch()` is the trigger,
 * and the result stays cached afterwards so the panel survives a navigation
 * without re-probing — with `staleTime: 0`, since a probe is a statement about
 * one moment and asking again is the entire point of the button.
 */
export function useGatewayProbe() {
  return useQuery<GatewayProbe>({
    queryKey: ['gateway', 'probe'],
    queryFn: fetchGatewayProbe,
    enabled: false,
    staleTime: 0,
    retry: false,
    gcTime: 5 * 60_000,
  });
}
