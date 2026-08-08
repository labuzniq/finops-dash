import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type {
  BillingImportResult,
  CopilotSeat,
  DateRange,
  ImportLogEntry,
  ImportSlot,
  ModelUsage,
  RefreshJob,
  RefreshKind,
  UsageHistory,
} from '@dash/shared';
import {
  fetchImportLogs,
  fetchLatestRefreshJob,
  fetchModels,
  fetchRefreshJob,
  fetchSeats,
  fetchUsage,
  importBillingReport,
  importUserExport,
  startBillingSync,
  startJiraSync,
  startMembersSync,
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

/** What one slot ended up doing — rendered next to the slot that produced it. */
export type SlotOutcome =
  | { status: 'billing'; result: BillingImportResult }
  | { status: 'users'; rowsUpserted: number }
  | { status: 'error'; message: string };

export type SlotOutcomes = Partial<Record<ImportSlot, SlotOutcome>>;

/** One staged file as the upload needs it: the text, and what to log it as. */
export interface SlotUpload {
  csv: string;
  /** The file's own name — the only thing the import log can call the run. */
  filename: string;
}

export type SlotUploads = Partial<Record<ImportSlot, SlotUpload>>;

/**
 * Import order. The user export lands first so the billing imports can report
 * an accurate `unknownLogins` — that set is computed against `github_users`.
 */
const SLOT_ORDER: ImportSlot[] = ['users', 'cost', 'model'];

export interface UseReportImports {
  /** Import every staged slot, in `SLOT_ORDER`. */
  runImport: (files: SlotUploads) => void;
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
    mutationFn: async (files: SlotUploads): Promise<SlotOutcomes> => {
      const outcomes: SlotOutcomes = {};

      for (const slot of SLOT_ORDER) {
        const upload = files[slot];
        if (upload === undefined) continue;

        try {
          if (slot === 'users') {
            const { rowsUpserted } = await importUserExport(upload.csv, upload.filename);
            outcomes[slot] = { status: 'users', rowsUpserted };
          } else {
            outcomes[slot] = {
              status: 'billing',
              result: await importBillingReport(upload.csv, upload.filename),
            };
          }
        } catch (error) {
          outcomes[slot] = { status: 'error', message: (error as Error).message };
        }
      }

      return outcomes;
    },
    onSuccess: (outcomes) => {
      // Every run is logged, failures included, so the history always moves.
      void queryClient.invalidateQueries({ queryKey: ['imports'] });

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

/**
 * The persistent import history — the Imports page's log. Server-capped and
 * ordered newest first; `useReportImports` invalidates it after every run.
 */
export function useImportLogs() {
  return useQuery<ImportLogEntry[]>({ queryKey: ['imports'], queryFn: fetchImportLogs });
}

/**
 * The last sync of a given source, whatever its status — drives every
 * "synced 2h ago" note. Covers scheduled runs too: the scheduler and the
 * on-demand syncs share one job table.
 */
export function useLatestJob(kind: RefreshKind) {
  return useQuery<RefreshJob | null>({
    queryKey: ['refresh', 'latest', kind],
    queryFn: () => fetchLatestRefreshJob(kind),
  });
}

/**
 * What each source needs to start a sync, and which cached queries its data
 * lands in. Adding a fourth source is a row here, not a fourth copy of the
 * polling hook below.
 */
interface SyncSource {
  start: () => Promise<RefreshJob>;
  invalidates: readonly string[];
}

// `satisfies` rather than an annotation: it still fails the build when a new
// `RefreshKind` has no row, while keeping the lookup below free of `undefined`.
const SYNC_SOURCES = {
  copilot: { start: startRefresh, invalidates: ['seats', 'spend', 'models', 'usage'] },
  // Identity is joined into the spend payload alone.
  jira: { start: startJiraSync, invalidates: ['spend'] },
  // Writes `billing_daily` and `model_spend_daily`, both served by spend.
  billing: { start: startBillingSync, invalidates: ['spend'] },
  // Writes `github_users` — the identity join behind both the seat roster's
  // display names and the spend payload's department and manager columns.
  members: { start: startMembersSync, invalidates: ['seats', 'spend'] },
} satisfies Record<RefreshKind, SyncSource>;

export interface UseSyncJob {
  /** Kick off a sync; safe to call twice — the API returns the in-flight job. */
  sync: () => void;
  isRunning: boolean;
  /** A failed job's error, or the start call's own (e.g. a 503 for unset env). */
  error: string | null;
}

/**
 * One source's on-demand sync. The POST returns a job rather than the data, so
 * the job is polled until it settles and only then are the queries it feeds
 * invalidated — the dashboard swaps to fresh numbers in one step, not torn.
 */
export function useSyncJob(kind: RefreshKind): UseSyncJob {
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const source = SYNC_SOURCES[kind];

  const start = useMutation({
    mutationFn: source.start,
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
      for (const key of source.invalidates) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    }
    void queryClient.invalidateQueries({ queryKey: ['refresh', 'latest', kind] });
  }, [job, kind, source, queryClient]);

  return {
    sync: () => start.mutate(undefined),
    isRunning: jobId !== null || start.isPending,
    // A 503 from the start call never produces a job, so surface it directly.
    error: job?.status === 'failed' ? job.error : (start.error?.message ?? null),
  };
}
