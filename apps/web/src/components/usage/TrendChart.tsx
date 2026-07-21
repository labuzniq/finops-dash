import { cx } from '../../lib/cx.js';
import { USAGE_CHART_VIEWBOX } from '../../lib/metrics/usage.js';
import type { MultiSeriesGeometry } from '../../lib/metrics/usage.js';
import { Card } from '../Card.js';
import { ChartHoverLayer } from '../ChartHoverLayer.js';
import styles from './TrendChart.module.css';

/** One selectable metric of a merged chart. */
export interface TrendVariant {
  key: string;
  /** Toggle button text, e.g. `Generations`. */
  label: string;
  /** Card title while this variant is active, e.g. `Generations by language`. */
  title: string;
  geometry: MultiSeriesGeometry;
  subtitle?: string;
}

interface TrendChartProps {
  /** Single-chart form. Ignored when `variants` is provided. */
  title?: string;
  geometry?: MultiSeriesGeometry;
  subtitle?: string;
  /** Shown in the plot area when the geometry is empty. */
  emptyMessage?: string;
  /** Merged-chart form: a segmented control switches between these metrics. */
  variants?: readonly TrendVariant[];
  /** Active variant key; missing or unknown falls back to the first variant. */
  activeVariant?: string;
  onVariantChange?: (key: string) => void;
}

/**
 * The spend chart's line treatment, generalised to N series — one line per
 * category, legend from the series names, shared hover readout. Each line sits
 * on a translucent fill of its own colour — every fill is painted before every
 * line, so no series' fill can hide another's line.
 *
 * With `variants`, the chart shows exactly one metric at a time and renders a
 * toggle to switch — related metrics share one card without ever mixing kinds
 * of data in one plot.
 */
export function TrendChart({
  title,
  geometry,
  subtitle,
  emptyMessage,
  variants,
  activeVariant,
  onVariantChange,
}: TrendChartProps) {
  const active =
    variants === undefined
      ? undefined
      : (variants.find((variant) => variant.key === activeVariant) ?? variants[0]);

  const shown =
    active !== undefined
      ? { title: active.title, subtitle: active.subtitle, geometry: active.geometry }
      : geometry !== undefined && title !== undefined
        ? { title, subtitle, geometry }
        : undefined;

  if (shown === undefined) return null;

  return (
    <Card>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>{shown.title}</div>
          {shown.subtitle && <div className={styles.subtitle}>{shown.subtitle}</div>}
        </div>

        <div className={styles.headerRight}>
          {variants && variants.length > 1 && (
            <div className={styles.toggle} role="group" aria-label="Chart metric">
              {variants.map((variant) => (
                <button
                  key={variant.key}
                  type="button"
                  className={cx(styles.segment, variant === active && styles.segmentActive)}
                  aria-pressed={variant === active}
                  onClick={() => onVariantChange?.(variant.key)}
                >
                  {variant.label}
                </button>
              ))}
            </div>
          )}

          {!shown.geometry.empty && (
            <div className={styles.legend}>
              {shown.geometry.series.map((series) => (
                <div key={series.name} className={styles.legendItem}>
                  <div className={styles.swatch} style={{ background: series.colorVar }} />
                  {series.name}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={styles.plot}>
        {shown.geometry.empty ? (
          <div className={styles.empty}>{emptyMessage ?? 'No data in this range'}</div>
        ) : (
          <>
            {shown.geometry.gridLines.map((line) => (
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
              {shown.geometry.series.map((series) => (
                <path
                  key={`area-${series.name}`}
                  className={styles.area}
                  d={series.areaPath}
                  style={{
                    fill: `color-mix(in oklab, ${series.colorVar} var(--chart-fill), transparent)`,
                  }}
                />
              ))}

              {shown.geometry.series.map((series) => (
                <path
                  key={series.name}
                  className={styles.line}
                  d={series.linePath}
                  style={{ stroke: series.colorVar }}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>

            <ChartHoverLayer points={shown.geometry.hoverPoints} />

            <div className={styles.xLabels}>
              {shown.geometry.xLabels.map((label, index) => (
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
