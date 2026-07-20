import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { CopilotSeat, DateRange, ImportResult, ModelUsage, RefreshJob, SpendPoint } from '@dash/shared';
import {
  fetchLatestRefreshJob,
  fetchModels,
  fetchRefreshJob,
  fetchSeats,
  fetchSpend,
  importData,
  startRefresh,
} from '../api/client.js';

/**
 * Server data and the on-demand refresh.
 *
 * The refresh is asynchronous by design: POST returns a job, and the job is
 * polled until it settles. Only then are the data queries invalidated, so the
 * dashboard swaps to fresh numbers in one step rather than tearing.
 */

/** The dashboard always holds the full history and slices it client-side. */
const SERIES_DAYS = 90;

const POLL_INTERVAL_MS = 1_000;

function isSettled(job: RefreshJob | undefined): boolean {
  return job?.status === 'succeeded' || job?.status === 'failed';
}

export function useSeats() {
  return useQuery<CopilotSeat[]>({ queryKey: ['seats'], queryFn: fetchSeats });
}

export function useSpend() {
  return useQuery<SpendPoint[]>({
    queryKey: ['spend', SERIES_DAYS],
    queryFn: () => fetchSpend(SERIES_DAYS),
  });
}

/** Per-model activity over the selected range — backs the per-model view. */
export function useModels(range: DateRange) {
  const key = range.kind === 'preset' ? `${range.days}d` : `${range.from}_${range.to}`;
  return useQuery<ModelUsage[]>({
    queryKey: ['models', key],
    queryFn: () => fetchModels(range),
  });
}

export interface UseImport {
  runImport: (content: string) => void;
  isImporting: boolean;
  result: ImportResult | null;
  error: string | null;
  reset: () => void;
}

/** Manual CSV/JSON import; invalidates the dashboard queries on success. */
export function useImport(): UseImport {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: importData,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['seats'] });
      void queryClient.invalidateQueries({ queryKey: ['spend'] });
      void queryClient.invalidateQueries({ queryKey: ['models'] });
    },
  });

  return {
    runImport: (content: string) => mutation.mutate(content),
    isImporting: mutation.isPending,
    result: mutation.data ?? null,
    error: mutation.error ? (mutation.error as Error).message : null,
    reset: () => mutation.reset(),
  };
}

/** The last sync of any status — drives the "synced 2h ago" note. */
export function useLatestRefreshJob() {
  return useQuery<RefreshJob | null>({
    queryKey: ['refresh', 'latest'],
    queryFn: fetchLatestRefreshJob,
  });
}

export interface UseRefresh {
  /** Kick off a sync; safe to call twice — the API returns the in-flight job. */
  refresh: () => void;
  isRunning: boolean;
  error: string | null;
}

export function useRefresh(): UseRefresh {
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: startRefresh,
    onSuccess: (job) => setJobId(job.id),
  });

  const { data: job } = useQuery<RefreshJob>({
    queryKey: ['refresh', jobId],
    queryFn: () => fetchRefreshJob(jobId!),
    enabled: jobId !== null,
    // Stop polling the moment the job reaches a terminal state.
    refetchInterval: (query) => (isSettled(query.state.data) ? false : POLL_INTERVAL_MS),
  });

  useEffect(() => {
    if (!isSettled(job)) return;

    setJobId(null);
    if (job?.status === 'succeeded') {
      void queryClient.invalidateQueries({ queryKey: ['seats'] });
      void queryClient.invalidateQueries({ queryKey: ['spend'] });
      void queryClient.invalidateQueries({ queryKey: ['models'] });
    }
    void queryClient.invalidateQueries({ queryKey: ['refresh', 'latest'] });
  }, [job, queryClient]);

  return {
    refresh: () => start.mutate(),
    isRunning: jobId !== null || start.isPending,
    error: job?.status === 'failed' ? job.error : null,
  };
}
