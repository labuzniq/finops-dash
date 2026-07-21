import type { ReactNode } from 'react';
import { count, percent } from '../lib/format.js';
import { cx } from '../lib/cx.js';
import type { DashboardMetrics } from '../hooks/useDashboardMetrics.js';
import { Card } from './Card.js';
import styles from './KpiRow.module.css';

interface KpiCardProps {
  kicker: string;
  value: string;
  valueClassName?: string | undefined;
  children: ReactNode;
}

function KpiCard({ kicker, value, valueClassName, children }: KpiCardProps) {
  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.kicker}>{kicker}</div>
      <div className={cx(styles.value, valueClassName)}>{value}</div>
      {children}
    </Card>
  );
}

interface KpiRowProps {
  metrics: DashboardMetrics;
  /** Day count of the selected range — presets directly, custom ranges inclusive. */
  rangeDays: number;
}

/** Usage KPIs only — money lives in the spend section, fed by billing reports. */
export function KpiRow({ metrics, rangeDays }: KpiRowProps) {
  return (
    <div className={styles.row}>
      <KpiCard kicker="SEATS" value={count(metrics.utilization.totalCount)}>
        <div className={styles.sub}>matching the current filters</div>
      </KpiCard>

      <KpiCard kicker="SEAT UTILIZATION" value={percent(metrics.utilization.utilizedPercent)}>
        <div className={styles.sub}>
          {count(metrics.utilization.activeCount)} of {count(metrics.utilization.totalCount)} active
          in 28d
        </div>
      </KpiCard>

      <KpiCard kicker={`AI CREDITS USED · ${rangeDays}d`} value={count(metrics.premiumRequestsUsed)}>
        <div className={styles.sub}>prorated across filtered seats</div>
      </KpiCard>

      <KpiCard
        kicker="IDLE SEATS"
        value={count(metrics.idleCount)}
        valueClassName={styles.negative}
      >
        <div className={styles.sub}>30d+ or never used</div>
      </KpiCard>
    </div>
  );
}
