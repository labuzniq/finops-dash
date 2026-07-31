import {
  crossTabSpendLogs,
  spendLogLatencyPercentile,
  SPEND_LOG_MAX_WINDOW_DAYS,
} from '@dash/shared';
import type {
  GatewayDailyPoint,
  GatewayDimension,
  GatewaySpendLog,
  GatewaySpendLogAxis,
  GatewaySpendLogCell,
  GatewaySpendLogs,
} from '@dash/shared';
import { shiftIso } from './gateway.js';

/**
 * The request-log sample, as the page reads it.
 *
 * Every other gateway card on this page derives from the *aggregate* layer,
 * which reports each dimension independently and therefore cannot answer a
 * joint question: "which models did this team spend its money on" is not a
 * slice of `/user/daily/activity`, it is a question that payload cannot
 * express. `crossTabSpendLogs` in `@dash/shared` is the answer, and this module
 * is what a table can draw of it — ranked, capped, and framed as the sample it
 * is.
 *
 * Three rules shape everything below, and all three come from the layer rather
 * than from the view:
 *
 *  - **It is a sample, never the ledger.** The rows may be switched off
 *    upstream (`disable_spend_logs`), are pruned on their own retention
 *    schedule, and are capped at `SPEND_LOG_ROW_CAP` per read. So there is no
 *    share-of-gateway-spend column anywhere here, every dollar is a floor, and
 *    the only completeness figure the module computes is in **requests** — the
 *    one counter the ledger also holds exactly, and a statement about how thin
 *    the sample is rather than about where the money went.
 *  - **A request may sit in several buckets on one axis.** `request_tags` is a
 *    list, so the cells legitimately sum past the sample. The cross-tab counts
 *    contributions in cells and requests in `attributedRequests`; this module
 *    passes both through rather than reconciling them, because they are
 *    different questions.
 *  - **The deployment is the point.** `model_id` is the only join between usage
 *    and `gateway_deployment_health`, so a `degraded` alias — some deployments
 *    failing, the alias still answering, invisible on every other card — is
 *    finally a number of requests and dollars here.
 *
 * Everything is pure; the window is a parameter and so is the ledger figure the
 * completeness note compares against.
 */

/**
 * How many rows and columns the matrix draws.
 *
 * Capped in the *view* rather than in `crossTabSpendLogs`, deliberately: the
 * shared function is not allowed to truncate, because dropping keys would leave
 * its axis totals disagreeing with the cells that survived. Here the dropped
 * keys are counted and reported instead.
 */
export const MATRIX_ROW_CAP = 8;
export const MATRIX_COLUMN_CAP = 6;

/** Below this many requests a deployment's own latency and failure rate are noise. */
export const DEPLOYMENT_MIN_REQUESTS = 20;

/** The window a request-log read covers — at most a week, by the route's own rule. */
export interface SpendLogWindow {
  from: string;
  to: string;
  days: number;
}

/**
 * The tail of what is on screen, at most `SPEND_LOG_MAX_WINDOW_DAYS` long.
 *
 * Read off the page's already-trimmed spine rather than off the range picker,
 * for the same reason the comparison window is: the picker's last day is today
 * and the aggregates end yesterday, so anchoring on the picker would ask the
 * proxy for a day the rest of the page is not showing. Anchoring on the spine
 * makes the sample evidence *for what is on screen*.
 *
 * Null on an empty spine — there is nothing to be evidence about.
 */
export function spendLogWindow(
  daily: readonly GatewayDailyPoint[],
  maxDays: number = SPEND_LOG_MAX_WINDOW_DAYS,
): SpendLogWindow | null {
  const last = daily[daily.length - 1];
  const first = daily[0];
  if (last === undefined || first === undefined) return null;

  const span = Math.max(1, Math.min(maxDays, daily.length));
  const from = shiftIso(last.date, -(span - 1));
  return {
    from: from < first.date ? first.date : from,
    to: last.date,
    days: span,
  };
}

