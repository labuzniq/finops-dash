import { USAGE_CHART_VIEWBOX } from '../../lib/metrics/usage.js';
import type { MultiSeriesGeometry } from '../../lib/metrics/usage.js';
import { Card } from '../Card.js';
import { ChartHoverLayer } from '../ChartHoverLayer.js';
import styles from './TrendChart.module.css';

interface TrendChartProps {
  title: string;
  geometry: MultiSeriesGeometry;
  /** Shown in the plot area when the geometry is empty. */
  emptyMessage?: string;
  subtitle?: string;
}

/**
 * The spend chart's line treatment, generalised to N series — one line per
 * category, legend from the series names, shared hover readout. No area fill:
 * with several lines a fill would occlude the ones behind it.
 */
export function TrendChart({ title, geometry, emptyMessage, subtitle }: TrendChartProps) {
  return (
    <Card>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>{title}</div>
          {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
        </div>
        {!geometry.empty && (
          <div className={styles.legend}>
            {geometry.series.map((series) => (
              <div key={series.name} className={styles.legendItem}>
                <div className={styles.swatch} style={{ background: series.colorVar }} />
                {series.name}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.plot}>
        {geometry.empty ? (
          <div className={styles.empty}>{emptyMessage ?? 'No data in this range'}</div>
        ) : (
          <>
            {geometry.gridLines.map((line) => (
              <div key={line.topPercent} className={styles.gridLine} style={{ top: line.topPercent }}>
                <span className={styles.gridLabel}>{line.label}</span>
              </div>
            ))}

            <svg
              className={styles.svg}
              viewBox={USAGE_CHART_VIEWBOX}
              preserveAspectRatio="none"
              aria-hidden
            >
              {geometry.series.map((series) => (
                <path
                  key={series.name}
                  className={styles.line}
                  d={series.linePath}
                  style={{ stroke: series.colorVar }}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>

            <ChartHoverLayer points={geometry.hoverPoints} />

            <div className={styles.xLabels}>
              {geometry.xLabels.map((label, index) => (
                // Dates can repeat across a short range, so pair them with position.
                <div key={`${label}-${index}`} className={styles.xLabel}>
                  {label}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
