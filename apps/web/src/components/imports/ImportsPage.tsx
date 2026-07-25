import { useState } from 'react';
import type { ImportSlot } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { useImportLogs } from '../../hooks/useCopilotData.js';
import type { SlotUploads, UseReportImports } from '../../hooks/useCopilotData.js';
import { ImportHistory } from './ImportHistory.js';
import { UploadSlots, stageFile } from './UploadSlots.js';
import type { StagedFile, StagedFiles } from './UploadSlots.js';
import styles from './imports.module.css';

/**
 * CSV uploads and what came of them.
 *
 * Staging is page-local — a file sits in its slot until Import runs, and each
 * slot reports its own outcome, so a rejected cost report never discards a
 * user export that already landed. The run itself belongs to `App`: an upload
 * must finish, and invalidate what it changed, even if the user navigates away
 * mid-import. The history below is the server's log, so it survives either way.
 */

const EMPTY_LOGS = [] as const;

export function ImportsPage({ imports }: { imports: UseReportImports }) {
  const [staged, setStaged] = useState<StagedFiles>({});
  const logsQuery = useImportLogs();

  const handleStage = (slot: ImportSlot, file: File): void => {
    // Restaging clears the previous run's per-slot feedback, which no longer
    // describes what is in the slot.
    imports.reset();
    void stageFile(slot, file).then((result) =>
      setStaged((current) => ({ ...current, [slot]: result })),
    );
  };

  /** Only slots that passed the client-side header check are uploadable. */
  const ready: SlotUploads = {};
  for (const [slot, entry] of Object.entries(staged) as Array<[ImportSlot, StagedFile]>) {
    // The name travels with the text — it is what the import history shows.
    if (entry.csv !== null) ready[slot] = { csv: entry.csv, filename: entry.file.name };
  }

  const hasStaged = Object.keys(staged).length > 0;

  return (
    <>
      <div className={styles.header}>
        <div className={styles.title}>Imports</div>
        <div className={styles.sub}>GitHub AI usage reports · org user export</div>
      </div>

      <UploadSlots staged={staged} outcomes={imports.outcomes} onStage={handleStage} />

      <div className={styles.actions}>
        {hasStaged && (
          <button
            type="button"
            className={cx(styles.button, styles.secondary)}
            onClick={() => {
              imports.reset();
              setStaged({});
            }}
          >
            Clear
          </button>
        )}
        <button
          type="button"
          className={cx(styles.button, styles.primary)}
          onClick={() => imports.runImport(ready)}
          disabled={Object.keys(ready).length === 0 || imports.isImporting}
        >
          {imports.isImporting ? 'Importing…' : 'Import'}
        </button>
      </div>

      {logsQuery.error && (
        <div className={styles.loadError}>Could not load history: {logsQuery.error.message}</div>
      )}

      {/* Wait for the log before rendering it — its empty state asserts that
          nothing was ever imported, which an unresolved query cannot know. */}
      {!logsQuery.error && logsQuery.isPending && (
        <div className={styles.status}>Loading history…</div>
      )}

      {!logsQuery.error && !logsQuery.isPending && (
        <ImportHistory entries={logsQuery.data ?? EMPTY_LOGS} />
      )}
    </>
  );
}
