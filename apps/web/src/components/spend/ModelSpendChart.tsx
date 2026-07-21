import { count, usd } from '../../lib/format.js';
import type { ModelBreakdownRow } from '../../lib/metrics/spend.js';
import { Card } from '../Card.js';
import styles from './ModelSpendChart.module.css';

/**
 * AI credit spend by model as ranked bars — statistics from the per-model
 * report (Report 1). None of these numbers feed the money totals: Report 2 is
 * the sole money authority.
 *
 * Bars scale to the largest model rather than to the total, so the leader always
 * fills the track and the differences between the smaller models stay legible.
 */

interface ModelSpendChartProps {
  rows: readonly ModelBreakdownRow[];
}

export function ModelSpendChart({ rows }: ModelSpendChartProps) {
  const max = rows.reduce((peak, row) => Math.max(peak, row.gross), 0);

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div className={styles.title}>Spend by model</div>
        <div className={styles.sub}>per-model report</div>
      </div>

      {rows.length === 0 ? (
        <div className={styles.empty}>No model spend in this range.</div>
      ) : (
        <div className={styles.rows}>
          {rows.map((row) => (
            <div key={row.model} className={styles.row}>
              <div className={styles.model} title={row.model}>
                {row.model}
              </div>

              <div className={styles.track}>
                <div
                  className={styles.fill}
                  style={{ width: max > 0 ? `${(row.gross / max) * 100}%` : '0%' }}
                />
              </div>

              <div className={styles.gross}>{usd(row.gross, 2)}</div>
              <div className={styles.credits}>{count(Math.round(row.credits))} cr</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
