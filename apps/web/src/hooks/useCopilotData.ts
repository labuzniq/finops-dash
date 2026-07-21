import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type {
  BillingImportResult,
  CopilotSeat,
  DateRange,
  ModelUsage,
  RefreshJob,
  UsageHistory,
} from '@dash/shared';
import {
  fetchLatestRefreshJob,
  fetchModels,
  fetchRefreshJob,
  fetchSeats,
  fetchUsage,
  importBillingReport,
  importUserExport,
  startJiraSync,
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

/** Full usage history (org days, breakdowns, adoption) — sliced client-side. */
export function useUsage() {
  return useQuery<UsageHistory>({
    queryKey: ['usage', SERIES_DAYS],
    queryFn: () => fetchUsage(SERIES_DAYS),
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

/** The three upload slots of the Add-data modal. */
export type ImportSlot = 'model' | 'cost' | 'users';

/** What one slot ended up doing — rendered next to the slot that produced it. */
export type SlotOutcome =
  | { status: 'billing'; result: BillingImportResult }
  | { status: 'users'; rowsUpserted: number }
  | { status: 'error'; message: string };

export type SlotOutcomes = Partial<Record<ImportSlot, SlotOutcome>>;

/**
 * Import order. The user export lands first so the billing imports can report
 * an accurate `unknownLogins` — that set is computed against `github_users`.
 */
const SLOT_ORDER: ImportSlot[] = ['users', 'cost', 'model'];

export interface UseReportImports {
  /** Import every staged slot, in `SLOT_ORDER`. Values are raw CSV text. */
  runImport: (files: Partial<Record<ImportSlot, string>>) => void;
  isImporting: boolean;
  outcomes: SlotOutcomes;
  reset: () => void;
}

const NO_OUTCOMES: SlotOutcomes = {};

/**
 * The billing-report uploads. Each slot succeeds or fails on its own — a
 * rejected cost report must not discard a user export that already landed —
 * so failures are recorded per slot rather than thrown, and the dashboard
 * queries are invalidated when at least one slot got through.
 */
export function useReportImports(): UseReportImports {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (files: Partial<Record<ImportSlot, string>>): Promise<SlotOutcomes> => {
      const outcomes: SlotOutcomes = {};

      for (const slot of SLOT_ORDER) {
        const csv = files[slot];
        if (csv === undefined) continue;

        try {
          if (slot === 'users') {
            const { rowsUpserted } = await importUserExport(csv);
            outcomes[slot] = { status: 'users', rowsUpserted };
          } else {
            outcomes[slot] = { status: 'billing', result: await importBillingReport(csv) };
          }
        } catch (error) {
          outcomes[slot] = { status: 'error', message: (error as Error).message };
        }
      }

      return outcomes;
    },
    onSuccess: (outcomes) => {
      const landed = Object.values(outcomes).some((outcome) => outcome.status !== 'error');
      if (!landed) return;

      void queryClient.invalidateQueries({ queryKey: ['seats'] });
      void queryClient.invalidateQueries({ queryKey: ['spend'] });
      void queryClient.invalidateQueries({ queryKey: ['models'] });
      void queryClient.invalidateQueries({ queryKey: ['usage'] });
    },
  });

  return {
    runImport: (files) => mutation.mutate(files),
    isImporting: mutation.isPending,
    outcomes: mutation.data ?? NO_OUTCOMES,
    reset: () => mutation.reset(),
  };
}

/** The last sync of any status — drives the "synced 2h ago" note. */
export function useLatestRefreshJob() {
  return useQuery<RefreshJob | null>({
    queryKey: ['refresh', 'latest', 'copilot'],
    queryFn: () => fetchLatestRefreshJob('copilot'),
  });
}

/** The last JIRA identity sync — the modal's JIRA row reads its status. */
export function useLatestJiraJob() {
  return useQuery<RefreshJob | null>({
    queryKey: ['refresh', 'latest', 'jira'],
    queryFn: () => fetchLatestRefreshJob('jira'),
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
      void queryClient.invalidateQueries({ queryKey: ['usage'] });
    }
    void queryClient.invalidateQueries({ queryKey: ['refresh', 'latest'] });
  }, [job, queryClient]);

  return {
    refresh: () => start.mutate(),
    isRunning: jobId !== null || start.isPending,
    error: job?.status === 'failed' ? job.error : null,
  };
}

export interface UseJiraSync {
  sync: () => void;
  isRunning: boolean;
  /** A failed job's error, or the 503 message when JIRA env is unconfigured. */
  error: string | null;
}

/**
 * The JIRA identity sync. Same job table and polling shape as the Copilot
 * refresh (kind `jira`); on success only `spend` changes, since identity is
 * joined into the spend payload alone.
 */
export function useJiraSync(): UseJiraSync {
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: startJiraSync,
    onSuccess: (job) => setJobId(job.id),
  });

  const { data: job } = useQuery<RefreshJob>({
    queryKey: ['refresh', jobId],
    queryFn: () => fetchRefreshJob(jobId!),
    enabled: jobId !== null,
    refetchInterval: (query) => (isSettled(query.state.data) ? false : POLL_INTERVAL_MS),
  });

  useEffect(() => {
    if (!isSettled(job)) return;

    setJobId(null);
    if (job?.status === 'succeeded') {
      void queryClient.invalidateQueries({ queryKey: ['spend'] });
    }
    void queryClient.invalidateQueries({ queryKey: ['refresh', 'latest', 'jira'] });
  }, [job, queryClient]);

  return {
    sync: () => start.mutate(),
    isRunning: jobId !== null || start.isPending,
    // A 503 from the start call never produces a job, so surface it directly.
    error: job?.status === 'failed' ? job.error : (start.error?.message ?? null),
  };
}
