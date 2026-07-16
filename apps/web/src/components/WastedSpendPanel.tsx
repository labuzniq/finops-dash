import { count, lastActiveLabel, usd } from '../lib/format.js';
import type { ReclaimCandidate } from '../lib/metrics/idle.js';
import { Avatar } from './Avatar.js';
import { Card } from './Card.js';
import styles from './WastedSpendPanel.module.css';

interface WastedSpendPanelProps {
  wastedMonthly: number;
  idleCount: number;
  candidates: ReclaimCandidate[];
  onReviewIdleSeats: () => void;
}

export function WastedSpendPanel({
  wastedMonthly,
  idleCount,
  candidates,
  onReviewIdleSeats,
}: WastedSpendPanelProps) {
  return (
    <Card column>
      <div className={styles.title}>Wasted spend</div>
      <div className={styles.figure}>
        {usd(wastedMonthly)}
        <span className={styles.perMonth}> /mo</span>
      </div>
      <div className={styles.sub}>{count(idleCount)} idle seats · 30d+ or never used</div>

      <div className={styles.list}>
        {candidates.length === 0 ? (
          <div className={styles.empty}>No idle seats — every seat has been used recently.</div>
        ) : (
          candidates.map(({ seat, monthlyCost }) => (
            <div key={seat.login} className={styles.item}>
              <Avatar name={seat.name} login={seat.login} size={26} fontSize={9.5} />
              <div className={styles.identity}>
                <div className={styles.name}>{seat.name}</div>
                <div className={styles.last}>{lastActiveLabel(seat.lastActivityDays)}</div>
              </div>
              <div className={styles.cost}>{usd(monthlyCost)}/mo</div>
            </div>
          ))
        )}
      </div>

      <div className={styles.spacer} />

      <button type="button" className={styles.review} onClick={onReviewIdleSeats}>
        Review all idle seats
      </button>
    </Card>
  );
}
