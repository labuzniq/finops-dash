import type { ReactNode } from 'react';
import type { RangeDays } from '@dash/shared';
import { count, percent, usd } from '../lib/format.js';
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
  range: RangeDays;
}

export function KpiRow({ metrics, range }: KpiRowProps) {
  const { deltaPercent } = metrics.spend;
  const isUp = deltaPercent >= 0;

  return (
    <div className={styles.row}>
      <KpiCard kicker={`TOTAL SPEND · ${range}d`} value={usd(metrics.spend.total)}>
        <div className={cx(styles.sub, styles.subDelta, isUp ? styles.negative : styles.positive)}>
          {isUp ? '↑ +' : '↓ '}
          {deltaPercent.toFixed(1)}% vs prev period
        </div>
      </KpiCard>

      <KpiCard kicker="AVG COST / ACTIVE USER" value={usd(metrics.avgCostPerActiveUser, 2)}>
        <div className={styles.sub}>license + premium requests</div>
      </KpiCard>

      <KpiCard kicker="SEAT UTILIZATION" value={percent(metrics.utilization.utilizedPercent)}>
        <div className={styles.sub}>
          {count(metrics.utilization.activeCount)} of {count(metrics.utilization.totalCount)} active
          in 28d
        </div>
      </KpiCard>

      <KpiCard
        kicker="WASTED SPEND / MO"
        value={usd(metrics.wastedMonthly)}
        valueClassName={styles.negative}
      >
        <div className={styles.sub}>
          {count(metrics.idleCount)} idle seats · 30d+ or never used
        </div>
      </KpiCard>
    </div>
  );
}
