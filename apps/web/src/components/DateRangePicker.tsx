import { useEffect, useRef, useState } from 'react';
import type { DateRange } from '@dash/shared';
import { cx } from '../lib/cx.js';
import { isoDateLabel } from '../lib/format.js';
import styles from './DateRangePicker.module.css';

/**
 * The "Custom" tail of the range segmented control: a button that opens a
 * small popover with two native date inputs. Native inputs keep this
 * dependency-free; the popover and trigger are token-styled to sit inside
 * either page's segmented group.
 *
 * Dates are inclusive ISO `YYYY-MM-DD`, clamped to [min, max] — the window
 * the fetched series actually covers.
 */

interface DateRangePickerProps {
  range: DateRange;
  /** Oldest selectable ISO date — the start of fetched history. */
  min: string;
  /** Newest selectable ISO date — the latest data day. */
  max: string;
  onApply: (from: string, to: string) => void;
}

export function DateRangePicker({ range, min, max, onApply }: DateRangePickerProps) {
  const isCustom = range.kind === 'custom';
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(isCustom ? range.from : min);
  const [to, setTo] = useState(isCustom ? range.to : max);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on Escape or a click that lands outside the popover.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const valid = from !== '' && to !== '' && from <= to && from >= min && to <= max;

  const openPopover = () => {
    // Re-seed the drafts from the active range each time the popover opens.
    setFrom(isCustom ? range.from : min);
    setTo(isCustom ? range.to : max);
    setOpen(true);
  };

  return (
    <div ref={rootRef} className={styles.root}>
      <button
        type="button"
        className={cx(styles.segment, isCustom && styles.segmentActive)}
        aria-pressed={isCustom}
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPopover())}
      >
        {isCustom ? `${isoDateLabel(range.from)} – ${isoDateLabel(range.to)}` : 'Custom'}
      </button>

      {open && (
        <div className={styles.popover} role="dialog" aria-label="Custom date range">
          <label className={styles.field}>
            <span className={styles.label}>From</span>
            <input
              type="date"
              className={styles.input}
              value={from}
              min={min}
              max={max}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>To</span>
            <input
              type="date"
              className={styles.input}
              value={to}
              min={min}
              max={max}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={styles.apply}
            disabled={!valid}
            onClick={() => {
              setOpen(false);
              onApply(from, to);
            }}
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
