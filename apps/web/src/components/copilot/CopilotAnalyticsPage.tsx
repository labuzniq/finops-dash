import { useMemo } from 'react';
import type { Dispatch } from 'react';
import { RANGE_DAYS, rangeDayCount } from '@dash/shared';
import type { RangeDays, RefreshJob } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { rangeLabel } from '../../lib/format.js';
import { useModels, useSeats, useUsage } from '../../hooks/useCopilotData.js';
import type { DashboardMetrics } from '../../hooks/useDashboardMetrics.js';
import { ALL, seatLanguages } from '../../lib/metrics/filter.js';
import { dateAxis } from '../../lib/metrics/usage.js';
import type { DashboardAction, DashboardState } from '../../state/dashboardState.js';
import { FilterBar } from '../FilterBar.js';
import { KpiRow } from '../KpiRow.js';
import { ModelTable } from '../ModelTable.js';
import { UserTable } from '../UserTable.js';
import { UtilizationDonut } from '../UtilizationDonut.js';
import { UsageSections } from '../usage/UsageSections.js';
import styles from './CopilotAnalyticsPage.module.css';

/**
 * The Copilot analytics page — seat usage and adoption, no money. Spend has
 * its own page (`SpendSection`); the split keeps each page answering one
 * question.
 *
 * Data comes straight from the shared react-query hooks — the spend page and
 * the top bar subscribe to the same caches, so switching pages never refetches.
 */

const EMPTY_SEATS = [] as const;
const EMPTY_MODELS = [] as const;

interface CopilotAnalyticsPageProps {
  state: DashboardState;
  dispatch: Dispatch<DashboardAction>;
  /** Computed once in App — the export button up in the top bar shares it. */
  metrics: DashboardMetrics;
  latestJob: RefreshJob | null;
  isRefreshing: boolean;
}

export function CopilotAnalyticsPage({
  state,
  dispatch,
  metrics,
  latestJob,
  isRefreshing,
}: CopilotAnalyticsPageProps) {
  const seatsQuery = useSeats();
  const usageQuery = useUsage();
  const modelsQuery = useModels(state.range);

  /** Distinct dates the usage history covers — the usage range's data extent. */
  const usageDates = useMemo(
    () => dateAxis(usageQuery.data?.orgDaily ?? []),
    [usageQuery.data],
  );

  // Range options are capped to the history the API actually returned; the
  // smallest range is always offered even with sparse data.
  const availableRanges = useMemo<RangeDays[]>(() => {
    const options = RANGE_DAYS.filter((r) => r <= Math.max(usageDates.length, RANGE_DAYS[0]));
    return options.length > 0 ? options : [RANGE_DAYS[0]];
  }, [usageDates]);

  // The custom picker can only reach dates the fetched history covers; before
  // data lands, fall back to the 90 days the usage request asks for.
  const seriesBounds = useMemo(() => {
    const first = usageDates[0];
    const last = usageDates[usageDates.length - 1];
    if (first !== undefined && last !== undefined) return { min: first, max: last };

    const today = new Date();
    const earliest = new Date(today.getTime() - 89 * 86_400_000);
    return { min: earliest.toISOString().slice(0, 10), max: today.toISOString().slice(0, 10) };
  }, [usageDates]);

  const rangeDays = rangeDayCount(state.range);

  const languages = useMemo(() => seatLanguages(seatsQuery.data ?? EMPTY_SEATS), [seatsQuery.data]);

  // Null when no seat filter is active — the usage charts then show the exact
  // org-report aggregates instead of a sum over every seat's daily rows.
  const filterActive =
    state.editor !== ALL || state.language !== ALL || state.search.trim() !== '';
  const filteredLogins = useMemo(
    () => (filterActive ? new Set(metrics.filteredSeats.map((seat) => seat.login)) : null),
    [filterActive, metrics.filteredSeats],
  );

  const isLoading = seatsQuery.isPending || usageQuery.isPending;
  const loadError = seatsQuery.error ?? usageQuery.error;

  return (
    <>
      <FilterBar
        range={state.range}
        availableRanges={availableRanges}
        minDate={seriesBounds.min}
        maxDate={seriesBounds.max}
        editor={state.editor}
        language={state.language}
        languages={languages}
        search={state.search}
        latestJob={latestJob}
        isRefreshing={isRefreshing}
        onRangeChange={(range) => dispatch({ type: 'setRange', range })}
        onEditorChange={(editor) => dispatch({ type: 'setEditor', editor })}
        onLanguageChange={(language) => dispatch({ type: 'setLanguage', language })}
        onSearchChange={(search) => dispatch({ type: 'setSearch', search })}
      />

      {loadError && (
        <div className={cx(styles.status, styles.error)}>
          Could not load Copilot data: {loadError.message}
        </div>
      )}

      {!loadError && isLoading && <div className={styles.status}>Loading Copilot data…</div>}

      {!loadError && !isLoading && (
        <>
          <KpiRow metrics={metrics} rangeDays={rangeDays} />

          {/* Above the grid, not inside its left column — nesting it there
              pushed the table down and broke the alignment with the donut. */}
          <div className={styles.viewToggle} role="group" aria-label="Table view">
            <button
              type="button"
              className={cx(styles.viewSegment, state.tableView === 'users' && styles.viewSegmentActive)}
              aria-pressed={state.tableView === 'users'}
              onClick={() => dispatch({ type: 'setTableView', view: 'users' })}
            >
              Per user
            </button>
            <button
              type="button"
              className={cx(styles.viewSegment, state.tableView === 'models' && styles.viewSegmentActive)}
              aria-pressed={state.tableView === 'models'}
              onClick={() => dispatch({ type: 'setTableView', view: 'models' })}
            >
              Per model
            </button>
          </div>

          <div className={styles.split}>
            {state.tableView === 'users' ? (
              <UserTable
                page={metrics.page}
                sortKey={state.sortKey}
                sortDirection={state.sortDirection}
                onSort={(key) => dispatch({ type: 'toggleSort', key })}
                onPageChange={(page) => dispatch({ type: 'setPage', page })}
              />
            ) : (
              <ModelTable models={modelsQuery.data ?? EMPTY_MODELS} rangeLabel={rangeLabel(state.range)} />
            )}

            <UtilizationDonut utilization={metrics.utilization} />
          </div>

          <UsageSections
            usage={usageQuery.data}
            seats={metrics.filteredSeats}
            filteredLogins={filteredLogins}
            range={state.range}
            usageMetric={state.usageMetric}
            onMetricChange={(section, metric) =>
              dispatch({ type: 'setUsageMetric', section, metric })
            }
          />
        </>
      )}
    </>
  );
}
