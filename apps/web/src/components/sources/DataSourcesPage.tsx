import type { ReactNode } from 'react';
import type { RefreshJob } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { relativeTime } from '../../lib/format.js';
import { useLatestJob } from '../../hooks/useCopilotData.js';
import type { UseSyncJob } from '../../hooks/useCopilotData.js';
import { useTelemetryFreshness } from '../../hooks/useTelemetry.js';
import styles from './DataSourcesPage.module.css';

/**
 * Every system this console reads from, grouped by provider.
 *
 * Three mechanisms share one row shape. Synced sources carry a job kind and a
 * Sync button — the two Copilot endpoints share a single `copilot` job, so
 * they share one button and one status. Pushed sources (OTLP telemetry) have
 * no sync affordance at all; their freshness is the newest datapoint. The
 * placeholder row is inert until the source is wired.
 */

interface Source {
  name: string;
  fields: string;
}

/** One refresh fills both — hence one status and one button for the pair. */
const COPILOT_SOURCES: Source[] = [
  { name: 'Copilot usage metrics API', fields: 'enterprise · users-28-day · ai_credits_used' },
  { name: 'Copilot user management API', fields: 'seats · last_activity_at · plan_type' },
];

type SyncState = 'syncing' | 'connected' | 'failed' | 'idle';

function syncState(job: RefreshJob | null, isRefreshing: boolean): SyncState {
  if (isRefreshing || job?.status === 'running' || job?.status === 'pending') return 'syncing';
  if (job?.status === 'failed') return 'failed';
  if (job?.status === 'succeeded' && job.finishedAt) return 'connected';
  return 'idle';
}

function statusText(state: SyncState, job: RefreshJob | null): string {
  switch (state) {
    case 'syncing':
      return 'Syncing…';
    case 'failed':
      return 'Last sync failed';
    case 'connected':
      return `Connected · ${relativeTime(job?.finishedAt ?? '')}`;
    case 'idle':
      return 'Not yet synced';
  }
}

function dotClassFor(state: SyncState): string {
  return cx(
    styles.dot,
    state === 'syncing' && styles.dotRunning,
    state === 'connected' && styles.dotConnected,
    state === 'failed' && styles.dotFailed,
    state === 'idle' && styles.dotIdle,
  );
}

/**
 * Why the source is unhealthy. The sync hooks only know about a job this
 * browser session started, so the persisted job's own reason is the fallback —
 * without it the 07:00 billing run failing overnight reads "Last sync failed"
 * with no explanation. `RefreshJob.error` is null unless the job failed, so a
 * later success clears it on its own.
 */
function errorFor(live: string | null, job: RefreshJob | null): string | null {
  return live ?? job?.error ?? null;
}

function statusClassFor(state: SyncState): string {
  return cx(
    styles.status,
    state === 'failed' && styles.statusFailed,
    (state === 'idle' || state === 'syncing') && styles.statusIdle,
  );
}

function ProviderGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className={styles.group}>
      <div className={styles.groupLabel}>{label}</div>
      <div className={styles.rows}>{children}</div>
    </section>
  );
}

interface SourceRowProps {
  name: string;
  fields: string;
  state: SyncState;
  /** Omitted by a source that has never had a state worth reporting. */
  status?: string | undefined;
  /** How the source keeps itself current, when that isn't the Sync button. */
  note?: string | undefined;
  /** A failed job's error, or the 503 an unconfigured integration answers with. */
  error?: string | null;
  /** The Sync/Connect control; pushed sources have none. */
  action?: ReactNode;
  /** Dashed border and muted name — a source that isn't wired yet. */
  placeholder?: boolean;
}

function SourceRow({
  name,
  fields,
  state,
  status,
  note,
  error = null,
  action,
  placeholder = false,
}: SourceRowProps) {
  return (
    <div className={cx(styles.source, placeholder && styles.sourcePlaceholder)}>
      <div className={dotClassFor(state)} />
      <div className={styles.sourceBody}>
        <div className={cx(styles.sourceName, placeholder && styles.sourceNameMuted)}>{name}</div>
        <div className={styles.sourceFields}>{fields}</div>
        {note !== undefined && <div className={styles.note}>{note}</div>}
        {error !== null && <div className={styles.error}>{error}</div>}
      </div>
      {status !== undefined && <div className={statusClassFor(state)}>{status}</div>}
      {action}
    </div>
  );
}

interface DataSourcesPageProps {
  /** The sync jobs, owned by `App` so they outlive a navigation away. */
  copilot: UseSyncJob;
  billing: UseSyncJob;
  jira: UseSyncJob;
  members: UseSyncJob;
}

