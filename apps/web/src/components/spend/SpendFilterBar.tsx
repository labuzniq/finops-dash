import { useMemo } from 'react';
import { RANGE_DAYS } from '@dash/shared';
import type { DateRange, SpendPerson } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import type { SpendFilters } from '../../lib/metrics/spendFilter.js';
import { DateRangePicker } from '../DateRangePicker.js';
import type { FilterOption } from './FilterCombobox.js';
import { FilterCombobox } from './FilterCombobox.js';
import styles from './SpendFilterBar.module.css';

/**
 * The spend section's own controls: its date window (billing data trails the
 * usage series, so it never shares the usage range) and the org-structure
 * filters — department, B-1, B-2, a single user, and the "Unmapped" group.
 * All four scope filters are the same searchable combobox. Every derivation
 * downstream recomputes from whatever survives these.
 */

/** The custom picker reaches back a year — billing history beyond that is unlikely. */
const PICKER_WINDOW_DAYS = 365;

interface SpendFilterBarProps {
  range: DateRange;
  filters: SpendFilters;
  people: readonly SpendPerson[];
  onRangeChange: (range: DateRange) => void;
  onFiltersChange: (filters: Partial<SpendFilters>) => void;
}

/** Distinct non-null values of one identity field, sorted, as combobox options. */
function options(
  people: readonly SpendPerson[],
  field: 'department' | 'b1Manager' | 'b2Manager',
): FilterOption[] {
  const values = new Set<string>();
  for (const person of people) {
    const value = person[field];
    if (value !== null && value !== '') values.add(value);
  }
  return [...values].sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value }));
}

/** Unmapped people have no display name, so the login stands alone. */
function personLabel(person: SpendPerson): string {
  return person.mapped ? `${person.displayName} (${person.login})` : person.login;
}

export function SpendFilterBar({
  range,
  filters,
  people,
  onRangeChange,
  onFiltersChange,
}: SpendFilterBarProps) {
  const departments = useMemo(() => options(people, 'department'), [people]);
  const b1Managers = useMemo(() => options(people, 'b1Manager'), [people]);
  const b2Managers = useMemo(() => options(people, 'b2Manager'), [people]);
  /**
   * The user search only offers people who survive the other filters, so a
   * pick can never produce an empty chart. The keywords let the search match
   * a raw login, which the label of a mapped person only contains mid-string.
   */
  const users = useMemo(
    () =>
      people
        .filter((person) => {
          if (filters.department !== null && person.department !== filters.department) return false;
          if (filters.b1Manager !== null && person.b1Manager !== filters.b1Manager) return false;
          if (filters.b2Manager !== null && person.b2Manager !== filters.b2Manager) return false;
          if (filters.unmappedOnly && person.mapped) return false;
          return true;
        })
        .sort(
          (a, b) => a.displayName.localeCompare(b.displayName) || a.login.localeCompare(b.login),
        )
        .map((person) => ({
          value: person.login,
          label: personLabel(person),
          keywords: [person.displayName, person.login],
        })),
    [people, filters.department, filters.b1Manager, filters.b2Manager, filters.unmappedOnly],
  );

  const pickerBounds = useMemo(() => {
    const today = new Date();
    const earliest = new Date(today.getTime() - (PICKER_WINDOW_DAYS - 1) * 86_400_000);
    return { min: earliest.toISOString().slice(0, 10), max: today.toISOString().slice(0, 10) };
  }, []);

  /**
   * Narrowing by department or manager can strip the selected user out of the
   * roster; dropping the stale login keeps the two controls consistent rather
   * than leaving a filter that matches nobody.
   */
  const changeScope = (patch: Partial<SpendFilters>) => {
    const next = { ...filters, ...patch };
    const selected =
      next.login === null ? null : people.find((person) => person.login === next.login);
    const stale =
      selected !== undefined &&
      selected !== null &&
      ((next.department !== null && selected.department !== next.department) ||
        (next.b1Manager !== null && selected.b1Manager !== next.b1Manager) ||
        (next.b2Manager !== null && selected.b2Manager !== next.b2Manager) ||
        (next.unmappedOnly && selected.mapped));

    onFiltersChange(stale ? { ...patch, login: null } : patch);
  };

  return (
    <div className={styles.filterBar}>
      <div className={styles.segmented} role="group" aria-label="Spend date range">
        {RANGE_DAYS.map((days) => {
          const active = range.kind === 'preset' && days === range.days;
          return (
            <button
              key={days}
              type="button"
              className={cx(styles.segment, active && styles.segmentActive)}
              aria-pressed={active}
              onClick={() => onRangeChange({ kind: 'preset', days })}
            >
              {days}d
            </button>
          );
        })}
        <DateRangePicker
          range={range}
          min={pickerBounds.min}
          max={pickerBounds.max}
          onApply={(from, to) => onRangeChange({ kind: 'custom', from, to })}
        />
      </div>

      <FilterCombobox
        options={departments}
        value={filters.department}
        noun="department"
        onChange={(department) => changeScope({ department })}
      />

      <FilterCombobox
        options={b1Managers}
        value={filters.b1Manager}
        noun="B-1 manager"
        onChange={(b1Manager) => changeScope({ b1Manager })}
      />

      <FilterCombobox
        options={b2Managers}
        value={filters.b2Manager}
        noun="B-2 manager"
        onChange={(b2Manager) => changeScope({ b2Manager })}
      />

      <FilterCombobox
        options={users}
        value={filters.login}
        noun="user"
        onChange={(login) => onFiltersChange({ login })}
      />

      <button
        type="button"
        className={cx(styles.unmapped, filters.unmappedOnly && styles.unmappedActive)}
        aria-pressed={filters.unmappedOnly}
        onClick={() => changeScope({ unmappedOnly: !filters.unmappedOnly })}
      >
        Unmapped
      </button>
    </div>
  );
}
