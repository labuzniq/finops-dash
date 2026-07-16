import { EDITORS } from '@dash/shared';
import type { Editor, RangeDays } from '@dash/shared';
import type { RefreshJob } from '@dash/shared';
import { relativeTime } from '../lib/format.js';
import { ALL } from '../lib/metrics/filter.js';
import type { EditorFilter, LanguageFilter } from '../lib/metrics/filter.js';
import styles from './FilterBar.module.css';

interface FilterBarProps {
  range: RangeDays;
  /** Range options actually backed by data — capped to available history. */
  availableRanges: readonly RangeDays[];
  editor: EditorFilter;
  language: LanguageFilter;
  /** Distinct languages in the roster, for the language select. */
  languages: readonly string[];
  search: string;
  latestJob: RefreshJob | null;
  isRefreshing: boolean;
  onRangeChange: (range: RangeDays) => void;
  onEditorChange: (editor: EditorFilter) => void;
  onLanguageChange: (language: LanguageFilter) => void;
  onSearchChange: (search: string) => void;
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

export function FilterBar({
  range,
  availableRanges,
  editor,
  language,
  languages,
  search,
  latestJob,
  isRefreshing,
  onRangeChange,
  onEditorChange,
  onLanguageChange,
  onSearchChange,
}: FilterBarProps) {
  return (
    <div className={styles.filterBar}>
      <div className={styles.segmented} role="group" aria-label="Date range">
        {availableRanges.map((days) => (
          <button
            key={days}
            type="button"
            className={`${styles.segment} ${days === range ? styles.segmentActive : ''}`}
            aria-pressed={days === range}
            onClick={() => onRangeChange(days)}
          >
            {days}d
          </button>
        ))}
      </div>

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
