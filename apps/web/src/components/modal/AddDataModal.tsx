import { useEffect, useState } from 'react';
import type { RefreshJob } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import type { ImportSlot, UseReportImports } from '../../hooks/useCopilotData.js';
import type { ModalTab } from '../../state/dashboardState.js';
import { ConnectedSourcesTab } from './ConnectedSourcesTab.js';
import { UploadReportsTab, stageFile } from './UploadReportsTab.js';
import type { StagedFile, StagedFiles } from './UploadReportsTab.js';
import styles from './AddDataModal.module.css';

/**
 * Add data.
 *
 * Upload reports → the two GitHub AI usage report CSVs plus the org user
 * export. Connected sources → the on-demand GitHub sync and the JIRA identity
 * sync, each its own job kind.
 */

const TABS: Array<{ id: ModalTab; label: string }> = [
  { id: 'upload', label: 'Upload reports' },
  { id: 'sources', label: 'Connected sources' },
];

interface AddDataModalProps {
  tab: ModalTab;
  latestJob: RefreshJob | null;
  isRefreshing: boolean;
  refreshError: string | null;
  jiraJob: RefreshJob | null;
  isJiraSyncing: boolean;
  jiraError: string | null;
  imports: UseReportImports;
  onTabChange: (tab: ModalTab) => void;
  onClose: () => void;
  onRefresh: () => void;
  onJiraSync: () => void;
}

export function AddDataModal({
  tab,
  latestJob,
  isRefreshing,
  refreshError,
  jiraJob,
  isJiraSyncing,
  jiraError,
  imports,
  onTabChange,
  onClose,
  onRefresh,
  onJiraSync,
}: AddDataModalProps) {
  const [staged, setStaged] = useState<StagedFiles>({});

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleStage = (slot: ImportSlot, file: File): void => {
    // Restaging clears the previous run's per-slot feedback, which no longer
    // describes what is in the slot.
    imports.reset();
    void stageFile(slot, file).then((result) =>
      setStaged((current) => ({ ...current, [slot]: result })),
    );
  };

  /** Only slots that passed the client-side header check are uploadable. */
  const ready: Partial<Record<ImportSlot, string>> = {};
  for (const [slot, entry] of Object.entries(staged) as Array<[ImportSlot, StagedFile]>) {
    if (entry.csv !== null) ready[slot] = entry.csv;
  }

  const canSubmit =
    tab === 'sources' ? !isRefreshing : Object.keys(ready).length > 0;

  const handlePrimary = (): void => {
    if (tab === 'sources') {
      onRefresh();
      return;
    }
    imports.runImport(ready);
  };

  const hasOutcomes = Object.keys(imports.outcomes).length > 0;

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <div
        className={styles.dialog}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Add data"
      >
        <div className={styles.header}>
          <div className={styles.title}>Add data</div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className={styles.tabs}>
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cx(styles.tab, item.id === tab && styles.tabActive)}
              aria-selected={item.id === tab}
              onClick={() => onTabChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className={styles.body}>
          {tab === 'upload' && (
            <UploadReportsTab staged={staged} outcomes={imports.outcomes} onStage={handleStage} />
          )}
          {tab === 'sources' && (
            <ConnectedSourcesTab
              latestJob={latestJob}
              isRefreshing={isRefreshing}
              jiraJob={jiraJob}
              isJiraSyncing={isJiraSyncing}
              jiraError={jiraError}
              onJiraSync={onJiraSync}
            />
          )}
        </div>

        <div className={styles.footer}>
          {refreshError && tab === 'sources' && (
            <div className={cx(styles.footerNote, styles.error)}>Sync failed: {refreshError}</div>
          )}

          <button type="button" className={cx(styles.button, styles.secondary)} onClick={onClose}>
            {hasOutcomes ? 'Done' : 'Cancel'}
          </button>
          <button
            type="button"
            className={cx(styles.button, styles.primary)}
            onClick={handlePrimary}
            disabled={!canSubmit || imports.isImporting}
          >
            {imports.isImporting ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
