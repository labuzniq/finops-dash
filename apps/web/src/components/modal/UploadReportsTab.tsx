import { useId, useState } from 'react';
import { cx } from '../../lib/cx.js';
import { count } from '../../lib/format.js';
import type { ImportSlot, SlotOutcome } from '../../hooks/useCopilotData.js';
import styles from './tabs.module.css';

/**
 * The three billing-report uploads.
 *
 * Slots 1 and 2 are the GitHub AI usage reports — the same endpoint, the server
 * tells them apart by header. Slot 3 is the org user export that maps GitHub
 * logins to SAML ids; without it every user renders "unmapped".
 *
 * Because both reports post to one endpoint, dropping the wrong file in a slot
 * would silently import it as the other kind. So the header is checked here,
 * before upload, and a mismatch is reported on the slot rather than sent.
 */

export interface StagedFile {
  file: File;
  /** The file text, present only when it matched its slot. */
  csv: string | null;
  /** Why the file was rejected client-side; null when it is ready to upload. */
  error: string | null;
}

export type StagedFiles = Partial<Record<ImportSlot, StagedFile>>;

interface SlotSpec {
  id: ImportSlot;
  label: string;
  hint: string;
}

/** The primary pair — equal weight, side by side. */
const REPORT_SLOTS: SlotSpec[] = [
  {
    id: 'model',
    label: 'Model usage',
    hint: 'AIUsageReport_1 — per user, per model AI credits',
  },
  {
    id: 'cost',
    label: 'Cost report',
    hint: 'AIUsageReport_2 — per user, per day, per sku billing',
  },
];

const USER_SLOT: SlotSpec = {
  id: 'users',
  label: 'User export',
  hint: 'GitHub org export — login → saml_name_id',
};

// --- Client-side slot check --------------------------------------------------

/** A UTF-8 BOM ahead of the first header cell, as Excel-exported CSVs carry. */
const BOM = /^\uFEFF/;

/** Header cells of the first line, lowercased and unquoted. */
function headerColumns(csv: string): Set<string> {
  const firstLine = csv.replace(BOM, '').split(/\r?\n/, 1)[0] ?? '';
  return new Set(
    firstLine.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '').toLowerCase()),
  );
}

/** The same detection the server does: `model` ⇒ Report 1, `workflow_path` ⇒ Report 2. */
function detectReport(columns: Set<string>): ImportSlot | null {
  const hasModel = columns.has('model');
  const hasWorkflowPath = columns.has('workflow_path');
  if (hasModel === hasWorkflowPath) return null;
  return hasModel ? 'model' : 'cost';
}

const SLOT_NAME: Record<ImportSlot, string> = {
  model: 'Model usage',
  cost: 'Cost report',
  users: 'User export',
};

/** null when the file belongs in `slot`, otherwise the message to show on it. */
function slotMismatch(slot: ImportSlot, csv: string): string | null {
  const columns = headerColumns(csv);
  const detected = detectReport(columns);

  if (slot === 'users') {
    if (detected !== null) {
      return `This looks like the ${SLOT_NAME[detected].toLowerCase()} — drop it in the ${SLOT_NAME[detected]} slot`;
    }
    if (!columns.has('login') || !columns.has('saml_name_id')) {
      return 'Expected a GitHub user export with "login" and "saml_name_id" columns';
    }
    return null;
  }

  if (detected === slot) return null;
  if (detected !== null) {
    return `This looks like the ${SLOT_NAME[detected].toLowerCase()} — drop it in the ${SLOT_NAME[detected]} slot`;
  }
  return 'Not a usage report — expected a "model" column (model usage) or "workflow_path" (cost report)';
}

/** Read a dropped/browsed file and check it against the slot it landed in. */
export async function stageFile(slot: ImportSlot, file: File): Promise<StagedFile> {
  const csv = await file.text();
  const error = slotMismatch(slot, csv);
  return error === null ? { file, csv, error: null } : { file, csv: null, error };
}

