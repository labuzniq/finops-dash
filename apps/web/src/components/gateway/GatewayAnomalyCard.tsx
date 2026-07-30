import { GATEWAY_DIMENSION_LABELS } from '@dash/shared';
import type { GatewayDimension } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, count, isoDateLabel, percent, usd } from '../../lib/format.js';
import { DEFAULT_ANOMALY_OPTIONS } from '../../lib/metrics/gatewayAnomaly.js';
import type { AnomalyAttribution, SpendAnomaly } from '../../lib/metrics/gatewayAnomaly.js';
import { Card } from '../Card.js';
import styles from './GatewayAnomalyCard.module.css';

/**
 * The days the gateway ran away from itself, and who paid for them.
 *
 * A range total tells you what the month cost; it does not tell you that one
 * Tuesday cost four times what the Tuesday before it did. Per-token spend is
 * the only surface in this console where that can happen overnight — a batch
 * job left looping, a prompt that grew a system block, an agent stuck
 * retrying — so it is the only one with this card.
 *
 * Selecting a day attributes its overrun across the breakdown dimension the
 * page is already on, which is why the two cards never disagree about which
 * slice is being discussed.
 */

/** Enough contributors to name a culprit; past that it is a breakdown table. */
const MAX_CONTRIBUTORS = 5;

interface GatewayAnomalyCardProps {
  anomalies: readonly SpendAnomaly[];
  dimension: GatewayDimension;
  /** The opened day, or null. Owned by the page, like every other selection here. */
  selectedDate: string | null;
  onSelect: (date: string) => void;
  /** Attribution of the opened day; null while nothing is open. */
  attribution: AnomalyAttribution | null;
}

export function GatewayAnomalyCard({
  anomalies,
  dimension,
  selectedDate,
  onSelect,
  attribution,
}: GatewayAnomalyCardProps) {
  const peak = anomalies.reduce((most, anomaly) => Math.max(most, anomaly.excess), 0);
  const dimensionLabel = GATEWAY_DIMENSION_LABELS[dimension].toLowerCase();

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Unusual spend</div>
          <div className={styles.sub}>
            days more than {Math.round(DEFAULT_ANOMALY_OPTIONS.minExcessShare * 100)}% above their
            trailing {DEFAULT_ANOMALY_OPTIONS.window}-day median, and far enough outside its normal
            spread to be worth a look · select a day to see which {dimensionLabel} paid for it
          </div>
        </div>
      </div>

      {anomalies.length === 0 ? (
        <div className={styles.empty}>
          No day in this range ran away from its {DEFAULT_ANOMALY_OPTIONS.window}-day baseline.
        </div>
      ) : (
        <>
          <div className={cx(styles.row, styles.headerStrip)}>
            <div>DAY</div>
            <div />
            <div className={styles.right}>SPEND</div>
            <div className={styles.right}>USUAL</div>
            <div className={styles.right}>OVERRUN</div>
            <div className={styles.right}>REQUESTS</div>
          </div>

          {anomalies.map((anomaly) => {
            const open = anomaly.date === selectedDate;
            return (
              <div key={anomaly.date}>
                <button
                  type="button"
                  className={cx(styles.row, styles.rowButton, open && styles.rowSelected)}
                  aria-expanded={open}
                  onClick={() => onSelect(anomaly.date)}
                >
                  <div className={styles.day}>
                    <span className={styles.date}>{isoDateLabel(anomaly.date)}</span>
                    <span className={styles.weekday}>
                      {new Date(`${anomaly.date}T00:00:00Z`).toLocaleDateString('en-GB', {
                        weekday: 'long',
                        timeZone: 'UTC',
                      })}
                    </span>
                  </div>

                  <div className={styles.track}>
                    <div
                      className={styles.fill}
                      style={{ width: peak > 0 ? `${(anomaly.excess / peak) * 100}%` : '0%' }}
                    />
                  </div>

                  <div className={styles.right}>{usd(anomaly.spend, 2)}</div>
                  <div className={cx(styles.right, styles.muted)}>{usd(anomaly.baseline, 2)}</div>
                  <div className={cx(styles.right, styles.excess)}>
                    +{usd(anomaly.excess, 2)}
                    <span className={styles.excessShare}>
                      {percent(anomaly.excessShare * 100)}
                    </span>
                  </div>
                  <div className={cx(styles.right, styles.muted)}>
                    {compactCount(anomaly.requests)}
                    {anomaly.failedRequests > 0 && (
                      <span className={styles.failed}>{count(anomaly.failedRequests)} failed</span>
                    )}
                  </div>
                </button>

                {open && attribution !== null && (
                  <Attribution attribution={attribution} dimension={dimension} />
                )}
              </div>
            );
          })}
        </>
      )}
    </Card>
  );
}

/**
 * Who overran, by the dimension the page is on.
 *
 * The baseline here is the trailing *mean*, not the median the detector used,
 * and the difference is not cosmetic: means add up, so these rows reconcile to
 * the day's overrun exactly. The panel says which number it is measuring
 * against rather than letting the reader assume it is the same one on the row
 * above.
 */
function Attribution({
  attribution,
  dimension,
}: {
  attribution: AnomalyAttribution;
  dimension: GatewayDimension;
}) {
  const risers = attribution.contributors.filter((row) => row.excess > 0);
  const shown = risers.slice(0, MAX_CONTRIBUTORS);
  const accounted = shown.reduce((total, row) => total + row.excess, 0);
  const dimensionLabel = GATEWAY_DIMENSION_LABELS[dimension].toLowerCase();

  if (shown.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.panelEmpty}>
          The proxy reported no {dimensionLabel} breakdown for this day.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>
          +{usd(attribution.excess, 2)} above the {DEFAULT_ANOMALY_OPTIONS.window}-day average, by{' '}
          {dimensionLabel}
        </span>
        <span className={styles.panelNote}>
          {dimension === 'mcp_server'
            ? 'MCP traffic is a subset of the day — these account for part of the overrun, not all of it'
            : `top ${shown.length} account for ${percent(attribution.excess > 0 ? (accounted / attribution.excess) * 100 : 0)} of it`}
        </span>
      </div>

      {shown.map((row) => (
        <div key={row.key} className={styles.contributor}>
          <div className={styles.name} title={row.key}>
            <span className={styles.key}>{row.label ?? row.key}</span>
            {row.label !== null && row.label !== row.key && (
              <span className={styles.sublabel}>{row.key}</span>
            )}
          </div>

          <div className={styles.track}>
            <div
              className={cx(styles.fill, styles.fillWarn)}
              style={{
                width:
                  attribution.excess > 0
                    ? `${Math.min(100, Math.max(0, row.share * 100))}%`
                    : '0%',
              }}
            />
          </div>

          <div className={cx(styles.right, styles.excess)}>+{usd(row.excess, 2)}</div>
          <div className={cx(styles.right, styles.muted)}>
            {usd(row.spend, 2)} <span className={styles.versus}>vs {usd(row.baseline, 2)}</span>
          </div>
          <div className={cx(styles.right, styles.muted)}>
            {compactCount(row.requests)}{' '}
            <span className={styles.versus}>vs {compactCount(Math.round(row.requestsBaseline))}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
