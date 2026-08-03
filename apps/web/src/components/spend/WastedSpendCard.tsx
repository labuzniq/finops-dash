import { count, percent, usd } from '../../lib/format.js';
import type { WastedSpend } from '../../lib/metrics/spend.js';
import type { WasteCohortSummary } from '../../lib/metrics/wasteCohort.js';
import { Card } from '../Card.js';
import styles from './WastedSpendCard.module.css';

/**
 * The rail beside the spend trend: licence money paid for seats that recorded
 * no AI credits in the range. It stretches to the chart's height rather than
 * setting one, so the two panels always end level.
 *
 * When the range has no per-model report at all, every login reads as unused —
 * so the card says it cannot tell rather than reporting total waste.
 *
 * The headline is one number and three budget conversations, so the cohorts sit
 * directly under it: "$4,750 wasted" and "$3,100 of it on people who have never
 * spent a credit" are answered by different people. They sum to the headline by
 * construction — same test, same rows.
 */

interface WastedSpendCardProps {
  waste: WastedSpend;
  cohorts: WasteCohortSummary;
  /** Human label of the selected spend range — "last 28d" or "Jun 3 – Jul 1". */
  rangeLabel: string;
}

export function WastedSpendCard({ waste, cohorts, rangeLabel }: WastedSpendCardProps) {
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

          {cohorts.priorHistory ? (
            <div className={styles.cohorts}>
              {cohorts.rows.map((row) => (
                <div key={row.cohort} className={styles.cohort}>
                  <span className={styles.cohortLabel} title={row.label}>
                    {row.label}
                  </span>
                  <span className={styles.cohortAmount}>{usd(row.amount, 0)}</span>
                  <span className={styles.cohortSeats}>
                    {count(row.seats)} · {percent(row.share * 100)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.cohortNote}>
              The per-model report does not reach back before this range, so these seats cannot be
              split into never-used and recently-lapsed.
            </div>
          )}

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
