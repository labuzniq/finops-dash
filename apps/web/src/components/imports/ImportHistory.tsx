import type { ImportLogEntry } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { count, relativeTime } from '../../lib/format.js';
import { Card } from '../Card.js';
import { SLOT_NAME } from './UploadSlots.js';
import styles from './imports.module.css';

/**
 * Every import run the server has recorded, newest first — failures included,
 * which is the point: a rejected CSV is the thing you come back to look at.
 * The log is append-only, so this list only ever grows downward.
 */

function LogRow({ entry }: { entry: ImportLogEntry }) {
  const failed = entry.status === 'failed';

  return (
    <div className={styles.logEntry}>
      <div className={cx(styles.logColumns, styles.logRow)}>
        <div className={styles.logSlot}>{SLOT_NAME[entry.slot]}</div>
        <div className={styles.logFile}>{entry.filename}</div>
        <div className={styles.right}>{count(entry.rowCount)}</div>
        <div className={styles.logStatus}>
          <div className={cx(styles.dot, failed ? styles.dotFailed : styles.dotConnected)} />
          {failed ? 'Failed' : 'Imported'}
        </div>
        <div className={cx(styles.right, styles.logWhen)}>{relativeTime(entry.createdAt)}</div>
      </div>
      {failed && entry.error !== null && <div className={styles.logError}>{entry.error}</div>}
    </div>
  );
}

export function ImportHistory({ entries }: { entries: readonly ImportLogEntry[] }) {
  return (
    <Card padded={false} className={styles.logCard}>
      <div className={styles.logHeader}>
        <div className={styles.logTitle}>Import history</div>
        <div className={styles.logSub}>most recent first</div>
      </div>

      <div className={cx(styles.logColumns, styles.logHeaderStrip)}>
        <div>SOURCE</div>
        <div>FILE</div>
        <div className={styles.right}>ROWS</div>
        <div>STATUS</div>
        <div className={styles.right}>WHEN</div>
      </div>

      {entries.length === 0 ? (
        <div className={styles.logEmpty}>Nothing imported yet.</div>
      ) : (
        entries.map((entry) => <LogRow key={entry.id} entry={entry} />)
      )}
    </Card>
  );
}
