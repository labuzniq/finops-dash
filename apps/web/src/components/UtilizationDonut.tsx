import { count, percent } from '../lib/format.js';
import type { Utilization, UtilizationBucketKey } from '../lib/metrics/utilization.js';
import { Card } from './Card.js';
import styles from './UtilizationDonut.module.css';

/**
 * Bucket colours run from the accent (most engaged) down to the border tint
 * (never used) — value, not hue, carries the meaning.
 */
const BUCKET_COLOR: Record<UtilizationBucketKey, string> = {
  active7: 'var(--accent)',
  active28: 'color-mix(in oklab, var(--accent) 45%, var(--card))',
  dormant: 'var(--faint)',
  never: 'var(--border)',
};

const RADIUS = 56;
const CENTER = 70;

interface UtilizationDonutProps {
  utilization: Utilization;
}

export function UtilizationDonut({ utilization }: UtilizationDonutProps) {
  // Painted back to front so the leading segment sits on top of the seam.
  const segments = [...utilization.buckets].reverse();

  return (
    <Card column>
      <div className={styles.title}>Seat utilization</div>

      <div className={styles.body}>
        <div className={styles.donut}>
          <svg className={styles.ring} viewBox="0 0 140 140" aria-hidden>
            <circle className={styles.track} cx={CENTER} cy={CENTER} r={RADIUS} />
            {segments.map((bucket) => (
              <circle
                key={bucket.key}
                className={styles.segment}
                cx={CENTER}
                cy={CENTER}
                r={RADIUS}
                strokeDasharray={bucket.dashArray}
                strokeDashoffset={bucket.dashOffset}
                style={{ stroke: BUCKET_COLOR[bucket.key] }}
              />
            ))}
          </svg>

          <div className={styles.center}>
            <div className={styles.centerValue}>{percent(utilization.utilizedPercent)}</div>
            <div className={styles.centerLabel}>utilized</div>
          </div>
        </div>

        <div className={styles.legend}>
          {utilization.buckets.map((bucket) => (
            <div key={bucket.key} className={styles.legendRow}>
              <div className={styles.swatch} style={{ background: BUCKET_COLOR[bucket.key] }} />
              {bucket.label}
              <div className={styles.legendSpacer} />
              <span className={styles.legendValue}>
                {count(bucket.count)} · {bucket.percent}%
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.spacer} />

      <div className={styles.footnote}>
        Seats from the Copilot user-management API; activity from last_activity_at.
      </div>
    </Card>
  );
}
