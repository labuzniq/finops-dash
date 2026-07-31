import { GATEWAY_DIMENSION_LABELS } from '@dash/shared';
import type { GatewayDimension } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, EMPTY, usd } from '../../lib/format.js';
import type { ComparisonWindow, GatewayMoverRow } from '../../lib/metrics/gatewayCompare.js';
import { Card } from '../Card.js';
import styles from './GatewayMoversCard.module.css';

/**
 * What changed between this period and the one before it, for the dimension the
 * breakdown is currently showing.
 *
 * The breakdown card answers "where does the money go"; this one answers "where
 * did the money move", which is the question that produces an action. Risers
 * and fallers share one list and one scale — a $500 rise and a $500 fall are
 * the same size of event, and splitting them into two cards hides that the
 * gateway's total barely moved.
 *
 * Bars diverge from a centre line, scaled to the largest swing on show. Rising
 * cost is drawn in the negative hue and falling cost in the positive one: this
 * is a spend console, so the polarity is about the invoice, not about traffic.
 */

/** Enough rows to see both ends of the movement; past this it is a ledger. */
const MAX_ROWS = 8;

interface GatewayMoversCardProps {
  rows: readonly GatewayMoverRow[];
  dimension: GatewayDimension;
  /** The period being compared against — named in full so the delta is unambiguous. */
  window: ComparisonWindow;
}

/** Signed percentage, or the reason there isn't one. */
function changeLabel(row: GatewayMoverRow): string {
  if (row.spend.change === null) return row.spend.previous === 0 ? 'new' : EMPTY;
  const pct = row.spend.change * 100;
  // Past a 10× move the percentage stops informing and starts shouting.
  if (pct >= 1000) return '>+999%';
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

export function GatewayMoversCard({ rows, dimension, window }: GatewayMoversCardProps) {
  const shown = rows.slice(0, MAX_ROWS);
  const max = shown.reduce((peak, row) => Math.max(peak, Math.abs(row.spend.absolute)), 0);
  const label = GATEWAY_DIMENSION_LABELS[dimension].toLowerCase();

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div className={styles.title}>Biggest movers by {label}</div>
        <div className={styles.sub}>
          vs {window.from} … {window.to} · {window.days}d
        </div>
      </div>

      <div className={cx(styles.row, styles.headerStrip)}>
        <div>{GATEWAY_DIMENSION_LABELS[dimension].toUpperCase()}</div>
        <div className={styles.centre}>SPEND CHANGE</div>
        <div className={styles.right}>PREVIOUS</div>
        <div className={styles.right}>CURRENT</div>
        <div className={styles.right}>Δ</div>
        <div className={styles.right}>REQUESTS Δ</div>
      </div>

      {shown.length === 0 ? (
        <div className={styles.empty}>
          No {label} moved between the two periods — spend held flat key for key.
        </div>
      ) : (
        shown.map((row) => {
          const up = row.spend.absolute > 0;
          const width = max > 0 ? (Math.abs(row.spend.absolute) / max) * 50 : 0;
          return (
            <div key={row.key} className={styles.row}>
              <div className={styles.name} title={row.key}>
                <span className={styles.key}>{row.key}</span>
                {row.label !== null && row.label !== row.key && (
                  <span className={styles.label}>{row.label}</span>
                )}
              </div>

              <div className={styles.track}>
                <div className={styles.axis} />
                <div
                  className={cx(styles.fill, up ? styles.up : styles.down)}
                  style={{ left: `${up ? 50 : 50 - width}%`, width: `${width}%` }}
                />
              </div>

              <div className={cx(styles.right, styles.muted)}>{usd(row.spend.previous, 2)}</div>
              <div className={styles.right}>{usd(row.spend.current, 2)}</div>
              <div className={cx(styles.right, up ? styles.upText : styles.downText)}>
                {up ? '+' : '−'}
                {usd(Math.abs(row.spend.absolute), 2)}
                <span className={styles.pct}>{changeLabel(row)}</span>
              </div>
              <div className={cx(styles.right, styles.muted)}>
                {row.requests.absolute === 0
                  ? EMPTY
                  : `${row.requests.absolute > 0 ? '+' : '−'}${compactCount(Math.abs(row.requests.absolute))}`}
              </div>
            </div>
          );
        })
      )}
    </Card>
  );
}
