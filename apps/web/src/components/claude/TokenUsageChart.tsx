import { cx } from '../../lib/cx.js';
import { TOKEN_CHART_VIEWBOX } from '../../lib/metrics/tokenChart.js';
import type { TokenChartGeometry } from '../../lib/metrics/tokenChart.js';
import { Card } from '../Card.js';
import styles from './TokenUsageChart.module.css';

/**
 * One token series over time — the CostChart treatment with token-count axis
 * labels. The headline instance plots the daily total; the small multiples
 * underneath plot input, output and cache one per card, sharing this markup
 * at a reduced plot height.
 */

export function TokenUsageChart({
  title,
  geometry,
  small = false,
}: {
  title: string;
  geometry: TokenChartGeometry;
  small?: boolean;
}) {
  return (
    <Card>
      <div className={styles.chartHeader}>
        <div className={styles.chartTitle}>{title}</div>
      </div>
      <div className={cx(styles.plot, small && styles.plotSmall)}>
        {geometry.gridLines.map((line) => (
          <div key={line.topPercent} className={styles.gridLine} style={{ top: line.topPercent }}>
            <span className={styles.gridLabel}>{line.label}</span>
          </div>
        ))}
        <svg
          className={styles.svg}
          viewBox={TOKEN_CHART_VIEWBOX}
          preserveAspectRatio="none"
          role="img"
          aria-label={title}
        >
          <path className={styles.area} d={geometry.areaPath} />
          <path className={styles.line} d={geometry.linePath} vectorEffect="non-scaling-stroke" />
        </svg>
        <div className={styles.xLabels}>
          {geometry.xLabels.map((label, index) => (
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
