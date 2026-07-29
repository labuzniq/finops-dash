import { count, usd } from '../../lib/format.js';
import { cx } from '../../lib/cx.js';
import type { CostCentreDimension, CostCentreRollup } from '../../lib/metrics/costCentre.js';
import { topShare } from '../../lib/metrics/costCentre.js';
import { Card } from '../Card.js';
import styles from './CostCentreCard.module.css';

/**
 * Spend ranked by org unit — the chargeback view. The filter bar answers "what
 * did this department spend"; this answers "which department spends the most",
 * and clicking a row scopes the whole page to it, so the ranking is also the
 * drill-down.
 *
 * Bars scale to the largest bucket rather than to the total, so the leader
 * fills the track and the tail stays legible — same convention as the model
 * chart. `$/person` sits beside the money because departments differ in size:
 * the biggest spender is often just the biggest team.
 */

/** How many buckets the concentration note in the header counts. */
const CONCENTRATION_TOP = 3;

const DIMENSIONS: ReadonlyArray<{ value: CostCentreDimension; label: string }> = [
  { value: 'department', label: 'Department' },
  { value: 'b1Manager', label: 'B-1' },
  { value: 'b2Manager', label: 'B-2' },
];

interface CostCentreCardProps {
  rollup: CostCentreRollup;
  dimension: CostCentreDimension;
  /** The value currently scoping the page on this dimension, if any. */
  selected: string | null;
  /**
   * True when the ranking is wider than the rest of the page — the selected
   * group is being shown against its peers, so these totals deliberately
   * exceed the KPIs and the header has to say so.
   */
  faceted: boolean;
  rangeLabel: string;
  onDimensionChange: (dimension: CostCentreDimension) => void;
  /** Null clears the scope — re-clicking the active row deselects it. */
  onSelect: (value: string | null) => void;
}

export function CostCentreCard({
  rollup,
  dimension,
  selected,
  faceted,
  rangeLabel,
  onDimensionChange,
  onSelect,
}: CostCentreCardProps) {
  const max = rollup.rows.reduce((peak, row) => Math.max(peak, row.net), 0);
  const concentration = Math.round(topShare(rollup, CONCENTRATION_TOP) * 100);

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Spend by cost centre</div>
          <div className={styles.sub}>
            {count(rollup.rows.length)} {rollup.rows.length === 1 ? 'group' : 'groups'} ·{' '}
            {usd(rollup.net, 0)} net · {rangeLabel}
            {rollup.rows.length > CONCENTRATION_TOP && (
              <> · top {CONCENTRATION_TOP} hold {concentration}%</>
            )}
            {faceted && <> · ranked across all groups, not just the selected one</>}
          </div>
        </div>

        <div className={styles.segmented} role="group" aria-label="Group spend by">
          {DIMENSIONS.map((option) => {
            const active = option.value === dimension;
            return (
              <button
                key={option.value}
                type="button"
                className={cx(styles.segment, active && styles.segmentActive)}
                aria-pressed={active}
                onClick={() => onDimensionChange(option.value)}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      {rollup.rows.length === 0 ? (
        <div className={styles.empty}>No spend in this range.</div>
      ) : (
        <div className={styles.rows}>
          <div className={cx(styles.row, styles.headRow)} aria-hidden>
            <div className={styles.name}>Group</div>
            <div className={styles.track} />
            <div className={styles.num}>Net</div>
            <div className={styles.num}>$/person</div>
            <div className={styles.num}>People</div>
            <div className={styles.num}>Idle</div>
          </div>

          {rollup.rows.map((row) => {
            const active = row.key !== null && row.key === selected;
            return (
              <button
                key={row.label}
                type="button"
                // The unassigned bucket has no value to filter by, so it ranks
                // but never drills.
                disabled={row.key === null}
                aria-pressed={active}
                className={cx(styles.row, styles.rowButton, active && styles.rowActive)}
                onClick={() => onSelect(active ? null : row.key)}
              >
                <div className={styles.name} title={row.label}>
                  {row.label}
                </div>

                <div className={styles.track}>
                  <div
                    className={styles.fill}
                    style={{ width: max > 0 ? `${(row.net / max) * 100}%` : '0%' }}
                  />
                </div>

                <div className={styles.num}>{usd(row.net, 2)}</div>
                <div className={cx(styles.num, styles.muted)}>{usd(row.netPerPerson, 2)}</div>
                <div className={cx(styles.num, styles.muted)}>{count(row.people)}</div>
                <div className={cx(styles.num, row.idlePeople > 0 && styles.warn)}>
                  {rollup.idleMeasurable ? count(row.idlePeople) : '—'}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}
