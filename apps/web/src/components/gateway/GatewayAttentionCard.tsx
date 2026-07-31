import { GATEWAY_DIMENSION_LABELS } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import type { AlertSeverity, AlertSource, GatewayAlertDigest } from '../../lib/metrics/gatewayAlerts.js';
import { Card } from '../Card.js';
import styles from './GatewayAttentionCard.module.css';

/**
 * The page's findings in one place, at the top.
 *
 * Thirteen cards below this one each flag what they know about, and every one of
 * those flags is below the fold — a key rejecting calls, a day that overran, a
 * deployment failing above the gateway rate. This card carries none of its own
 * judgement (see `lib/metrics/gatewayAlerts.ts`): it repeats what the card it
 * points at already said, and the row's button takes the reader there.
 *
 * It renders nothing on a gateway with nothing to report and nothing unread —
 * an "all clear" banner on a healthy proxy is a row of furniture people learn to
 * scroll past, and the one week it matters they will scroll past it too.
 */

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Note',
};

/** Where each source's card lives on the page. */
const SOURCE_ANCHOR: Record<AlertSource, string> = {
  budget: 'gateway-budgets',
  anomaly: 'gateway-anomalies',
  reliability: 'gateway-reliability',
  cache: 'gateway-cache',
  coverage: 'gateway-coverage',
  health: 'gateway-health',
};

const SOURCE_LABEL: Record<AlertSource, string> = {
  budget: 'Budgets',
  anomaly: 'Unusual spend',
  reliability: 'Reliability',
  cache: 'Prompt cache',
  coverage: 'Coverage',
  health: 'Deployment health',
};

function scrollTo(anchor: string): void {
  document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

interface GatewayAttentionCardProps {
  digest: GatewayAlertDigest;
}

export function GatewayAttentionCard({ digest }: GatewayAttentionCardProps) {
  if (digest.allClear) return null;

  const dimension = GATEWAY_DIMENSION_LABELS[digest.dimension].toLowerCase();

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Needs attention</div>
          <div className={styles.sub}>
            every finding the cards below have already made · reliability and cache read through the{' '}
            {dimension} breakdown, so switching it can name different keys
          </div>
        </div>
        <div className={styles.counts}>
          <Count value={digest.critical} severity="critical" />
          <Count value={digest.warning} severity="warning" />
          <Count value={digest.info} severity="info" />
        </div>
      </div>

      {digest.alerts.length === 0 ? (
        <div className={styles.empty}>
          Nothing flagged in this range — but see what was not read, below.
        </div>
      ) : (
        <ul className={styles.list}>
          {digest.alerts.map((entry) => (
            <li key={entry.id} className={cx(styles.row, styles[entry.severity])}>
              <span className={styles.rail} aria-hidden="true" />
              <div className={styles.body}>
                <div className={styles.headline}>
                  <span className={styles.severity}>{SEVERITY_LABEL[entry.severity]}</span>
                  <span className={styles.rowTitle}>{entry.title}</span>
                  {entry.label !== null && (
                    <span className={styles.subject} title={entry.subject}>
                      {entry.label}
                    </span>
                  )}
                </div>
                <div className={styles.detail}>{entry.detail}</div>
              </div>
              <button
                type="button"
                className={styles.jump}
                onClick={() => scrollTo(SOURCE_ANCHOR[entry.source])}
              >
                {SOURCE_LABEL[entry.source]} ↓
              </button>
            </li>
          ))}
        </ul>
      )}

      {digest.truncated > 0 && (
        <div className={styles.footnote}>
          {digest.truncated} further finding{digest.truncated === 1 ? '' : 's'} not shown — the cards
          below carry every one of them.
        </div>
      )}

      {digest.blindSpots.length > 0 && (
        <div className={styles.blind}>
          <div className={styles.blindTitle}>Not checked</div>
          <ul className={styles.blindList}>
            {digest.blindSpots.map((spot) => (
              <li key={spot}>{spot}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Count({ value, severity }: { value: number; severity: AlertSeverity }) {
  return (
    <div className={cx(styles.count, value === 0 && styles.countZero)}>
      <span className={cx(styles.countValue, styles[severity])}>{value}</span>
      <span className={styles.countLabel}>{SEVERITY_LABEL[severity].toLowerCase()}</span>
    </div>
  );
}
