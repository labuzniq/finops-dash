import type { RefreshJob } from '@dash/shared';
import { relativeTime } from '../../lib/format.js';
import { cx } from '../../lib/cx.js';
import styles from './tabs.module.css';

/**
 * The wired sources. Status is live: one refresh syncs all three GitHub
 * endpoints, so they share the last job's state.
 *
 * JIRA is its own job kind — identity (names, departments, managers) is synced
 * separately from Copilot usage, and either may run without the other.
 */

interface Source {
  name: string;
  fields: string;
}

const GITHUB_SOURCES: Source[] = [
  { name: 'Copilot usage metrics API', fields: 'enterprise · users-28-day · ai_credits_used' },
  { name: 'Copilot user management API', fields: 'seats · last_activity_at · plan_type' },
  { name: 'GitHub billing API', fields: 'ai_credit usage · by model, SKU, cost center' },
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
    (state === 'idle' || state === 'failed') && styles.dotIdle,
  );
}

function statusClassFor(state: SyncState): string {
  return cx(
    styles.status,
    state === 'failed' && styles.statusFailed,
    (state === 'idle' || state === 'syncing') && styles.statusIdle,
  );
}

interface ConnectedSourcesTabProps {
  latestJob: RefreshJob | null;
  isRefreshing: boolean;
  jiraJob: RefreshJob | null;
  isJiraSyncing: boolean;
  /** A failed JIRA job, or the 503 the API sends when `JIRA_*` env is unset. */
  jiraError: string | null;
  onJiraSync: () => void;
}

export function ConnectedSourcesTab({
  latestJob,
  isRefreshing,
  jiraJob,
  isJiraSyncing,
  jiraError,
  onJiraSync,
}: ConnectedSourcesTabProps) {
  const state = syncState(latestJob, isRefreshing);
  const jiraState = syncState(jiraJob, isJiraSyncing);

  return (
    <div className={styles.sourceList}>
      {GITHUB_SOURCES.map((source) => (
        <div key={source.name} className={styles.source}>
          <div className={dotClassFor(state)} />
          <div className={styles.sourceBody}>
            <div className={styles.sourceName}>{source.name}</div>
            <div className={styles.sourceFields}>{source.fields}</div>
          </div>
          <div className={statusClassFor(state)}>{statusText(state, latestJob)}</div>
        </div>
      ))}

      <div className={styles.source}>
        <div className={dotClassFor(jiraState)} />
        <div className={styles.sourceBody}>
          <div className={styles.sourceName}>JIRA Insight identity</div>
          <div className={styles.sourceFields}>saml_name_id · name · department · managers</div>
          {jiraError !== null && <div className={styles.slotError}>{jiraError}</div>}
        </div>
        <div className={statusClassFor(jiraState)}>{statusText(jiraState, jiraJob)}</div>
        <button type="button" className={styles.connect} onClick={onJiraSync} disabled={isJiraSyncing}>
          {isJiraSyncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>

      <div className={cx(styles.source, styles.sourceUnconnected)}>
        <div className={cx(styles.dot, styles.dotIdle)} />
        <div className={styles.sourceBody}>
          <div className={cx(styles.sourceName, styles.sourceNameMuted)}>Azure Cost Management</div>
          <div className={styles.sourceFields}>for the Cloud infrastructure page</div>
        </div>
        <button type="button" className={styles.connect} disabled>
          Connect
        </button>
      </div>
    </div>
  );
}
