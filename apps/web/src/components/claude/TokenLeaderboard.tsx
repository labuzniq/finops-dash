import { cx } from '../../lib/cx.js';
import { compactCount } from '../../lib/format.js';
import type { TokenLeaderboardRow } from '../../lib/metrics/telemetry.js';
import { Card } from '../Card.js';
import styles from './TokenLeaderboard.module.css';

/**
 * Top users by token volume. Bars are scaled to the heaviest user so ratios
 * read at a glance; segments reuse the daily chart's ramp and order, and each
 * segment carries its own value tooltip.
 */

const SEGMENTS = ['input', 'output', 'cache'] as const;

const LEGEND: readonly { kind: (typeof SEGMENTS)[number]; label: string }[] = [
  { kind: 'input', label: 'Input' },
  { kind: 'output', label: 'Output' },
  { kind: 'cache', label: 'Cache' },
];

export function TokenLeaderboard({ rows }: { rows: readonly TokenLeaderboardRow[] }) {
  const max = rows[0]?.total ?? 0;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div className={styles.title}>Top users by tokens</div>
        <div className={styles.sub}>heaviest token consumers in range</div>
      </div>
      <div className={styles.legend}>
        {LEGEND.map(({ kind, label }) => (
          <span key={kind} className={styles.legendItem}>
            <span className={cx(styles.swatch, styles[kind])} />
            {label}
          </span>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className={styles.empty}>No token usage matches these filters.</div>
      ) : (
        <div className={styles.rows}>
          {rows.map((row) => (
            <div key={row.user} className={styles.row}>
              <div className={styles.user}>{row.user}</div>
              <div className={styles.bar}>
                {SEGMENTS.map((kind) =>
                  row[kind] > 0 && max > 0 ? (
                    <div
                      key={kind}
                      className={cx(styles.segment, styles[kind])}
                      style={{ width: `${(row[kind] / max) * 100}%` }}
                      title={`${kind}: ${compactCount(row[kind])}`}
                    />
                  ) : null,
                )}
              </div>
              <div className={styles.total}>{compactCount(row.total)}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
