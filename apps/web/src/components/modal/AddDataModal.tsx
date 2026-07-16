import { useEffect, useState } from 'react';
import type { RefreshJob } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import type { UseImport } from '../../hooks/useCopilotData.js';
import type { ModalTab } from '../../state/dashboardState.js';
import { ConnectedSourcesTab } from './ConnectedSourcesTab.js';
import { ManualEntryTab } from './ManualEntryTab.js';
import type { ManualRow } from './ManualEntryTab.js';
import { UploadCsvTab } from './UploadCsvTab.js';
import styles from './AddDataModal.module.css';

/**
 * Add data.
 *
 * Connected sources → the on-demand GitHub sync. Upload CSV and Manual entry
 * post to the import endpoint, which upserts seat rows by login.
 */

const TABS: Array<{ id: ModalTab; label: string }> = [
  { id: 'sources', label: 'Connected sources' },
  { id: 'csv', label: 'Upload CSV' },
  { id: 'manual', label: 'Manual entry' },
];

const EMPTY_MANUAL_ROW: ManualRow = {
  user_login: '',
  plan: 'Business',
  ai_credits_used: '',
  last_activity_at: '',
};

interface AddDataModalProps {
  tab: ModalTab;
  latestJob: RefreshJob | null;
  isRefreshing: boolean;
  refreshError: string | null;
  importState: UseImport;
  onTabChange: (tab: ModalTab) => void;
  onClose: () => void;
  onRefresh: () => void;
  onImport: (content: string) => void;
}

export function AddDataModal({
  tab,
  latestJob,
  isRefreshing,
  refreshError,
  importState,
  onTabChange,
  onClose,
  onRefresh,
  onImport,
}: AddDataModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [manualRow, setManualRow] = useState<ManualRow>(EMPTY_MANUAL_ROW);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const manualValid = manualRow.user_login.trim() !== '';
  const canImport =
    tab === 'sources' ? !isRefreshing : tab === 'csv' ? file !== null : manualValid;

  const handleImport = async (): Promise<void> => {
    if (tab === 'sources') {
      onRefresh();
      return;
    }
    if (tab === 'csv') {
      if (!file) return;
      onImport(await file.text());
      return;
    }
    // Manual: post a one-row JSON array, dropping empty optional fields.
    const row: Record<string, string> = { user_login: manualRow.user_login.trim(), plan: manualRow.plan };
    if (manualRow.ai_credits_used.trim() !== '') row.ai_credits_used = manualRow.ai_credits_used.trim();
    if (manualRow.last_activity_at.trim() !== '') row.last_activity_at = manualRow.last_activity_at.trim();
    onImport(JSON.stringify([row]));
  };

  const primaryLabel = tab === 'sources' ? (isRefreshing ? 'Syncing…' : 'Import') : 'Import';
  const result = importState.result;

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
              onClick={() => {
                importState.reset();
                onTabChange(item.id);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className={styles.body}>
          {tab === 'sources' && (
            <ConnectedSourcesTab latestJob={latestJob} isRefreshing={isRefreshing} />
          )}
          {tab === 'csv' && <UploadCsvTab file={file} onFileChange={setFile} />}
          {tab === 'manual' && <ManualEntryTab row={manualRow} onChange={setManualRow} />}
        </div>

        <div className={styles.footer}>
          {refreshError && tab === 'sources' && (
            <div className={cx(styles.footerNote, styles.error)}>Sync failed: {refreshError}</div>
          )}
          {importState.error && tab !== 'sources' && (
            <div className={cx(styles.footerNote, styles.error)}>Import failed: {importState.error}</div>
          )}
          {result && tab !== 'sources' && (
            <div className={styles.footerNote}>
              {result.imported} added · {result.updated} updated
              {result.skipped > 0 && ` · ${result.skipped} skipped`}
              {result.errors.length > 0 && ` — ${result.errors[0]}`}
            </div>
          )}

          <button type="button" className={cx(styles.button, styles.secondary)} onClick={onClose}>
            {result ? 'Done' : 'Cancel'}
          </button>
          <button
            type="button"
            className={cx(styles.button, styles.primary)}
            onClick={handleImport}
            disabled={!canImport || importState.isImporting}
          >
            {importState.isImporting ? 'Importing…' : primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
