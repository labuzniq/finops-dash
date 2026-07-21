import { usd } from '../../lib/format.js';
import type { SpendKpis } from '../../lib/metrics/spend.js';
import { Card } from '../Card.js';
import styles from './SpendKpiRow.module.css';

interface SpendKpiRowProps {
  kpis: SpendKpis;
  /** Human label of the selected spend range — "last 28d" or "Jun 3 – Jul 1". */
  rangeLabel: string;
}

/**
 * The four money values of the billing model, side by side. They are four
 * different answers, never summed with each other: Gross is everything
 * including licences, Discount is what the enterprise pool absorbed, Net is
 * usage paid beyond the pool (non-licence skus only), and Licences is the sum
 * of the daily accrual rows — already inside Gross, shown for its own sake.
 */
export function SpendKpiRow({ kpis, rangeLabel }: SpendKpiRowProps) {
  return (
    <div className={styles.row}>
      <Card padded={false} className={styles.card}>
        <div className={styles.kicker}>GROSS · {rangeLabel}</div>
        <div className={styles.value}>{usd(kpis.gross, 2)}</div>
        <div className={styles.sub}>all skus · licences included</div>
      </Card>

      <Card padded={false} className={styles.card}>
        <div className={styles.kicker}>DISCOUNT · {rangeLabel}</div>
        <div className={styles.value}>{usd(kpis.discount, 2)}</div>
        <div className={styles.sub}>covered by the enterprise pool</div>
      </Card>

      <Card padded={false} className={styles.card}>
        <div className={styles.kicker}>NET · {rangeLabel}</div>
        <div className={styles.value}>{usd(kpis.net, 2)}</div>
        <div className={styles.sub}>usage beyond the pool · non-licence skus</div>
      </Card>

      <Card padded={false} className={styles.card}>
        <div className={styles.kicker}>LICENCES · {rangeLabel}</div>
        <div className={styles.value}>{usd(kpis.licence, 2)}</div>
        <div className={styles.sub}>included in Gross</div>
      </Card>
    </div>
  );
}
