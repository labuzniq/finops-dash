import { cx } from '../../lib/cx.js';
import { isoDateLabel, usd } from '../../lib/format.js';
import type { SpendForecast } from '../../lib/metrics/gatewayForecast.js';
import { Card } from '../Card.js';
import styles from './GatewayForecastCard.module.css';

/**
 * Where this calendar month's gateway spend lands.
 *
 * The one card on the page that looks forward, and the only one that ignores
 * the range picker: a projection is only meaningful against the period the
 * budget is set in, and nobody budgets in "last 7 days".
 *
 * The weekday strip is not decoration. It is the evidence for the headline
 * number — each remaining day of the month is priced at what that weekday has
 * been costing, so the strip shows both the rates and which of them are still
 * to come. The flat run-rate figure sits alongside as the answer this card
 * deliberately does not give.
 */

const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** Below this, the month to date is too thin to lead a conversation with. */
const THIN_MONTH_DAYS = 4;

function monthLabel(monthStart: string): string {
  return new Date(`${monthStart}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

interface GatewayForecastCardProps {
  forecast: SpendForecast;
}

export function GatewayForecastCard({ forecast }: GatewayForecastCardProps) {
  const {
    monthToDate,
    projected,
    remaining,
    remainingDays,
    reportedDays,
    flatProjected,
    runRate,
    through,
    weekdays,
    profileDays,
  } = forecast;

  const spentShare = projected > 0 ? (monthToDate / projected) * 100 : 0;
  const peakWeekday = weekdays.reduce((peak, entry) => Math.max(peak, entry.mean ?? 0), 0);
  const complete = remainingDays === 0;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Month-end forecast</div>
          <div className={styles.sub}>
            {monthLabel(forecast.monthStart)} · calendar month, independent of the range above
          </div>
        </div>
        <div className={styles.headline}>
          <div className={styles.kicker}>{complete ? 'MONTH TOTAL' : 'PROJECTED'}</div>
          <div className={styles.headlineValue}>{usd(projected, 0)}</div>
        </div>
      </div>

      <div className={styles.body}>
        <div className={styles.track} role="presentation">
          <div className={styles.spent} style={{ width: `${Math.min(100, spentShare)}%` }} />
        </div>
        <div className={styles.trackNote}>
          <span>
            <span className={styles.swatchSpent} /> {usd(monthToDate, 0)} spent through{' '}
            {isoDateLabel(through)}
          </span>
          <span className={styles.muted}>
            <span className={styles.swatchExpected} />{' '}
            {complete
              ? 'the month is fully reported'
              : `${usd(remaining, 0)} expected over ${remainingDays} more day${remainingDays === 1 ? '' : 's'}`}
          </span>
        </div>

        <div className={styles.statRow}>
          <div className={styles.stat}>
            <div className={styles.kicker}>MONTH TO DATE</div>
            <div className={styles.statValue}>{usd(monthToDate, 0)}</div>
            <div className={styles.statSub}>
              {reportedDays} reported day{reportedDays === 1 ? '' : 's'}
            </div>
          </div>
          <div className={styles.stat}>
            <div className={styles.kicker}>STILL TO COME</div>
            <div className={styles.statValue}>{usd(remaining, 0)}</div>
            <div className={styles.statSub}>{remainingDays} days, priced by weekday</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.kicker}>RUN RATE</div>
            <div className={styles.statValue}>{usd(runRate, 0)}</div>
            <div className={styles.statSub}>per day over the last {profileDays}d</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.kicker}>FLAT RUN RATE SAYS</div>
            <div className={cx(styles.statValue, styles.muted)}>{usd(flatProjected, 0)}</div>
            <div className={styles.statSub}>
              {complete
                ? 'nothing left to price'
                : `${flatProjected > projected ? 'over' : 'under'} by ${usd(Math.abs(flatProjected - projected), 0)} — weekends are not Tuesdays`}
            </div>
          </div>
        </div>

        <div className={styles.profile}>
          {weekdays.map((entry) => (
            <div
              key={entry.weekday}
              className={cx(styles.weekday, entry.remaining && styles.pending)}
              title={`${WEEKDAY_NAMES[entry.weekday]}: ${
                entry.mean === null ? 'not observed' : `${usd(entry.mean, 0)}/day`
              } over ${entry.days} day${entry.days === 1 ? '' : 's'}`}
            >
              <div className={styles.bar}>
                <div
                  className={styles.barFill}
                  style={{
                    height: `${peakWeekday > 0 ? ((entry.mean ?? 0) / peakWeekday) * 100 : 0}%`,
                  }}
                />
              </div>
              <div className={styles.weekdayLabel}>{WEEKDAY_INITIALS[entry.weekday]}</div>
              <div className={styles.weekdayValue}>{usd(entry.mean ?? 0, 0)}</div>
            </div>
          ))}
        </div>

        <div className={styles.footnote}>
          Average spend per weekday over the last {profileDays} days; highlighted weekdays still
          fall inside this month. The projection assumes that shape holds — it does not extrapolate
          growth, so a gateway ramping up reads low.
          {reportedDays < THIN_MONTH_DAYS &&
            ' With only a few reported days, most of this number is still a projection.'}
        </div>
      </div>
    </Card>
  );
}
