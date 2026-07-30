import { GATEWAY_DIMENSION_LABELS } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, count, EMPTY, isoDateLabel, percent } from '../../lib/format.js';
import { DEFAULT_RELIABILITY_OPTIONS } from '../../lib/metrics/gatewayReliability.js';
import type { ReliabilityDay, ReliabilitySummary } from '../../lib/metrics/gatewayReliability.js';
import { Card } from '../Card.js';
import styles from './GatewayReliabilityCard.module.css';

/**
 * Where the gateway's failures actually are.
 *
 * The KPI row already carries one success rate for the whole proxy, and that
 * number is close to useless on its own: a single endpoint in front of three
 * clouds is never uniformly healthy, so the aggregate is always one throttled
 * deployment averaged against everything that works. This card takes the same
 * failures apart two ways — by day, so an incident reads as the two days it
 * was, and by key of the dimension the page is already on, so a bad deployment
 * is named.
 *
 * It is deliberately not merged into the unusual-spend card, and the mock's
 * regional incident is the argument: a rejected call bills no tokens, so a
 * two-day backend outage moves spend *down*. Nothing on a spend-shaped surface
 * can see it.
 *
 * Rows rank by failures *above* the gateway-wide rate rather than by count.
 * Ranking by count answers "which key gets the most traffic", which the
 * breakdown card above already answers, and would put a healthy busy model at
 * the top of a reliability list every single day.
 */

/** Enough to name the culprits; past this it is a table, not a finding. */
const MAX_ROWS = 8;

interface GatewayReliabilityCardProps {
  summary: ReliabilitySummary;
}

/** 0..1 → `2.4%`, or `—` when there were no requests to rate. */
function rate(value: number | null): string {
  return value === null ? EMPTY : percent(value * 100);
}

export function GatewayReliabilityCard({ summary }: GatewayReliabilityCardProps) {
  const dimensionLabel = GATEWAY_DIMENSION_LABELS[summary.dimension].toLowerCase();
  const shown = summary.rows.slice(0, MAX_ROWS);
  const hidden = summary.rows.length - shown.length;
  const worstRate = shown.reduce((peak, row) => Math.max(peak, row.failureRate ?? 0), 0);
  const flagged = summary.rows.filter((row) => row.elevated).length;

  if (summary.requests === 0) return null;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Reliability</div>
          <div className={styles.sub}>
            failed calls by day and by {dimensionLabel} · ranked by failures above the gateway-wide
            rate, so a busy healthy {dimensionLabel} does not outrank a broken one
          </div>
        </div>
        <div className={styles.headline}>
          <div className={styles.headlineValue}>{rate(summary.failureRate)}</div>
          <div className={styles.headlineNote}>
            {count(summary.failedRequests)} of {compactCount(summary.requests)} calls failed
          </div>
        </div>
      </div>

      <DayStrip days={summary.daily} worstDays={summary.worstDays} />

      <div className={cx(styles.row, styles.headerStrip)}>
        <div>{GATEWAY_DIMENSION_LABELS[summary.dimension].toUpperCase()}</div>
        <div />
        <div className={styles.right}>FAILURE RATE</div>
        <div className={styles.right}>FAILED</div>
        <div className={styles.right}>VS GATEWAY</div>
        <div className={styles.right}>WORST DAY</div>
      </div>

      {shown.length === 0 ? (
        <div className={styles.empty}>
          The gateway reported no {dimensionLabel} breakdown for this range.
        </div>
      ) : (
        shown.map((row) => (
          <div key={row.key} className={cx(styles.row, row.elevated && styles.rowFlagged)}>
            <div className={styles.name} title={row.key}>
              <span className={styles.key}>{row.label ?? row.key}</span>
              {row.label !== null && row.label !== row.key && (
                <span className={styles.sublabel}>{row.key}</span>
              )}
            </div>

            <div className={styles.trackCell}>
              <div className={styles.track}>
                <div
                  className={cx(styles.fill, row.elevated && styles.fillBad)}
                  style={{
                    width: worstRate > 0 ? `${((row.failureRate ?? 0) / worstRate) * 100}%` : '0%',
                  }}
                />
              </div>
              {row.elevated && <span className={styles.badge}>elevated</span>}
            </div>

            <div className={cx(styles.right, row.elevated && styles.bad)}>
              {rate(row.failureRate)}
            </div>
            <div className={cx(styles.right, styles.muted)}>
              {count(row.failedRequests)}
              <span className={styles.share}>
                {row.shareOfFailures === 0 ? EMPTY : `${percent(row.shareOfFailures * 100)} of all`}
              </span>
            </div>
            <div className={cx(styles.right, row.excessFailures > 0 ? styles.bad : styles.good)}>
              {row.excessFailures > 0 ? '+' : '−'}
              {count(Math.abs(Math.round(row.excessFailures)))}
              <span className={styles.share}>calls</span>
            </div>
            <div className={cx(styles.right, styles.muted)}>
              {row.worstDay === null ? (
                EMPTY
              ) : (
                <>
                  {rate(row.worstDay.failureRate)}
                  <span className={styles.share}>{isoDateLabel(row.worstDay.date)}</span>
                </>
              )}
            </div>
          </div>
        ))
      )}

      {hidden > 0 && (
        <div className={styles.footer}>
          {hidden} more {dimensionLabel}
          {hidden === 1 ? '' : 's'} below the top {MAX_ROWS}
          {flagged > 0 && ` · ${flagged} ${dimensionLabel}${flagged === 1 ? '' : 's'} flagged in total`}
          .
        </div>
      )}
    </Card>
  );
}

/**
 * One bar per day of the same spine the trend charts draw, scaled to the worst
 * day's rate.
 *
 * Rate, not count: a Saturday with 300 failures out of 5,000 calls is a worse
 * day than a Wednesday with 900 out of 60,000, and a count strip would say the
 * opposite. Days the proxy saw no traffic at all draw nothing rather than a
 * floor-height bar, because an idle day has no failure rate to show.
 */
function DayStrip({
  days,
  worstDays,
}: {
  days: readonly ReliabilityDay[];
  worstDays: readonly ReliabilityDay[];
}) {
  const peak = days.reduce((most, day) => Math.max(most, day.failureRate ?? 0), 0);
  if (peak === 0) return null;

  const worst = worstDays[0] ?? null;

  return (
    <div className={styles.strip}>
      <div className={styles.stripBars} role="img" aria-label="Daily failure rate">
        {days.map((day) => (
          <div
            key={day.date}
            className={styles.stripSlot}
            title={`${day.date} · ${rate(day.failureRate)} of ${count(day.requests)} calls${day.elevated ? ' · elevated' : ''}`}
          >
            <div
              className={cx(styles.stripBar, day.elevated && styles.stripBarBad)}
              style={{ height: `${((day.failureRate ?? 0) / peak) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className={styles.stripNote}>
        {worstDays.length === 0 ? (
          <>
            No day ran more than {DEFAULT_RELIABILITY_OPTIONS.minRatio}× the range&apos;s own
            failure rate.
          </>
        ) : (
          <>
            {worstDays.length} day{worstDays.length === 1 ? '' : 's'} above{' '}
            {DEFAULT_RELIABILITY_OPTIONS.minRatio}× the range&apos;s own rate
            {worst !== null && (
              <>
                {' '}
                · worst {isoDateLabel(worst.date)} at {rate(worst.failureRate)} (
                {count(Math.round(worst.excessFailures))} calls more than usual)
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
