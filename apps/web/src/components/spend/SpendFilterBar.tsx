import { useMemo } from 'react';
import { RANGE_DAYS } from '@dash/shared';
import type { DateRange, SpendPerson } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import type { SpendFilters, SpendScopeField } from '../../lib/metrics/spendFilter.js';
import { EMPTY_SPEND_FILTERS, personMatches } from '../../lib/metrics/spendFilter.js';
import { DateRangePicker } from '../DateRangePicker.js';
import type { FilterOption } from './FilterCombobox.js';
import { FilterCombobox } from './FilterCombobox.js';
import styles from './SpendFilterBar.module.css';

/**
 * The spend section's own controls: its date window (billing data trails the
 * usage series, so it never shares the usage range) and the org-structure
 * filters — department, B-1, B-2, a single user, and the "Unmapped" group.
 * All four scope filters are the same searchable combobox, and their option
 * lists cascade: each offers only the values that can coexist with the other
 * active filters, so no pick can ever produce an empty chart. Every derivation
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

/**
 * Distinct non-null values of one identity field, sorted, as combobox options —
 * drawn only from the people who pass every *other* active filter, so each
 * list shows just the combinations that exist.
 */
function options(
  people: readonly SpendPerson[],
  field: 'department' | 'b1Manager' | 'b2Manager',
  filters: SpendFilters,
): FilterOption[] {
  const values = new Set<string>();
  for (const person of people) {
    if (!personMatches(person, filters, field)) continue;
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
  const departments = useMemo(() => options(people, 'department', filters), [people, filters]);
  const b1Managers = useMemo(() => options(people, 'b1Manager', filters), [people, filters]);
  const b2Managers = useMemo(() => options(people, 'b2Manager', filters), [people, filters]);
  /**
   * Same cascade for the user search. The keywords let the search match a raw
   * login, which the label of a mapped person only contains mid-string.
   */
  const users = useMemo(
    () =>
      people
        .filter((person) => personMatches(person, filters, 'login'))
        .sort(
          (a, b) => a.displayName.localeCompare(b.displayName) || a.login.localeCompare(b.login),
        )
        .map((person) => ({
          value: person.login,
          label: personLabel(person),
          keywords: [person.displayName, person.login],
        })),
    [people, filters],
  );

  const pickerBounds = useMemo(() => {
    const today = new Date();
    const earliest = new Date(today.getTime() - (PICKER_WINDOW_DAYS - 1) * 86_400_000);
    return { min: earliest.toISOString().slice(0, 10), max: today.toISOString().slice(0, 10) };
  }, []);

  /**
   * Changing one filter can orphan another — pick a department the selected
   * B-1 manager doesn't sit under and the combination matches nobody. The
   * just-changed field wins: every other selection must still be able to
   * coexist with it (and with each other), or it is dropped.
   */
  const changeScope = (patch: Partial<SpendFilters>) => {
    const next = { ...filters, ...patch };
    const result: Partial<SpendFilters> = { ...patch };
    const kept: SpendScopeField[] = (
      ['department', 'b1Manager', 'b2Manager', 'login'] as const
    ).filter((field) => !(field in patch) && next[field] !== null);

    // First pass: each kept selection must coexist with the changed fields alone.
    const changed: SpendFilters = { ...EMPTY_SPEND_FILTERS, ...patch, unmappedOnly: next.unmappedOnly };
    for (const field of kept) {
      const pair: SpendFilters = { ...changed, [field]: next[field] };
      if (!people.some((person) => personMatches(person, pair))) {
        next[field] = null;
        result[field] = null;
      }
    }

    // Second pass: survivors can be pairwise-valid yet jointly empty — thin
    // from the most specific selection up until somebody matches everything.
    for (const field of [...kept].reverse()) {
      if (next[field] === null) continue;
      if (people.some((person) => personMatches(person, next))) break;
      next[field] = null;
      result[field] = null;
    }

    onFiltersChange(result);
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
