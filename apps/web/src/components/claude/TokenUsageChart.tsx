import { cx } from '../../lib/cx.js';
import { TOKEN_CHART_VIEWBOX } from '../../lib/metrics/tokenChart.js';
import type { TokenChartGeometry, TokenKind } from '../../lib/metrics/tokenChart.js';
import { Card } from '../Card.js';
import styles from './TokenUsageChart.module.css';

/**
 * Daily token volumes as stacked bars — input at the baseline, output and
 * cache above it. Identity never rides on colour alone: the stack order is
 * fixed, the legend is always present and each bar carries a value tooltip.
 */

const SEGMENT_CLASS: Record<TokenKind, string | undefined> = {
  input: styles.segmentInput,
  output: styles.segmentOutput,
  cache: styles.segmentCache,
};

const LEGEND: readonly { kind: TokenKind; label: string }[] = [
  { kind: 'input', label: 'Input' },
  { kind: 'output', label: 'Output' },
  { kind: 'cache', label: 'Cache' },
];

export function TokenUsageChart({ geometry }: { geometry: TokenChartGeometry }) {
  return (
    <Card>
      <div className={styles.chartHeader}>
        <div className={styles.chartTitle}>Daily tokens</div>
        <div className={styles.legend}>
          {LEGEND.map(({ kind, label }) => (
            <span key={kind} className={styles.legendItem}>
              <span className={cx(styles.swatch, styles[kind])} />
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className={styles.plot}>
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
          aria-label="Daily token usage by kind"
        >
          {geometry.bars.map((bar, index) => (
            // Range slicing recomputes the whole array; index is the identity.
            <g key={index}>
              <title>{bar.title}</title>
              {bar.segments.map((segment) => (
                <rect
                  key={segment.kind}
                  className={cx(styles.segment, SEGMENT_CLASS[segment.kind])}
                  x={segment.x}
                  y={segment.y}
                  width={segment.width}
                  height={segment.height}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          ))}
        </svg>
        <div className={styles.xLabels}>
          {geometry.xLabels.map((label, index) => (
            <div key={`${label}-${index}`} className={styles.xLabel}>
              {label}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
