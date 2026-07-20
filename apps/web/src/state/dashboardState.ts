import type { DateRange } from '@dash/shared';
import { ALL } from '../lib/metrics/filter.js';
import type { EditorFilter, LanguageFilter } from '../lib/metrics/filter.js';
import type { SortDirection, SortKey } from '../lib/metrics/table.js';

/**
 * All page state in one reducer. Everything the dashboard shows is derived
 * from this plus the fetched data — no metric is ever stored.
 */

export type ModalTab = 'sources' | 'csv' | 'manual';
export type TableView = 'users' | 'models';

export interface DashboardState {
  range: DateRange;
  editor: EditorFilter;
  language: LanguageFilter;
  search: string;
  sortKey: SortKey;
  sortDirection: SortDirection;
  page: number;
  /** Which breakdown the main table shows: per-user or per-model. */
  tableView: TableView;
  /**
   * Selected metric per merged usage chart, keyed by section
   * (`orgDailyActivity`, `orgLoc`, `ide`, `language`, `feature`, `model`).
   * Sparse — a missing key means the chart's first variant.
   */
  usageMetric: Record<string, string>;
  modalOpen: boolean;
  modalTab: ModalTab;
}

export const initialDashboardState: DashboardState = {
  range: { kind: 'preset', days: 28 },
  editor: ALL,
  language: ALL,
  search: '',
  sortKey: 'cost',
  sortDirection: -1,
  page: 0,
  tableView: 'users',
  usageMetric: {},
  modalOpen: false,
  modalTab: 'sources',
};

export type DashboardAction =
  | { type: 'setRange'; range: DateRange }
  | { type: 'setEditor'; editor: EditorFilter }
  | { type: 'setLanguage'; language: LanguageFilter }
  | { type: 'setSearch'; search: string }
  | { type: 'toggleSort'; key: SortKey }
  | { type: 'setPage'; page: number }
  | { type: 'setTableView'; view: TableView }
  | { type: 'setUsageMetric'; section: string; metric: string }
  | { type: 'openModal' }
  | { type: 'closeModal' }
  | { type: 'setModalTab'; tab: ModalTab };

export function dashboardReducer(state: DashboardState, action: DashboardAction): DashboardState {
  switch (action.type) {
    // Any change to what's being shown resets pagination — page 7 of the old
    // result set means nothing in the new one.
    case 'setRange':
      return { ...state, range: action.range, page: 0 };
    case 'setEditor':
      return { ...state, editor: action.editor, page: 0 };
    case 'setLanguage':
      return { ...state, language: action.language, page: 0 };
    case 'setSearch':
      return { ...state, search: action.search, page: 0 };

    // Re-clicking the active column flips direction; a new column starts descending.
    case 'toggleSort':
      return state.sortKey === action.key
        ? { ...state, sortDirection: state.sortDirection === -1 ? 1 : -1 }
        : { ...state, sortKey: action.key, sortDirection: -1, page: 0 };

    case 'setPage':
      return { ...state, page: action.page };
    case 'setTableView':
      return { ...state, tableView: action.view };
    case 'setUsageMetric':
      return {
        ...state,
        usageMetric: { ...state.usageMetric, [action.section]: action.metric },
      };
    case 'openModal':
      return { ...state, modalOpen: true };
    case 'closeModal':
      return { ...state, modalOpen: false };
    case 'setModalTab':
      return { ...state, modalTab: action.tab };
  }
}
