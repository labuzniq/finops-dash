import type { ReactNode } from 'react';
import { GATEWAY_CHART_VIEWBOX } from '../../lib/metrics/gatewayChart.js';
import type { GatewayChartGeometry } from '../../lib/metrics/gatewayChart.js';
import { Card } from '../Card.js';
import { ChartHoverLayer } from '../ChartHoverLayer.js';
import styles from './GatewayTrendCard.module.css';

/**
 * One gateway series over the range — the hand-rolled fixed-viewbox SVG the
 * rest of the app draws with.
 *
 * Its own component because both the page totals and the per-key drill-down
 * render it; sharing it is what keeps the drill-down chart visually identical
 * to the chart above it, which is the whole point of drilling down.
 */

interface GatewayTrendCardProps {
  title: string;
  /** Right-aligned caption — range label, series note, whatever fits. */
  sub: ReactNode;
  chart: GatewayChartGeometry;
}

export function GatewayTrendCard({ title, sub, chart }: GatewayTrendCardProps) {
  return (
    <Card>
      <div className={styles.chartHeader}>
        <div className={styles.chartTitle}>{title}</div>
        <div className={styles.chartSub}>{sub}</div>
      </div>
      <div className={styles.plot}>
        {chart.gridLines.map((line) => (
          <div key={line.topPercent} className={styles.gridLine} style={{ top: line.topPercent }}>
            <span className={styles.gridLabel}>{line.label}</span>
          </div>
        ))}
        <svg className={styles.svg} viewBox={GATEWAY_CHART_VIEWBOX} preserveAspectRatio="none" aria-hidden>
          <path className={styles.area} d={chart.areaPath} />
          <path className={styles.line} d={chart.linePath} vectorEffect="non-scaling-stroke" />
        </svg>
        <ChartHoverLayer points={chart.hoverPoints} />
        <div className={styles.xLabels}>
          {chart.xLabels.map((label, index) => (
            // Dates can repeat across a short range, so pair them with position.
            <div key={`${label}-${index}`} className={styles.xLabel}>
              {label}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
