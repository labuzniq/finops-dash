import { count, usd } from '../lib/format.js';
import { CHART_VIEWBOX } from '../lib/metrics/chart.js';
import type { ChartGeometry } from '../lib/metrics/chart.js';
import { Card } from './Card.js';
import { ChartHoverLayer } from './ChartHoverLayer.js';
import styles from './SpendTrendChart.module.css';

interface SpendTrendChartProps {
  chart: ChartGeometry;
  license: number;
  premiumOverage: number;
  premiumRequestsUsed: number;
}

export function SpendTrendChart({
  chart,
  license,
  premiumOverage,
  premiumRequestsUsed,
}: SpendTrendChartProps) {
  return (
    <Card>
      <div className={styles.header}>
        <div className={styles.title}>Spend trend</div>
        <div className={styles.legend}>
          <div className={styles.legendItem}>
            <div className={`${styles.swatch} ${styles.swatchTotal}`} />
            Total spend
          </div>
          <div className={styles.legendItem}>
            <div className={`${styles.swatch} ${styles.swatchPremium}`} />
            Premium requests
          </div>
        </div>
      </div>

      <div className={styles.plot}>
        {chart.gridLines.map((line) => (
          <div key={line.topPercent} className={styles.gridLine} style={{ top: line.topPercent }}>
            <span className={styles.gridLabel}>{line.label}</span>
          </div>
        ))}

        <svg className={styles.svg} viewBox={CHART_VIEWBOX} preserveAspectRatio="none" aria-hidden>
          <path className={styles.area} d={chart.areaPath} />
          <path className={styles.line} d={chart.linePath} vectorEffect="non-scaling-stroke" />
          <path
            className={styles.premiumLine}
            d={chart.premiumPath}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
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

      <div className={styles.footer}>
        <div>
          License: <span className={styles.footerValue}>{usd(license)}</span>
        </div>
        <div>
          Premium request overage: <span className={styles.footerValue}>{usd(premiumOverage)}</span>
        </div>
        <div>
          Premium requests used:{' '}
          <span className={styles.footerValue}>{count(premiumRequestsUsed)}</span>
        </div>
      </div>
    </Card>
  );
}
