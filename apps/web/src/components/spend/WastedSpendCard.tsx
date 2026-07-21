import { count, usd } from '../../lib/format.js';
import type { WastedSpend } from '../../lib/metrics/spend.js';
import { Card } from '../Card.js';
import styles from './WastedSpendCard.module.css';

/**
 * The rail beside the spend trend: licence money paid for seats that recorded
 * no AI credits in the range. It stretches to the chart's height rather than
 * setting one, so the two panels always end level.
 *
 * When the range has no per-model report at all, every login reads as unused —
 * so the card says it cannot tell rather than reporting total waste.
 */

interface WastedSpendCardProps {
  waste: WastedSpend;
  /** Human label of the selected spend range — "last 28d" or "Jun 3 – Jul 1". */
  rangeLabel: string;
}

export function WastedSpendCard({ waste, rangeLabel }: WastedSpendCardProps) {
  const sharePercent = Math.round(waste.share * 100);

  return (
    <Card column className={styles.card}>
      <div className={styles.kicker}>WASTED · {rangeLabel}</div>

      {!waste.measurable ? (
        <>
          <div className={styles.unknown}>—</div>
          <div className={styles.spacer} />
          <div className={styles.note}>
            No per-model report in this range, so idle seats cannot be told apart from
            unreported ones.
          </div>
        </>
      ) : (
        <>
          <div className={styles.value}>{usd(waste.wasted, 2)}</div>
          <div className={styles.sub}>
            {count(waste.seats)} {waste.seats === 1 ? 'seat' : 'seats'} licensed · 0 credits used
          </div>

          <div className={styles.spacer} />

          <div className={styles.bar} aria-hidden>
            <div className={styles.barFill} style={{ width: `${waste.share * 100}%` }} />
          </div>
          <div className={styles.footer}>
            <span className={styles.share}>{sharePercent}%</span>
            <span className={styles.note}>of {usd(waste.licence, 0)} licence cost</span>
          </div>
        </>
      )}
    </Card>
  );
}
