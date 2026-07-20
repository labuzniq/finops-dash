import { count } from '../../lib/format.js';
import type { TeamStat } from '../../lib/metrics/usage.js';
import { Card } from '../Card.js';
import styles from './TeamsPanel.module.css';

interface TeamsPanelProps {
  stats: readonly TeamStat[];
}

/**
 * Seats per assigning team with each team's 28-day active share. Roster
 * data, not a time series — the date range doesn't apply, seat filters do.
 */
export function TeamsPanel({ stats }: TeamsPanelProps) {
  const maxSeats = stats.reduce((max, stat) => Math.max(max, stat.seats), 0);

  return (
    <Card>
      <div className={styles.header}>
        <div className={styles.title}>Seats by team</div>
        <div className={styles.note}>active = used in last 28 days</div>
      </div>

      {stats.length === 0 ? (
        <div className={styles.empty}>No team data</div>
      ) : (
        <div className={styles.rows}>
          {stats.map((stat) => (
            <div key={stat.team} className={styles.row}>
              <div className={styles.team}>{stat.team}</div>
              <div className={styles.barTrack}>
                <div
                  className={styles.bar}
                  style={{ width: `${maxSeats === 0 ? 0 : (stat.seats / maxSeats) * 100}%` }}
                />
              </div>
              <div className={styles.seats}>{count(stat.seats)}</div>
              <div className={styles.active}>{stat.activePercent}% active</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