/** One cell of the drawn matrix, plus what the heat scale needs. */
export interface MatrixCell extends GatewaySpendLogCell {
  /** Spend relative to the heaviest visible cell, 0..1 — a scale, not a share. */
  intensity: number;
}

/** One deployment's slice of one alias, over the sample. */
export interface DeploymentRow {
  /** The public alias, i.e. the key the `model` dimension is reported under. */
  model: string;
  /** `model_id`, or null on a proxy that sets none — where the join is impossible. */
  deploymentId: string | null;
  requests: number;
  failed: number;
  /** Failures over requests, 0..1. */
  failureRate: number;
  spend: number;
  /** Nearest-rank p95 over this deployment's timed requests, null when none are. */
  p95Ms: number | null;
  /** How many deployments the sample saw behind this alias. */
  siblings: number;
  /** Enough requests for the rate and the percentile to mean something. */
  material: boolean;
}

/** An alias the sample saw served by more than one deployment. */
export interface DeploymentSplit {
  model: string;
  rows: DeploymentRow[];
  /**
   * Percentage points between the best and worst material deployment's failure
   * rate. Null when fewer than two of them carry enough requests to compare.
   */
  failureSpread: number | null;
  /** Ratio of the slowest material p95 to the fastest, null on the same condition. */
  latencyRatio: number | null;
}

export interface SpendLogView {
  /** Whether `GET /api/gateway/logs` has answered. False while it is in flight. */
  answered: boolean;
  /** The proxy served the route at all — false most often means `disable_spend_logs`. */
  available: boolean;
  /** The read hit the row cap, so every total here is the head of the window. */
  truncated: boolean;
  window: SpendLogWindow | null;
  /** When the proxy was asked. Nothing is stored; this read is live. */
  fetchedAt: string | null;

  rowDimension: GatewayDimension;
  columnDimension: GatewayDimension;
  /** Ranked and capped; `hiddenRows` counts what did not fit. */
  rows: GatewaySpendLogAxis[];
  columns: GatewaySpendLogAxis[];
  hiddenRows: number;
  hiddenColumns: number;
  /** Only the cells inside the drawn grid, keyed `row\u0000column`. */
  cells: Map<string, MatrixCell>;

  sampleRequests: number;
  sampleSpend: number;
  attributedRequests: number;
  unattributedRequests: number;
  /**
   * Requests the *ledger* recorded over the same days, when the page could
   * supply it. The denominator of the one completeness figure this module
   * computes — in requests rather than dollars, because a share of gateway
   * spend derived from a sample is exactly what this layer must not render.
   */
  ledgerRequests: number | null;
  /** Sample requests over ledger requests, 0..1, null without a ledger figure. */
  sampledShare: number | null;

  latency: {
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    /** Requests carrying a duration — the percentiles' own denominator. */
    timed: number;
    untimed: number;
  };

  /** Every (alias, deployment) pair in the sample, heaviest first. */
  deployments: DeploymentRow[];
  /** Aliases served by more than one deployment — the join to health. */
  splits: DeploymentSplit[];
  /** Requests whose deployment the proxy did not name: the join is impossible for these. */
  unjoinableRequests: number;

  /** Answered, available, and carrying nothing. */
  isEmpty: boolean;
}

const EMPTY_LATENCY = { p50Ms: null, p95Ms: null, p99Ms: null, timed: 0, untimed: 0 };

export interface SpendLogOptions {
  rowDimension: GatewayDimension;
  columnDimension: GatewayDimension;
  /** The aggregate layer's request count for the same days, when it is known. */
  ledgerRequests?: number | null;
}

