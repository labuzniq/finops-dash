import { useReducer, useState } from 'react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { rangeDayCount } from '@dash/shared';
import { cx } from './lib/cx.js';
import { downloadSeatsCsv } from './lib/exportCsv.js';
import {
  useLatestJob,
  useReportImports,
  useSeats,
  useSyncJob,
} from './hooks/useCopilotData.js';
import { useDashboardMetrics } from './hooks/useDashboardMetrics.js';
import { useTheme } from './hooks/useTheme.js';
import { dashboardReducer, initialDashboardState } from './state/dashboardState.js';
import { Sidebar } from './components/Sidebar.js';
import type { AppView } from './components/Sidebar.js';
import { ClaudeCodePage } from './components/claude/ClaudeCodePage.js';
import { CopilotAnalyticsPage } from './components/copilot/CopilotAnalyticsPage.js';
import { ImportsPage } from './components/imports/ImportsPage.js';
import { DataSourcesPage } from './components/sources/DataSourcesPage.js';
import { SpendSection } from './components/spend/SpendSection.js';
import { TopBar } from './components/TopBar.js';
import styles from './App.module.css';

/** Nocturne ships two accents; blurple is the product's own. */
const ACCENT_CLASS = 'acc-blurple';

const EMPTY_SEATS = [] as const;

/** Pages that bring their own header; the Copilot top bar is not theirs. */
const STANDALONE_VIEWS: ReadonlySet<AppView> = new Set<AppView>([
  'claude-code',
  'data-sources',
  'imports',
]);

export function App() {
  const [state, dispatch] = useReducer(dashboardReducer, initialDashboardState);
  const [view, setView] = useState<AppView>('copilot-spend');
  const { isDark, toggle } = useTheme();

  const queryClient = useQueryClient();
  const seatsQuery = useSeats();
  const latestJobQuery = useLatestJob('copilot');

  // The jobs live here rather than on the pages that start them. Each hook
  // polls its job — or runs its upload — from local state, and a page that
  // unmounts mid-run takes that state with it, so nothing would ever invalidate
  // the queries the run feeds. Navigation is now free of the job.
  const copilot = useSyncJob('copilot');
  const billing = useSyncJob('billing');
  const jira = useSyncJob('jira');
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

      {STANDALONE_VIEWS.has(view) && (
        <main className={styles.main}>
          {view === 'claude-code' && <ClaudeCodePage />}
          {view === 'data-sources' && (
            <DataSourcesPage copilot={copilot} billing={billing} jira={jira} />
          )}
          {view === 'imports' && <ImportsPage imports={imports} />}
        </main>
      )}

      {!STANDALONE_VIEWS.has(view) && (
        <main className={styles.main}>
          <TopBar
            seatCount={seatsQuery.data?.length ?? 0}
            isDark={isDark}
            isReloading={isReloading}
            onToggleTheme={toggle}
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
              isRefreshing={copilot.isRunning}
            />
          )}
        </main>
      )}
    </div>
  );
}
