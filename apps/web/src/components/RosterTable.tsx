import { useState } from 'react';
import { count, EMPTY, usd } from '../lib/format.js';
import { cx } from '../lib/cx.js';
import type { CostCentreDimension } from '../lib/metrics/costCentre.js';
import type { Roster, RosterGroup } from '../lib/metrics/roster.js';
import { paginate } from '../lib/metrics/table.js';
import { Card } from './Card.js';
import styles from './RosterTable.module.css';

/**
 * A waste roster: the people behind a waste number, grouped by the org unit
 * whose owner you would contact about them.
 *
 * Groups are collapsed by default — two hundred names is not an opening
 * screen, so the group rows are the summary and expansion is the drill-down.
 * Paging is over *groups* rather than people, and an expanded group lists all
 * of its people: a manager with two dozen idle reports is itself the finding,
 * and hiding half of them behind a second pager would bury it.
 *
 * The component renders both rosters and knows which is which only through
 * `showAmount`. Money belongs to the spend page alone, so the idle roster
 * passes false and no dollar column exists to fill.
 */

const DIMENSIONS: ReadonlyArray<{ value: CostCentreDimension; label: string }> = [
  { value: 'b1Manager', label: 'B-1' },
  { value: 'b2Manager', label: 'B-2' },
  { value: 'department', label: 'Department' },
];

interface RosterTableProps {
  title: string;
  /** Header line under the title — the caller states the population and range. */
  subtitle: string;
  roster: Roster;
  dimension: CostCentreDimension;
  /** True on the spend roster only: the idle page carries no money. */
  showAmount: boolean;
  /** Column heading for each person's right-hand fact. */
  detailLabel: string;
  /**
   * Shown instead of the table when the source cannot measure the population.
   * Absent on rosters that always can — the idle seats read their own
   * timestamps and have no second report to be missing.
   */
  unmeasurableNote?: string;
  emptyNote: string;
  onDimensionChange: (dimension: CostCentreDimension) => void;
  onExport: () => void;
}

export function RosterTable({
  title,
  subtitle,
  roster,
  dimension,
  showAmount,
  detailLabel,
  unmeasurableNote,
  emptyNote,
  onDimensionChange,
  onExport,
}: RosterTableProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [pageIndex, setPageIndex] = useState(0);

  // Groups, not people — an expanded group shows everyone under it.
  const page = paginate(roster.groups, pageIndex);
  const max = roster.groups.reduce(
    (peak, group) => Math.max(peak, showAmount ? group.amount : group.people.length),
    0,
  );

  // Functional update, not a set built from the render's own `expanded`: two
  // toggles inside one batch would both read the pre-batch value and the
  // second would drop the first.
  const toggle = (group: RosterGroup): void => {
    const id = group.key ?? '';
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const barWidth = (group: RosterGroup): string => {
    if (max <= 0) return '0%';
    const value = showAmount ? group.amount : group.people.length;
    return `${(value / max) * 100}%`;
  };

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>{title}</div>
          <div className={styles.sub}>{subtitle}</div>
        </div>

        <div className={styles.controls}>
          <div className={styles.segmented} role="group" aria-label="Group people by">
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

          <button
            type="button"
            className={styles.export}
            disabled={roster.people === 0}
            onClick={onExport}
          >
            Export {count(roster.people)} · CSV
          </button>
        </div>
      </div>

      {!roster.measurable && unmeasurableNote !== undefined && (
        <div className={styles.empty}>{unmeasurableNote}</div>
      )}

      {roster.measurable && roster.groups.length === 0 && (
        <div className={styles.empty}>{emptyNote}</div>
      )}

      {roster.measurable && roster.groups.length > 0 && (
        <>
          <div className={styles.rows}>
            <div
              className={cx(styles.groupRow, showAmount && styles.withAmount, styles.headRow)}
              aria-hidden
            >
              <div className={styles.name}>Group</div>
              <div className={styles.track} />
              {showAmount && <div className={styles.num}>Wasted</div>}
              <div className={styles.num}>People</div>
            </div>

            {page.items.map((group) => {
              const id = group.key ?? '';
              const open = expanded.has(id);

              return (
                <div key={id} className={styles.group}>
                  <button
                    type="button"
                    className={cx(styles.groupRow, showAmount && styles.withAmount, styles.groupButton)}
                    aria-expanded={open}
                    onClick={() => toggle(group)}
                  >
                    <div className={styles.name} title={group.label}>
                      <span className={cx(styles.chevron, open && styles.chevronOpen)} aria-hidden>
                        ▸
                      </span>
                      {group.label}
                      {group.key === null && (
                        <span className={styles.gap}> no {dimensionNoun(dimension)} on record</span>
                      )}
                    </div>

                    <div className={styles.track}>
                      <div className={styles.fill} style={{ width: barWidth(group) }} />
                    </div>

                    {showAmount && <div className={styles.num}>{usd(group.amount, 2)}</div>}
                    <div className={cx(styles.num, styles.muted)}>{count(group.people.length)}</div>
                  </button>

                  {open && (
                    <div className={styles.people}>
                      {group.people.map((person) => (
                        <div key={person.login} className={styles.personRow}>
                          <div className={styles.person}>
                            <span className={styles.personName}>{person.displayName}</span>
                            <span className={styles.login}>{person.login}</span>
                          </div>
                          <div className={cx(styles.dept, styles.muted)}>
                            {person.department ?? EMPTY}
                          </div>
                          <div className={styles.detail} title={detailLabel}>
                            {person.detail}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {page.count > 1 && (
            <div className={styles.footer}>
              {/* Paging is over groups, so the count has to say so — "13–24 of
                  212" beside a person-shaped table would read as people. */}
              <span className={styles.pageLabel}>{page.label} groups</span>
              <button
                type="button"
                className={styles.pageButton}
                disabled={page.index === 0}
                onClick={() => setPageIndex(page.index - 1)}
              >
                Prev
              </button>
              <button
                type="button"
                className={styles.pageButton}
                disabled={page.index >= page.count - 1}
                onClick={() => setPageIndex(page.index + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** What the unassigned bucket is missing, in the words of the current grouping. */
function dimensionNoun(dimension: CostCentreDimension): string {
  if (dimension === 'department') return 'department';
  return dimension === 'b1Manager' ? 'B-1 manager' : 'B-2 manager';
}
