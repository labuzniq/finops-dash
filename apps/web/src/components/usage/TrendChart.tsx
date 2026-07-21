import { useState } from 'react';
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
  const [hovered, setHovered] = useState<string | null>(null);

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

  // A hovered name left over from a variant switch may not exist in the new
  // series set — treat it as no hover rather than dimming every line.
  const highlighted = shown.geometry.series.some((series) => series.name === hovered)
    ? hovered
    : null;
  const dimmed = (name: string) => highlighted !== null && name !== highlighted;

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
                <div
                  key={series.name}
                  className={cx(styles.legendItem, dimmed(series.name) && styles.legendItemDimmed)}
                  onMouseEnter={() => setHovered(series.name)}
                  onMouseLeave={() => setHovered(null)}
                >
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
                  className={cx(styles.area, dimmed(series.name) && styles.seriesDimmed)}
                  d={series.areaPath}
                  style={{
                    fill: `color-mix(in oklab, ${series.colorVar} var(--chart-fill), transparent)`,
                  }}
                />
              ))}

              {shown.geometry.series.map((series) => (
                <path
                  key={series.name}
                  className={cx(styles.line, dimmed(series.name) && styles.seriesDimmed)}
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