// --- Rendering ---------------------------------------------------------------

function outcomeText(outcome: SlotOutcome): string {
  switch (outcome.status) {
    case 'billing': {
      const { rowsUpserted, dateRange, unknownLogins } = outcome.result;
      const parts = [`${count(rowsUpserted)} rows`, `${dateRange.from} → ${dateRange.to}`];
      if (unknownLogins.length > 0) parts.push(`${count(unknownLogins.length)} unknown logins`);
      return parts.join(' · ');
    }
    case 'users':
      return `${count(outcome.rowsUpserted)} rows`;
    case 'error':
      return outcome.message;
  }
}

interface ReportSlotProps {
  spec: SlotSpec;
  staged: StagedFile | undefined;
  outcome: SlotOutcome | undefined;
  secondary?: boolean;
  onStage: (slot: ImportSlot, file: File) => void;
}

function ReportSlot({ spec, staged, outcome, secondary = false, onStage }: ReportSlotProps) {
  const inputId = useId();
  const [isDragOver, setDragOver] = useState(false);

  const take = (file: File | undefined): void => {
    if (file) onStage(spec.id, file);
  };

  const failed = staged?.error ?? (outcome?.status === 'error' ? outcome.message : null);

  return (
    <div className={cx(styles.slot, secondary && styles.slotSecondary)}>
      <label
        htmlFor={inputId}
        className={cx(
          styles.dropzone,
          secondary && styles.dropzoneSecondary,
          isDragOver && styles.dropzoneActive,
          failed !== null && styles.dropzoneError,
        )}
        onDragOver={(event) => {
          // Without preventDefault the browser navigates to the dropped file.
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          take(event.dataTransfer.files[0]);
        }}
      >
        <div className={styles.dropTitle}>{spec.label}</div>
        <div className={styles.dropHint}>{spec.hint}</div>
        <div className={styles.dropHint}>Drop a CSV here or click to browse</div>
      </label>

      <input
        id={inputId}
        type="file"
        accept=".csv,text/csv"
        className={styles.hiddenInput}
        // Clearing on open lets the same file be picked again after a failed
        // import — otherwise an unchanged value fires no change event.
        onClick={(event) => {
          event.currentTarget.value = '';
        }}
        onChange={(event) => take(event.target.files?.[0])}
      />

      {staged && (
        <div className={styles.chip}>
          <div
            className={cx(
              styles.dot,
              failed !== null
                ? styles.dotFailed
                : outcome
                  ? styles.dotConnected
                  : styles.dotIdle,
            )}
          />
          <div className={styles.chipName}>{staged.file.name}</div>
        </div>
      )}

      {failed !== null && <div className={styles.slotError}>{failed}</div>}
      {failed === null && outcome && <div className={styles.slotResult}>{outcomeText(outcome)}</div>}
    </div>
  );
}

interface UploadReportsTabProps {
  staged: StagedFiles;
  outcomes: Partial<Record<ImportSlot, SlotOutcome>>;
  onStage: (slot: ImportSlot, file: File) => void;
}

export function UploadReportsTab({ staged, outcomes, onStage }: UploadReportsTabProps) {
  return (
    <div>
      <div className={styles.slotPair}>
        {REPORT_SLOTS.map((spec) => (
          <ReportSlot
            key={spec.id}
            spec={spec}
            staged={staged[spec.id]}
            outcome={outcomes[spec.id]}
            onStage={onStage}
          />
        ))}
      </div>

      <ReportSlot
        spec={USER_SLOT}
        staged={staged[USER_SLOT.id]}
        outcome={outcomes[USER_SLOT.id]}
        secondary
        onStage={onStage}
      />

      <div className={styles.columnsNote}>
        Without the user export, users show as <span className={styles.mono}>unmapped</span> — names,
        departments, and managers stay empty.
      </div>
    </div>
  );
}
