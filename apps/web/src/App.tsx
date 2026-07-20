import { useMemo, useReducer, useState } from 'react';
import { RANGE_DAYS, rangeDayCount } from '@dash/shared';
import type { RangeDays } from '@dash/shared';
import { cx } from './lib/cx.js';
import { downloadSeatsCsv } from './lib/exportCsv.js';
import { rangeLabel } from './lib/format.js';
import {
  useImport,
  useLatestRefreshJob,
  useModels,
  useRefresh,
  useSeats,
  useSpend,
  useUsage,
} from './hooks/useCopilotData.js';
import { useDashboardMetrics } from './hooks/useDashboardMetrics.js';
import { useTheme } from './hooks/useTheme.js';
import { seatLanguages } from './lib/metrics/filter.js';
import { dashboardReducer, initialDashboardState } from './state/dashboardState.js';
import { FilterBar } from './components/FilterBar.js';
import { KpiRow } from './components/KpiRow.js';
import { ModelTable } from './components/ModelTable.js';
import { Sidebar } from './components/Sidebar.js';
import type { AppView } from './components/Sidebar.js';
import { ClaudeCodePage } from './components/claude/ClaudeCodePage.js';
import { SpendTrendChart } from './components/SpendTrendChart.js';
import { TopBar } from './components/TopBar.js';
import { UserTable } from './components/UserTable.js';
import { UtilizationDonut } from './components/UtilizationDonut.js';
import { WastedSpendPanel } from './components/WastedSpendPanel.js';
import { UsageSections } from './components/usage/UsageSections.js';
import { AddDataModal } from './components/modal/AddDataModal.js';
import styles from './App.module.css';

/** Nocturne ships two accents; blurple is the product's own. */
const ACCENT_CLASS = 'acc-blurple';

const EMPTY_SEATS = [] as const;
const EMPTY_SERIES = [] as const;
const EMPTY_MODELS = [] as const;

export function App() {
  const [state, dispatch] = useReducer(dashboardReducer, initialDashboardState);
  const [view, setView] = useState<AppView>('copilot');
  const { isDark, toggle } = useTheme();

  const seatsQuery = useSeats();
  const spendQuery = useSpend();
  const usageQuery = useUsage();
  const modelsQuery = useModels(state.range);
  const latestJobQuery = useLatestRefreshJob();
  const { refresh, isRunning, error: refreshError } = useRefresh();
  const importState = useImport();

  const metrics = useDashboardMetrics(
    seatsQuery.data ?? EMPTY_SEATS,
    spendQuery.data ?? EMPTY_SERIES,
    state,
  );

  // Range options are capped to the history the API actually returned; the
  // smallest range is always offered even with sparse data.
  const availableRanges = useMemo<RangeDays[]>(() => {
    const days = spendQuery.data?.length ?? 0;
    const options = RANGE_DAYS.filter((r) => r <= Math.max(days, RANGE_DAYS[0]));
    return options.length > 0 ? options : [RANGE_DAYS[0]];
  }, [spendQuery.data]);

  // The custom picker can only reach dates the fetched series covers; before
  // data lands, fall back to the 90 days the series request asks for.
  const seriesBounds = useMemo(() => {
    const series = spendQuery.data;
    const first = series?.[0];
    const last = series?.[series.length - 1];
    if (first !== undefined && last !== undefined) return { min: first.date, max: last.date };

    const today = new Date();
    const earliest = new Date(today.getTime() - 89 * 86_400_000);
    return { min: earliest.toISOString().slice(0, 10), max: today.toISOString().slice(0, 10) };
  }, [spendQuery.data]);

  const rangeDays = rangeDayCount(state.range);

  const languages = useMemo(() => seatLanguages(seatsQuery.data ?? EMPTY_SEATS), [seatsQuery.data]);

  const isLoading = seatsQuery.isPending || spendQuery.isPending;
  const loadError = seatsQuery.error ?? spendQuery.error;

  return (
    <div className={cx('theme', ACCENT_CLASS, isDark && 'dark', styles.shell)}>
      <Sidebar activeView={view} onNavigate={setView} />

      {view === 'claude-code' && (
        <main className={styles.main}>
          <ClaudeCodePage />
        </main>
      )}

      {view === 'copilot' && (
      <main className={styles.main}>
        <TopBar
          seatCount={seatsQuery.data?.length ?? 0}
          isDark={isDark}
          onToggleTheme={toggle}
          onAddData={() => dispatch({ type: 'openModal' })}
          onExportCsv={() => downloadSeatsCsv(metrics.filteredSeats, rangeDays)}
        />

        <FilterBar
          range={state.range}
          availableRanges={availableRanges}
          minDate={seriesBounds.min}
          maxDate={seriesBounds.max}
          editor={state.editor}
          language={state.language}
          languages={languages}
          search={state.search}
          latestJob={latestJobQuery.data ?? null}
          isRefreshing={isRunning}
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

            <div className={styles.split}>
              <SpendTrendChart
                chart={metrics.chart}
                license={metrics.spend.license}
                premiumOverage={metrics.spend.premiumOverage}
                premiumRequestsUsed={metrics.premiumRequestsUsed}
              />
              <UtilizationDonut utilization={metrics.utilization} />
            </div>

            <div className={styles.split}>
              <div className={styles.tableColumn}>
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

                {state.tableView === 'users' ? (
                  <UserTable
                    page={metrics.page}
                    rangeDays={rangeDays}
                    sortKey={state.sortKey}
                    sortDirection={state.sortDirection}
                    onSort={(key) => dispatch({ type: 'toggleSort', key })}
                    onPageChange={(page) => dispatch({ type: 'setPage', page })}
                  />
                ) : (
                  <ModelTable models={modelsQuery.data ?? EMPTY_MODELS} rangeLabel={rangeLabel(state.range)} />
                )}
              </div>

              <WastedSpendPanel
                wastedMonthly={metrics.wastedMonthly}
                idleCount={metrics.idleCount}
                candidates={metrics.reclaim}
                // Idle seats are the ones never used or dormant 30d+ — surface
                // them by sorting the table to put the stalest first.
                onReviewIdleSeats={() => dispatch({ type: 'toggleSort', key: 'lastActive' })}
              />
            </div>

            <UsageSections
              usage={usageQuery.data}
              seats={metrics.filteredSeats}
              range={state.range}
              usageMetric={state.usageMetric}
              onMetricChange={(section, metric) =>
                dispatch({ type: 'setUsageMetric', section, metric })
              }
            />
          </>
        )}
      </main>
      )}

      {state.modalOpen && (
        <AddDataModal
          tab={state.modalTab}
          latestJob={latestJobQuery.data ?? null}
          isRefreshing={isRunning}
          refreshError={refreshError}
          importState={importState}
          onTabChange={(tab) => dispatch({ type: 'setModalTab', tab })}
          onClose={() => {
            importState.reset();
            dispatch({ type: 'closeModal' });
          }}
          onRefresh={refresh}
          onImport={importState.runImport}
        />
      )}
    </div>
  );
}
