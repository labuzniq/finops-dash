import { useState } from 'react';
import type { ChartHoverPoint } from '../lib/metrics/hover.js';
import styles from './ChartHoverLayer.module.css';

/**
 * Crosshair + tooltip overlay shared by the line charts. Sits on top of the
 * plot SVG (same box), snaps the hairline to the nearest data point, and
 * reads out every series at that X. Arrow keys walk the points on focus, so
 * the readout is reachable without a pointer.
 */

interface ChartHoverLayerProps {
  points: readonly ChartHoverPoint[];
}

export function ChartHoverLayer({ points }: ChartHoverLayerProps) {
  const [active, setActive] = useState<number | null>(null);

  if (points.length === 0) return null;

  const last = points.length - 1;
  const clamp = (index: number): number => Math.min(last, Math.max(0, index));
  const point = active === null ? undefined : points[active];
  // Flip the tooltip to the left of the hairline near the right edge.
  const flip = point !== undefined && point.xPercent > 55;

  return (
    <div
      className={styles.layer}
      tabIndex={0}
      aria-label="Chart values. Use arrow keys to move between days."
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const fraction = (event.clientX - rect.left) / rect.width;
        setActive(clamp(Math.round(fraction * last)));
      }}
      onPointerLeave={() => setActive(null)}
      onFocus={() => setActive((current) => current ?? last)}
      onBlur={() => setActive(null)}
      onKeyDown={(event) => {
        const step =
          event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : null;
        if (step !== null) {
          event.preventDefault();
          setActive((current) => clamp((current ?? last) + step));
        } else if (event.key === 'Home') {
          event.preventDefault();
          setActive(0);
        } else if (event.key === 'End') {
          event.preventDefault();
          setActive(last);
        }
      }}
    >
      {point && (
        <>
          <div className={styles.hairline} style={{ left: `${point.xPercent}%` }} />
          {point.series.map((series) => (
            <div
              key={series.label}
              className={styles.marker}
              style={{
                left: `${point.xPercent}%`,
                top: `${series.yPercent}%`,
                borderColor: series.color,
              }}
            />
          ))}
          <div
            className={styles.tooltip}
            style={
              flip
                ? { right: `${100 - point.xPercent}%` }
                : { left: `${point.xPercent}%` }
            }
          >
            <div className={styles.tooltipDate}>{point.dateLabel}</div>
            {point.series.map((series) => (
              <div key={series.label} className={styles.tooltipRow}>
                <span className={styles.tooltipKey} style={{ background: series.color }} />
                <span className={styles.tooltipValue}>{series.value}</span>
                <span className={styles.tooltipLabel}>{series.label}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
