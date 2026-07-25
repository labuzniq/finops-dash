import { useReducer, useState } from 'react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { rangeDayCount } from '@dash/shared';
import { cx } from './lib/cx.js';
import { downloadSeatsCsv } from './lib/exportCsv.js';
import {
  useBillingSync,
  useJiraSync,
  useLatestBillingJob,
  useLatestJiraJob,
  useLatestRefreshJob,
  useRefresh,
  useReportImports,
  useSeats,
} from './hooks/useCopilotData.js';
import { useDashboardMetrics } from './hooks/useDashboardMetrics.js';
import { useTheme } from './hooks/useTheme.js';
import { dashboardReducer, initialDashboardState } from './state/dashboardState.js';
import { Sidebar } from './components/Sidebar.js';
import type { AppView } from './components/Sidebar.js';
import { ClaudeCodePage } from './components/claude/ClaudeCodePage.js';
import { CopilotAnalyticsPage } from './components/copilot/CopilotAnalyticsPage.js';
import { SpendSection } from './components/spend/SpendSection.js';
import { TopBar } from './components/TopBar.js';
import { AddDataModal } from './components/modal/AddDataModal.js';
import styles from './App.module.css';

/** Nocturne ships two accents; blurple is the product's own. */
const ACCENT_CLASS = 'acc-blurple';

const EMPTY_SEATS = [] as const;

export function App() {
  const [state, dispatch] = useReducer(dashboardReducer, initialDashboardState);
  const [view, setView] = useState<AppView>('copilot-spend');
  const { isDark, toggle } = useTheme();

  const queryClient = useQueryClient();
  const seatsQuery = useSeats();
  const latestJobQuery = useLatestRefreshJob();
  const { refresh, isRunning, error: refreshError } = useRefresh();
  const billingJobQuery = useLatestBillingJob();
  const {
    sync: syncBilling,
    isRunning: isBillingSyncing,
    error: billingError,
  } = useBillingSync();
  const jiraJobQuery = useLatestJiraJob();
  const { sync: syncJira, isRunning: isJiraSyncing, error: jiraError } = useJiraSync();
  const imports = useReportImports();

  // The reload button refetches every server query in place — same data
  // pipeline as a page refresh, without losing filters or scroll position.
  const isReloading = useIsFetching() > 0;
  const reload = () => void queryClient.invalidateQueries();

  // Computed here rather than in the analytics page because the top bar's
  // CSV export needs the filtered seat list on both Copilot pages.
  const metrics = useDashboardMetrics(seatsQuery.data ?? EMPTY_SEATS, state);

  const rangeDays = rangeDayCount(state.range);

  return (
    <div className={cx('theme', ACCENT_CLASS, isDark && 'dark', styles.shell)}>
      <Sidebar activeView={view} onNavigate={setView} />

      {view === 'claude-code' && (
        <main className={styles.main}>
          <ClaudeCodePage />
        </main>
      )}

      {view !== 'claude-code' && (
        <main className={styles.main}>
          <TopBar
            seatCount={seatsQuery.data?.length ?? 0}
            isDark={isDark}
            isReloading={isReloading}
            onToggleTheme={toggle}
            onAddData={() => dispatch({ type: 'openModal' })}
            onExportCsv={() => downloadSeatsCsv(metrics.filteredSeats, rangeDays)}
            onReload={reload}
          />

          {view === 'copilot-spend' ? (
            <SpendSection state={state} dispatch={dispatch} />
          ) : (
            <CopilotAnalyticsPage
              state={state}
              dispatch={dispatch}
              metrics={metrics}
              latestJob={latestJobQuery.data ?? null}
              isRefreshing={isRunning}
            />
          )}
        </main>
      )}

      {state.modalOpen && (
        <AddDataModal
          tab={state.modalTab}
          latestJob={latestJobQuery.data ?? null}
          isRefreshing={isRunning}
          refreshError={refreshError}
          billingJob={billingJobQuery.data ?? null}
          isBillingSyncing={isBillingSyncing}
          billingError={billingError}
          jiraJob={jiraJobQuery.data ?? null}
          isJiraSyncing={isJiraSyncing}
          jiraError={jiraError}
          imports={imports}
          onTabChange={(tab) => dispatch({ type: 'setModalTab', tab })}
          onClose={() => {
            imports.reset();
            dispatch({ type: 'closeModal' });
          }}
          onRefresh={refresh}
          onBillingSync={syncBilling}
          onJiraSync={syncJira}
        />
      )}
    </div>
  );
}