export function deriveSpendLogs(
  logs: GatewaySpendLogs | null | undefined,
  options: SpendLogOptions,
): SpendLogView {
  const { rowDimension, columnDimension } = options;
  const ledgerRequests = options.ledgerRequests ?? null;

  const base: SpendLogView = {
    answered: false,
    available: false,
    truncated: false,
    window: null,
    fetchedAt: null,
    rowDimension,
    columnDimension,
    rows: [],
    columns: [],
    hiddenRows: 0,
    hiddenColumns: 0,
    cells: new Map(),
    sampleRequests: 0,
    sampleSpend: 0,
    attributedRequests: 0,
    unattributedRequests: 0,
    ledgerRequests,
    sampledShare: null,
    latency: EMPTY_LATENCY,
    deployments: [],
    splits: [],
    unjoinableRequests: 0,
    isEmpty: false,
  };

  if (logs === null || logs === undefined) return base;

  const window: SpendLogWindow = {
    from: logs.from,
    to: logs.to,
    days: dayCount(logs.from, logs.to),
  };
  const answered = {
    ...base,
    answered: true,
    available: logs.available,
    truncated: logs.truncated,
    window,
    fetchedAt: logs.fetchedAt,
    isEmpty: logs.available && logs.rows.length === 0,
  };
  if (!logs.available || logs.rows.length === 0) return answered;

  const tab = crossTabSpendLogs(logs.rows, rowDimension, columnDimension);
  const rows = tab.rows.slice(0, MATRIX_ROW_CAP);
  const columns = tab.columns.slice(0, MATRIX_COLUMN_CAP);
  const visibleRows = new Set(rows.map((row) => row.key));
  const visibleColumns = new Set(columns.map((column) => column.key));

  // The heat scale is taken over the *visible* cells only: a matrix whose
  // brightest cell sits outside the drawn grid would render every drawn one as
  // dim, which reads as "nothing here" rather than as "cropped".
  const visible = tab.cells.filter(
    (cell) => visibleRows.has(cell.row) && visibleColumns.has(cell.column),
  );
  const heaviest = visible.reduce((max, cell) => Math.max(max, cell.spend), 0);
  const cells = new Map<string, MatrixCell>();
  for (const cell of visible) {
    cells.set(cellId(cell.row, cell.column), {
      ...cell,
      intensity: heaviest === 0 ? 0 : cell.spend / heaviest,
    });
  }

  const timed = logs.rows.filter((log) => log.durationMs !== null).length;

  return {
    ...answered,
    rows,
    columns,
    hiddenRows: Math.max(0, tab.rows.length - rows.length),
    hiddenColumns: Math.max(0, tab.columns.length - columns.length),
    cells,
    sampleRequests: tab.sampleRequests,
    sampleSpend: tab.sampleSpend,
    attributedRequests: tab.attributedRequests,
    unattributedRequests: tab.unattributedRequests,
    ledgerRequests,
    sampledShare:
      ledgerRequests === null || ledgerRequests <= 0
        ? null
        : Math.min(1, tab.sampleRequests / ledgerRequests),
    latency: {
      p50Ms: spendLogLatencyPercentile(logs.rows, 50),
      p95Ms: spendLogLatencyPercentile(logs.rows, 95),
      p99Ms: spendLogLatencyPercentile(logs.rows, 99),
      timed,
      untimed: logs.rows.length - timed,
    },
    ...deriveDeployments(logs.rows),
  };
}

/** The key a drawn cell is stored under. NUL, so no key can collide with a pair. */
export function cellId(row: string, column: string): string {
  return `${row}\u0000${column}`;
}

/**
 * Which deployment served what.
 *
 * The one derivation here that no aggregate could support at all: the daily
 * rows are keyed by public alias, and every deployment behind that alias is
 * summed into one number before this dashboard ever sees it. A `degraded` alias
 * is therefore invisible in usage — it bills normally and its failures average
 * away — which is what `gateway_deployment_health` exists to catch and what
 * these rows finally put a size on.
 *
 * Requests whose `model_id` the proxy did not set are counted as *unjoinable*
 * rather than filed under a shared null deployment: a proxy that sets no
 * deployment ids collapses a load-balanced pool into one row, so its alias can
 * never read as degraded anywhere, and saying so is more useful than drawing a
 * bar for it.
 */
