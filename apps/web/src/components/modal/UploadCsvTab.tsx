import { useId } from 'react';
import { cx } from '../../lib/cx.js';
import styles from './tabs.module.css';

/**
 * CSV / JSON / NDJSON import. Selecting a file stages it; the modal's Import
 * button posts its text to /api/import, which upserts seat rows by login.
 * See docs/import-format.md for the accepted columns.
 */

const EXPECTED_COLUMNS = 'user_login · plan · ai_credits_used · last_activity_at · editor · language';

const TEMPLATE_CSV =
  'user_login,name,plan,ai_credits_used,acceptance_rate,last_activity_at,editor,language,top_model\n' +
  'akovacs,Ana Kovacs,Enterprise,420,38,2026-07-14,VS Code,typescript,claude-sonnet-5\n';

const TEMPLATE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE_CSV)}`;

interface UploadCsvTabProps {
  file: File | null;
  onFileChange: (file: File | null) => void;
}

export function UploadCsvTab({ file, onFileChange }: UploadCsvTabProps) {
  const inputId = useId();

  return (
    <div>
      <label htmlFor={inputId} className={styles.dropzone}>
        <div className={styles.badge}>↑</div>
        <div className={styles.dropTitle}>Drop a CSV or NDJSON export here</div>
        <div className={styles.dropHint}>or click to browse — up to 25 MB</div>
      </label>

      <input
        id={inputId}
        type="file"
        accept=".csv,.ndjson,.json"
        className={styles.hiddenInput}
        onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
      />

      {file && (
        <div className={styles.chip}>
          <div className={cx(styles.dot, styles.dotConnected)} />
          <div className={styles.chipName}>{file.name}</div>
          <div className={styles.status}>Ready to import</div>
        </div>
      )}

      <div className={styles.columnsNote}>
        Expected columns: <span className={styles.mono}>{EXPECTED_COLUMNS}</span> — only{' '}
        <span className={styles.mono}>user_login</span> is required.{' '}
        <a href={TEMPLATE_HREF} download="copilot-seats-template.csv" className={styles.link}>
          Download template
        </a>
      </div>
    </div>
  );
}
