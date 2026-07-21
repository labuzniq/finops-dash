import { useMemo } from 'react';
import type { Dispatch } from 'react';
import type { BillingRow, ModelSpendRow, SpendPerson } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { rangeLabel } from '../../lib/format.js';
import {
  modelBreakdown,
  sortSpendUserRows,
  spendKpis,
  spendTrend,
  spendUserRows,
  wastedSpend,
} from '../../lib/metrics/spend.js';
import { applySpendFilter, filterLogins } from '../../lib/metrics/spendFilter.js';
import { paginate } from '../../lib/metrics/table.js';
import { spendRangeBounds, useSpendData } from '../../hooks/useSpendData.js';
import type { DashboardAction, DashboardState } from '../../state/dashboardState.js';
import { ModelSpendChart } from './ModelSpendChart.js';
import { SpendFilterBar } from './SpendFilterBar.js';
import { SpendKpiRow } from './SpendKpiRow.js';
import { SpendTrendCard } from './SpendTrendCard.js';
import { SpendUserTable } from './SpendUserTable.js';
import { WastedSpendCard } from './WastedSpendCard.js';
import styles from './SpendSection.module.css';

/**
 * The spend section — real money from the imported billing reports, one
 * payload per range, everything below it derived client-side. The filters
 * narrow the login set first, so KPIs, trend, model breakdown and the user
 * table always agree on who is being counted.
 */

const EMPTY_BILLING: BillingRow[] = [];
const EMPTY_MODELS: ModelSpendRow[] = [];
const EMPTY_PEOPLE: SpendPerson[] = [];

interface SpendSectionProps {
  state: DashboardState;
  dispatch: Dispatch<DashboardAction>;
}

export function SpendSection({ state, dispatch }: SpendSectionProps) {
  const spendQuery = useSpendData(state.spendRange);
  const payload = spendQuery.data;

  // The same bounds the fetch used, so the trend's zero-fill spine and the
  // API response agree on the calendar days in play.
  const bounds = useMemo(() => spendRangeBounds(state.spendRange), [state.spendRange]);

  const people = payload?.people ?? EMPTY_PEOPLE;
  const logins = useMemo(
    () => filterLogins(people, state.spendFilters),
    [people, state.spendFilters],
  );
  const billing = useMemo(
    () => applySpendFilter(payload?.billingRows ?? EMPTY_BILLING, logins),
    [payload, logins],
  );
  const models = useMemo(
    () => applySpendFilter(payload?.modelRows ?? EMPTY_MODELS, logins),
    [payload, logins],
  );

  const kpis = useMemo(() => spendKpis(billing), [billing]);
  const trend = useMemo(() => spendTrend(billing, bounds.from, bounds.to), [billing, bounds]);
  const breakdown = useMemo(() => modelBreakdown(models), [models]);
  const userRows = useMemo(() => spendUserRows(billing, models, people), [billing, models, people]);

  const sorted = useMemo(
    () => sortSpendUserRows(userRows, state.spendSortKey, state.spendSortDirection),
    [userRows, state.spendSortKey, state.spendSortDirection],
  );
  const page = useMemo(() => paginate(sorted, state.spendPage), [sorted, state.spendPage]);

  // Derived from the same filtered rows the table shows, so the rail can never
  // disagree with the KPIs about who is being counted.
  const waste = useMemo(() => wastedSpend(userRows), [userRows]);

  const label = rangeLabel(state.spendRange);

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.heading}>Spend</h2>
        <div className={styles.note}>billing usage reports · licences from Report 2 only</div>
      </div>

      <SpendFilterBar
        range={state.spendRange}
        filters={state.spendFilters}
        people={people}
        onRangeChange={(range) => dispatch({ type: 'setSpendRange', range })}
        onFiltersChange={(filters) => dispatch({ type: 'setSpendFilters', filters })}
      />

      {spendQuery.error && (
        <div className={cx(styles.status, styles.error)}>
          Could not load spend data: {spendQuery.error.message}
        </div>
      )}

      {!spendQuery.error && spendQuery.isPending && (
        <div className={styles.status}>Loading spend data…</div>
      )}

      {!spendQuery.error && !spendQuery.isPending && (
        <>
          <SpendKpiRow kpis={kpis} rangeLabel={label} />

          <div className={styles.split}>
            <SpendTrendCard trend={trend} subtitle={label} />
            <WastedSpendCard waste={waste} rangeLabel={label} />
          </div>

          <SpendUserTable
            page={page}
            sortKey={state.spendSortKey}
            sortDirection={state.spendSortDirection}
            onSort={(key) => dispatch({ type: 'toggleSpendSort', key })}
            onPageChange={(pageIndex) => dispatch({ type: 'setSpendPage', page: pageIndex })}
          />

          <ModelSpendChart rows={breakdown} />
        </>
      )}
    </section>
  );
}
