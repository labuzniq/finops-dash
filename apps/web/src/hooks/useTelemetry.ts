import { useQuery } from '@tanstack/react-query';
import type { TelemetryRollupRow } from '@dash/shared';
import { fetchTelemetryRollup } from '../api/client.js';

/** Telemetry always holds the full history and slices it client-side. */
const SERIES_DAYS = 90;

/** Exporters post continuously, so the rollup refetches on a steady cadence. */
const REFETCH_MS = 60_000;

export function useTelemetryRollup() {
  return useQuery<TelemetryRollupRow[]>({
    queryKey: ['telemetry', SERIES_DAYS],
    queryFn: () => fetchTelemetryRollup(SERIES_DAYS),
    refetchInterval: REFETCH_MS,
  });
}