export function DataSourcesPage({ copilot, billing, jira, members }: DataSourcesPageProps) {
  const { sync: syncCopilot, isRunning: isRefreshing, error: refreshError } = copilot;
  const { sync: syncBilling, isRunning: isBillingSyncing, error: billingError } = billing;
  const { sync: syncJira, isRunning: isJiraSyncing, error: jiraError } = jira;
  const { sync: syncMembers, isRunning: isMembersSyncing, error: membersError } = members;

  const latestJobQuery = useLatestJob('copilot');
  const billingJobQuery = useLatestJob('billing');
  const jiraJobQuery = useLatestJob('jira');
  const membersJobQuery = useLatestJob('members');
  const freshnessQuery = useTelemetryFreshness();

  const latestJob = latestJobQuery.data ?? null;
  const billingJob = billingJobQuery.data ?? null;
  const jiraJob = jiraJobQuery.data ?? null;
  const membersJob = membersJobQuery.data ?? null;

  const copilotState = syncState(latestJob, isRefreshing);
  const billingState = syncState(billingJob, isBillingSyncing);
  const jiraState = syncState(jiraJob, isJiraSyncing);
  const membersState = syncState(membersJob, isMembersSyncing);

  // Telemetry is pushed, so "connected" means a datapoint has arrived — there
  // is no job whose success or failure could be reported instead.
  const latestAt = freshnessQuery.data?.latestAt ?? null;
  const telemetryState: SyncState = latestAt === null ? 'idle' : 'connected';

  const copilotError = errorFor(refreshError, latestJob);

  return (
    <>
      <div className={styles.header}>
        <div className={styles.title}>Data sources</div>
        <div className={styles.sub}>every system this console reads from</div>
      </div>

      <ProviderGroup label="GITHUB COPILOT">
        <div className={styles.shared}>
          {COPILOT_SOURCES.map((source) => (
            <div key={source.name} className={styles.sharedRow}>
              <div className={dotClassFor(copilotState)} />
              <div className={styles.sourceBody}>
                <div className={styles.sourceName}>{source.name}</div>
                <div className={styles.sourceFields}>{source.fields}</div>
              </div>
            </div>
          ))}

          <div className={styles.sharedFooter}>
            <div className={styles.note}>One sync refreshes both endpoints.</div>
            {copilotError !== null && <div className={styles.error}>{copilotError}</div>}
            <div className={statusClassFor(copilotState)}>{statusText(copilotState, latestJob)}</div>
            <button
              type="button"
              className={styles.connect}
              aria-label="Sync GitHub Copilot APIs"
              onClick={() => syncCopilot()}
              disabled={isRefreshing}
            >
              {isRefreshing ? 'Syncing…' : 'Sync'}
            </button>
          </div>
        </div>

        <SourceRow
          name="GitHub billing API"
          fields="ai_credit usage · by model, SKU, cost center"
          note="Runs on its own every day at 07:00; Sync pulls it now."
          state={billingState}
          status={statusText(billingState, billingJob)}
          error={errorFor(billingError, billingJob)}
          action={
            <button
              type="button"
              className={styles.connect}
              aria-label="Sync GitHub billing API"
              onClick={() => syncBilling()}
              disabled={isBillingSyncing}
            >
              {isBillingSyncing ? 'Syncing…' : 'Sync'}
            </button>
          }
        />

        <SourceRow
          name="GitHub org members"
          fields="login · saml_name_id"
          note="Runs on its own every day at 07:00; Sync pulls it now."
          state={membersState}
          status={statusText(membersState, membersJob)}
          error={errorFor(membersError, membersJob)}
          action={
            <button
              type="button"
              className={styles.connect}
              aria-label="Sync GitHub org members"
              onClick={() => syncMembers()}
              disabled={isMembersSyncing}
            >
              {isMembersSyncing ? 'Syncing…' : 'Sync'}
            </button>
          }
        />
      </ProviderGroup>

      <ProviderGroup label="JIRA">
        <SourceRow
          name="JIRA Insight identity"
          fields="saml_name_id · name · department · managers"
          state={jiraState}
          status={statusText(jiraState, jiraJob)}
          error={errorFor(jiraError, jiraJob)}
          action={
            <button
              type="button"
              className={styles.connect}
              aria-label="Sync JIRA Insight identity"
              onClick={() => syncJira()}
              disabled={isJiraSyncing}
            >
              {isJiraSyncing ? 'Syncing…' : 'Sync'}
            </button>
          }
        />
      </ProviderGroup>

      <ProviderGroup label="CLAUDE CODE">
        <SourceRow
          name="OTLP telemetry"
          fields="cost · tokens · sessions · lines · commits · PRs"
          note="Pushed by the CLI — nothing to sync from here."
          state={telemetryState}
          status={
            latestAt === null ? 'Not yet received' : `Connected · ${relativeTime(latestAt)}`
          }
        />
      </ProviderGroup>

      <ProviderGroup label="AZURE COST MANAGEMENT">
        <SourceRow
          name="Azure Cost Management"
          fields="for the Cloud infrastructure page"
          state="idle"
          placeholder
          action={
            <button type="button" className={styles.connect} disabled>
              Connect
            </button>
          }
        />
      </ProviderGroup>
    </>
  );
}