function deriveDeployments(logs: readonly GatewaySpendLog[]): {
  deployments: DeploymentRow[];
  splits: DeploymentSplit[];
  unjoinableRequests: number;
} {
  interface Accumulator {
    model: string;
    deploymentId: string | null;
    requests: number;
    failed: number;
    spend: number;
    durations: number[];
  }

  const byPair = new Map<string, Accumulator>();
  let unjoinableRequests = 0;

  for (const log of logs) {
    const model = log.modelGroup ?? log.model;
    if (model === null || model === '') continue;
    if (log.deploymentId === null || log.deploymentId === '') {
      unjoinableRequests += 1;
      continue;
    }

    const id = cellId(model, log.deploymentId);
    let row = byPair.get(id);
    if (row === undefined) {
      row = {
        model,
        deploymentId: log.deploymentId,
        requests: 0,
        failed: 0,
        spend: 0,
        durations: [],
      };
      byPair.set(id, row);
    }
    row.requests += 1;
    row.spend += log.spend;
    if (log.status === 'failure') row.failed += 1;
    if (log.durationMs !== null) row.durations.push(log.durationMs);
  }

  const siblings = new Map<string, number>();
  for (const row of byPair.values()) {
    siblings.set(row.model, (siblings.get(row.model) ?? 0) + 1);
  }

  const deployments: DeploymentRow[] = [...byPair.values()]
    .map((row) => ({
      model: row.model,
      deploymentId: row.deploymentId,
      requests: row.requests,
      failed: row.failed,
      failureRate: row.requests === 0 ? 0 : row.failed / row.requests,
      spend: row.spend,
      p95Ms: percentileOf(row.durations, 95),
      siblings: siblings.get(row.model) ?? 1,
      material: row.requests >= DEPLOYMENT_MIN_REQUESTS,
    }))
    .sort((left, right) => right.spend - left.spend);

  const splits: DeploymentSplit[] = [...siblings.entries()]
    .filter(([, count]) => count > 1)
    .map(([model]) => {
      const rows = deployments
        .filter((row) => row.model === model)
        .slice()
        .sort((left, right) => right.requests - left.requests);
      const material = rows.filter((row) => row.material);
      const timed = material.filter((row) => row.p95Ms !== null);
      return {
        model,
        rows,
        failureSpread:
          material.length < 2
            ? null
            : Math.max(...material.map((row) => row.failureRate)) -
              Math.min(...material.map((row) => row.failureRate)),
        latencyRatio:
          timed.length < 2
            ? null
            : Math.max(...timed.map((row) => row.p95Ms ?? 0)) /
              Math.max(1, Math.min(...timed.map((row) => row.p95Ms ?? 0))),
      };
    })
    .sort((left, right) => (right.failureSpread ?? 0) - (left.failureSpread ?? 0));

  return { deployments, splits, unjoinableRequests };
}

/** Nearest-rank, over durations already collected — the same rule as the shared helper. */
function percentileOf(durations: readonly number[], percentile: number): number | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

/** Inclusive day count between two ISO dates. */
function dayCount(from: string, to: string): number {
  const span =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  return Number.isFinite(span) ? Math.max(1, Math.round(span)) : 1;
}

/**
 * Requests the aggregate layer recorded over the same days.
 *
 * The completeness note's denominator, taken from the spine the page already
 * holds rather than from a second fetch. It is the one figure the two layers
 * can be compared on honestly: both count requests exactly, where the sample's
 * dollars are a floor by construction.
 */
export function ledgerRequestsIn(
  daily: readonly GatewayDailyPoint[],
  window: SpendLogWindow | null,
): number | null {
  if (window === null) return null;
  let total = 0;
  let matched = 0;
  for (const day of daily) {
    if (day.date < window.from || day.date > window.to) continue;
    matched += 1;
    total += day.requests;
  }
  return matched === 0 ? null : total;
}
