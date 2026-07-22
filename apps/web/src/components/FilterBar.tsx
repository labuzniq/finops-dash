import { useMemo } from 'react';
import { EDITORS } from '@dash/shared';
import type { CopilotSeat, DateRange, Editor, RangeDays } from '@dash/shared';
import type { RefreshJob } from '@dash/shared';
import { relativeTime } from '../lib/format.js';
import { ALL } from '../lib/metrics/filter.js';
import type { EditorFilter, LanguageFilter } from '../lib/metrics/filter.js';
import {
  cascadeScopeChange,
  personMatches,
  scopeOptions,
} from '../lib/metrics/spendFilter.js';
import type { SpendFilters } from '../lib/metrics/spendFilter.js';
import { DateRangePicker } from './DateRangePicker.js';
import { FilterCombobox } from './spend/FilterCombobox.js';
import styles from './FilterBar.module.css';

interface FilterBarProps {
  range: DateRange;
  /** Range options actually backed by data — capped to available history. */
  availableRanges: readonly RangeDays[];
  /** Oldest and newest ISO dates the fetched series covers — picker bounds. */
  minDate: string;
  maxDate: string;
  editor: EditorFilter;
  language: LanguageFilter;
  /** Distinct languages in the roster, for the language select. */
  languages: readonly string[];
  search: string;
  /** The full roster — the org-structure comboboxes cascade over it. */
  seats: readonly CopilotSeat[];
  /** Org-structure scope, spend-page semantics (see `SeatFilters.scope`). */
  scope: SpendFilters;
  latestJob: RefreshJob | null;
  isRefreshing: boolean;
  onRangeChange: (range: DateRange) => void;
  onEditorChange: (editor: EditorFilter) => void;
  onLanguageChange: (language: LanguageFilter) => void;
  onSearchChange: (search: string) => void;
  onScopeChange: (filters: Partial<SpendFilters>) => void;
}

/** Mirrors the live sync state rather than hardcoding the prototype's "2h ago". */
function syncLabel(job: RefreshJob | null, isRefreshing: boolean): string {
  if (isRefreshing || job?.status === 'running' || job?.status === 'pending') {
    return 'usage metrics API · syncing…';
  }
  if (job?.status === 'failed') return 'usage metrics API · sync failed';
  if (job?.finishedAt) return `usage metrics API · synced ${relativeTime(job.finishedAt)}`;
  return 'usage metrics API · not yet synced';
}

/** Unmapped seats have no display name, so the login stands alone. */
function seatLabel(seat: CopilotSeat): string {
  return seat.mapped ? `${seat.displayName} (${seat.login})` : seat.login;
}

export function FilterBar({
  range,
  availableRanges,
  minDate,
  maxDate,
  editor,
  language,
  languages,
  search,
  seats,
  scope,
  latestJob,
  isRefreshing,
  onRangeChange,
  onEditorChange,
  onLanguageChange,
  onSearchChange,
  onScopeChange,
}: FilterBarProps) {
  // Same cascading option lists as the spend bar — each combobox offers only
  // the values that can coexist with the other active scope filters.
  const departments = useMemo(() => scopeOptions(seats, 'department', scope), [seats, scope]);
  const b1Managers = useMemo(() => scopeOptions(seats, 'b1Manager', scope), [seats, scope]);
  const b2Managers = useMemo(() => scopeOptions(seats, 'b2Manager', scope), [seats, scope]);
  const users = useMemo(
    () =>
      seats
        .filter((seat) => personMatches(seat, scope, 'login'))
        .slice()
        .sort(
          (a, b) => a.displayName.localeCompare(b.displayName) || a.login.localeCompare(b.login),
        )
        .map((seat) => ({
          value: seat.login,
          label: seatLabel(seat),
          keywords: [seat.displayName, seat.login],
        })),
    [seats, scope],
  );

  const changeScope = (patch: Partial<SpendFilters>) => {
    onScopeChange(cascadeScopeChange(seats, scope, patch));
  };

  return (
    <div className={styles.filterBar}>
      <div className={styles.segmented} role="group" aria-label="Date range">
        {availableRanges.map((days) => {
          const active = range.kind === 'preset' && days === range.days;
          return (
            <button
              key={days}
              type="button"
              className={`${styles.segment} ${active ? styles.segmentActive : ''}`}
              aria-pressed={active}
              onClick={() => onRangeChange({ kind: 'preset', days })}
            >
              {days}d
            </button>
          );
        })}
        <DateRangePicker
          range={range}
          min={minDate}
          max={maxDate}
          onApply={(from, to) => onRangeChange({ kind: 'custom', from, to })}
        />
      </div>

      <FilterCombobox
        options={departments}
        value={scope.department}
        noun="department"
        onChange={(department) => changeScope({ department })}
      />

      <FilterCombobox
        options={b1Managers}
        value={scope.b1Manager}
        noun="B-1 manager"
        onChange={(b1Manager) => changeScope({ b1Manager })}
      />

      <FilterCombobox
        options={b2Managers}
        value={scope.b2Manager}
        noun="B-2 manager"
        onChange={(b2Manager) => changeScope({ b2Manager })}
      />

      <FilterCombobox
        options={users}
        value={scope.login}
        noun="user"
        onChange={(login) => onScopeChange({ login })}
      />

      <button
        type="button"
        className={`${styles.unmapped} ${scope.unmappedOnly ? styles.unmappedActive : ''}`}
        aria-pressed={scope.unmappedOnly}
        onClick={() => changeScope({ unmappedOnly: !scope.unmappedOnly })}
      >
        Unmapped
      </button>

      <select
        className={styles.select}
        value={editor}
        aria-label="Filter by editor"
        onChange={(event) => onEditorChange(event.target.value as EditorFilter)}
      >
        <option value={ALL}>All editors</option>
        {EDITORS.map((option: Editor) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>

      <select
        className={styles.select}
        value={language}
        aria-label="Filter by language"
        onChange={(event) => onLanguageChange(event.target.value as LanguageFilter)}
      >
        <option value={ALL}>All languages</option>
        {languages.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>

      <input
        className={styles.search}
        value={search}
        placeholder="Search user or login…"
        aria-label="Search user or login"
        onChange={(event) => onSearchChange(event.target.value)}
      />

      <div className={styles.spacer} />
      <div className={styles.syncNote}>{syncLabel(latestJob, isRefreshing)}</div>
    </div>
  );
}
