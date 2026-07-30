import { GATEWAY_DIMENSION_LABELS } from '@dash/shared';
import type { GatewayDimension } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, EMPTY, percent, usd } from '../../lib/format.js';
import type { GatewayBreakdownRow } from '../../lib/metrics/gateway.js';
import { Card } from '../Card.js';
import styles from './GatewayBreakdownCard.module.css';

/**
 * The gateway's spend, sliced one dimension at a time.
 *
 * A switcher rather than seven stacked cards, because the dimensions are seven
 * views of the *same* dollar — showing them side by side invites reading them
 * as parts of a whole and adding them up. One at a time, with the share column
 * always measured against the gateway-wide total, keeps that honest.
 *
 * Bars scale to the leading row rather than to the total, so the differences
 * between the smaller keys stay legible once one model dominates — which, on a
 * corporate gateway, one always does.
 */

/** Length of the `--chart-N` ramp in tokens.css; rows past it cycle. */
const CHART_HUES = 8;

/** Enough to see the long tail; past this the table is scrolling, not informing. */
const MAX_ROWS = 12;

interface GatewayBreakdownCardProps {
  rows: readonly GatewayBreakdownRow[];
  dimension: GatewayDimension;
  /** Only the dimensions the proxy actually answered for this range. */
  available: readonly GatewayDimension[];
  onDimension: (dimension: GatewayDimension) => void;
}

export function GatewayBreakdownCard({
  rows,
  dimension,
  available,
  onDimension,
}: GatewayBreakdownCardProps) {
  const shown = rows.slice(0, MAX_ROWS);
  const max = shown.reduce((peak, row) => Math.max(peak, row.metrics.spend), 0);
  const hidden = rows.length - shown.length;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Spend by {GATEWAY_DIMENSION_LABELS[dimension].toLowerCase()}</div>
          <div className={styles.sub}>share is of gateway spend — dimensions overlap, never sum across them</div>
        </div>

        <div className={styles.segmented} role="group" aria-label="Breakdown dimension">
          {available.map((option) => {
            const active = option === dimension;
            return (
              <button
                key={option}
                type="button"
                className={cx(styles.segment, active && styles.segmentActive)}
                aria-pressed={active}
                onClick={() => onDimension(option)}
              >
                {GATEWAY_DIMENSION_LABELS[option]}
              </button>
            );
          })}
        </div>
      </div>

      <div className={cx(styles.row, styles.headerStrip)}>
        <div>{GATEWAY_DIMENSION_LABELS[dimension].toUpperCase()}</div>
        <div />
        <div className={styles.right}>SPEND</div>
        <div className={styles.right}>SHARE</div>
        <div className={styles.right}>TOKENS</div>
        <div className={styles.right}>REQUESTS</div>
      </div>

      {shown.length === 0 ? (
        <div className={styles.empty}>The gateway reported no {GATEWAY_DIMENSION_LABELS[dimension].toLowerCase()} activity in this range.</div>
      ) : (
        shown.map((row, index) => (
          <div
            key={row.key}
            className={styles.row}
            style={{ ['--row-color' as string]: `var(--chart-${(index % CHART_HUES) + 1})` }}
          >
            <div className={styles.name} title={row.key}>
              <span className={styles.key}>{row.key}</span>
              {row.label !== null && row.label !== row.key && (
                <span className={styles.label}>{row.label}</span>
              )}
            </div>

            <div className={styles.track}>
              <div
                className={styles.fill}
                style={{ width: max > 0 ? `${(row.metrics.spend / max) * 100}%` : '0%' }}
              />
            </div>

            <div className={styles.right}>{usd(row.metrics.spend, 2)}</div>
            <div className={cx(styles.right, styles.muted)}>
              {row.share === 0 ? EMPTY : percent(row.share * 100)}
            </div>
            <div className={cx(styles.right, styles.muted)}>
              {compactCount(row.metrics.totalTokens)}
            </div>
            <div className={cx(styles.right, styles.muted)}>
              {compactCount(row.metrics.requests)}
            </div>
          </div>
        ))
      )}

      {hidden > 0 && (
        <div className={styles.footer}>
          {hidden} more {GATEWAY_DIMENSION_LABELS[dimension].toLowerCase()}
          {hidden === 1 ? '' : 's'} below the top {MAX_ROWS}.
        </div>
      )}
    </Card>
  );
}
