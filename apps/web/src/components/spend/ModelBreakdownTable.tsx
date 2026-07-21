import { count, usd } from '../../lib/format.js';
import type { ModelBreakdownRow } from '../../lib/metrics/spend.js';
import { Card } from '../Card.js';
import styles from './ModelBreakdownTable.module.css';

/**
 * AI credit spend by model — statistics from the per-model report (Report 1).
 * Licences are excluded by nature of that report, and none of these numbers
 * ever feed the money totals: Report 2 is the sole money authority.
 */

interface ModelBreakdownTableProps {
  rows: readonly ModelBreakdownRow[];
}

export function ModelBreakdownTable({ rows }: ModelBreakdownTableProps) {
  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div className={styles.title}>AI credit spend by model</div>
        <div className={styles.sub}>per-model report</div>
      </div>

      <div className={`${styles.columns} ${styles.headerStrip}`}>
        <div>MODEL</div>
        <div className={styles.right}>CREDITS</div>
        <div className={styles.right}>GROSS</div>
        <div>SHARE</div>
      </div>

      {rows.length === 0 ? (
        <div className={styles.empty}>No model spend in this range.</div>
      ) : (
        rows.map((row) => (
          <div key={row.model} className={`${styles.columns} ${styles.row}`}>
            <div className={styles.model}>{row.model}</div>
            <div className={styles.right}>{count(Math.round(row.credits))}</div>
            <div className={styles.right}>{usd(row.gross, 2)}</div>
            <div className={styles.shareCell}>
              <div className={styles.bar}>
                <div className={styles.barFill} style={{ width: `${row.share * 100}%` }} />
              </div>
              <span className={styles.shareLabel}>{Math.round(row.share * 100)}%</span>
            </div>
          </div>
        ))
      )}
    </Card>
  );
}
