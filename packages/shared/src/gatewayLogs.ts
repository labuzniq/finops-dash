import type { GatewayDimension } from './gateway.js';

/**
 * Request-level spend logs — `LiteLLM_SpendLogs`, one row per request, read
 * through `GET /spend/logs` with `summarize=false`.
 *
 * Every other gateway surface in this dashboard reads the *aggregate* layer
 * (`/…/daily/activity`: one row per day per key per dimension), and that layer
 * has one structural hole — it carries no joint key. Each dimension is reported
 * independently, so "which models did this team spend its money on" is not a
 * slice of the payload, it is a question the payload cannot express. A log row
 * carries every dimension at once, plus three facts no aggregate has at all:
 * the deployment that served it (`model_id`, the id `/health` is keyed by), the
 * request's duration, and its session.
 *
 * That makes this the one gateway read whose value is *joins*, and the one that
 * must never be totalled. Three independent reasons, any one of them enough:
 *
 *  1. **The logs may not exist.** `disable_spend_logs` is an ordinary
 *     production setting on a busy proxy — the table is the largest thing in
 *     LiteLLM's database and it costs a row per request. A gateway can bill
 *     correctly and log nothing.
 *  2. **They are pruned on their own schedule.** `maximum_spend_logs_retention_period`
 *     is configured separately from — and is usually far shorter than — the
 *     daily aggregates the rest of this page reads, so the log window and the
 *     ledger window disagree.
 *  3. **The fetch is capped.** A busy day is millions of rows; this integration
 *     asks for a bounded window and stops at `SPEND_LOG_ROW_CAP`. A sum over a
 *     truncated sample is a floor, the same shape as an `mcp_server`
 *     attribution or a closed budget period's `observedTotal`.
 *
 * So the daily aggregates stay the ledger and these rows are evidence. Nothing
 * derived from them may be rendered as gateway spend, and anything that adds
 * them up has to say it is adding up a sample.
 */

/** How many days of request logs one read may ask for. */
export const SPEND_LOG_MAX_WINDOW_DAYS = 7;

/**
 * The most rows one read returns. A cap rather than deep pagination: this is a
 * drill-down behind a click, and a browser handed half a million requests has
 * the same problem the proxy would.
 */
export const SPEND_LOG_ROW_CAP = 5_000;

/**
 * One request as the proxy logged it. Money is dollars, like every other read
 * model here. The columns the dashboard has no business carrying (`messages`,
 * `response`, `proxy_server_request`, `requester_ip_address`) are deliberately
 * dropped in the client rather than filtered later — prompt content is off by
 * default upstream and is not this dashboard's to hold either way.
 *
 * Nullability follows the proxy rather than the usage rule. A usage counter is
 * never null because the aggregate omits what never happened; a *log* row
 * genuinely does not know some things. A call made outside a team carries no
 * team, a proxy that never set `model_id` cannot say which deployment answered,
 * and `cache_hit` is a tri-state upstream (`"True"`, `"False"`, absent) whose
 * third state is "nobody recorded it" rather than "no".
 */
export interface GatewaySpendLog {
  requestId: string;
  /** `acompletion`, `aembedding`, `pass_through_endpoint`, … */
  callType: string;
  /** ISO instant the request started. */
  startTime: string;
  /** ISO instant it finished, or null when the proxy logged no end. */
  endTime: string | null;
  /**
   * Wall-clock duration. Taken from `request_duration_ms` where the proxy
   * carries it and derived from the two timestamps where it does not — latency
   * is the one thing here no aggregate reports at all, and dropping it whenever
   * an older proxy omits the column would lose it on exactly those proxies.
   */
  durationMs: number | null;
  /** The deployment's own model string — what was actually called. */
  model: string | null;
  /**
   * The public alias the caller asked for (`model_group`). This, not `model`,
   * is the key the `model` usage dimension is reported under, so it is what
   * joins a log row to the breakdown table and to the price catalogue.
   */
  modelGroup: string | null;
  /**
   * `model_id`: which deployment behind the alias served the request. The only
   * place usage and `gateway_deployment_health` can be joined, and null on a
   * proxy that sets no deployment ids — the same proxy whose health rows
   * collapse a load-balanced pool into one.
   */
  deploymentId: string | null;
  provider: string | null;
  apiBase: string | null;
  /** The key's sha256 hash — the value the `api_key` usage dimension is keyed by. */
  apiKey: string | null;
  keyAlias: string | null;
  /** LiteLLM's internal user id — the `user` dimension's key. */
  user: string | null;
  teamId: string | null;
  teamAlias: string | null;
  /** The caller's own customer id, which is a different population from `user`. */
  endUser: string | null;
  /** `request_tags`, a list: one request may sit in several tag buckets. */
  tags: string[];
  /** `mcp_namespaced_tool_name`, verbatim — `server/tool`. */
  mcpTool: string | null;
  sessionId: string | null;
  agentId: string | null;
  spend: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** True or false as the proxy recorded it, null when it recorded nothing. */
  cacheHit: boolean | null;
  /** `success`, `failure`, or null on a proxy that predates the column. */
  status: string | null;
}

/** Everything `GET /api/gateway/logs` returns. */
export interface GatewaySpendLogs {
  /** The window asked for, inclusive ISO dates. */
  from: string;
  to: string;
  rows: GatewaySpendLog[];
  /**
   * Whether the proxy answered the route at all. False means `/spend/logs` was
   * refused or is absent — which on LiteLLM most often means `disable_spend_logs`
   * rather than a broken proxy, and is a legitimate way to run one.
   */
  available: boolean;
  /**
   * The row cap was reached, so `rows` is the head of the window and every
   * total over it is a floor. Reported rather than hidden: a truncated sample
   * presented as a window is the one way this read misleads.
   */
  truncated: boolean;
  /** When the proxy was asked. Nothing is stored — this route is live. */
  fetchedAt: string;
}

/**
 * The keys a log row contributes to one usage dimension — zero, one, or many.
 *
 * The plural is the point. A request carries a *list* of tags, so one row
 * legitimately sits in several `tag` buckets; that is the row-level cause of
 * the overlap the aggregate dimensions show. And a row can contribute nothing:
 * a service key acting on nobody's behalf has no `user`, a call outside a team
 * has no `team`, and neither of those is a zero.
 *
 * `mcp_server` is the namespaced tool name cut at the first `/`, since the
 * proxy logs `server/tool` per request and aggregates by server.
 */
export function spendLogDimensionKeys(
  log: GatewaySpendLog,
  dimension: GatewayDimension,
): string[] {
  const one = (value: string | null): string[] => (value === null || value === '' ? [] : [value]);

  switch (dimension) {
    case 'model':
      return one(log.modelGroup ?? log.model);
    case 'provider':
      return one(log.provider);
    case 'api_key':
      return one(log.apiKey);
    case 'user':
      return one(log.user);
    case 'team':
      return one(log.teamId);
    case 'tag':
      return log.tags.filter((tag) => tag !== '');
    case 'mcp_server': {
      if (log.mcpTool === null || log.mcpTool === '') return [];
      const cut = log.mcpTool.indexOf('/');
      return [cut === -1 ? log.mcpTool : log.mcpTool.slice(0, cut)];
    }
  }
}

/** One (row key, column key) pair's counters — a floor over the sample. */
export interface GatewaySpendLogCell {
  row: string;
  column: string;
  spend: number;
  requests: number;
  totalTokens: number;
  failed: number;
}

/** One axis key's own counters, over the same sample. */
export interface GatewaySpendLogAxis {
  key: string;
  spend: number;
  requests: number;
  totalTokens: number;
}

/**
 * The joint breakdown the aggregate layer cannot produce: two dimensions at
 * once, over a sample.
 *
 * Two rules are built into the shape. A request carrying no key on one axis or
 * the other is *unattributed* and counted — never dropped, never bucketed as
 * "other" — for the same reason the chargeback statement carries an explicit
 * `unallocated` line. And a request carrying several keys on an axis (tags)
 * contributes to each of them, so the cells legitimately sum to more than the
 * sample: `attributedRequests` counts requests while `cells` count
 * contributions, and the two agree only when neither axis is multi-valued.
 */
export interface GatewaySpendLogCrossTab {
  rowDimension: GatewayDimension;
  columnDimension: GatewayDimension;
  rows: GatewaySpendLogAxis[];
  columns: GatewaySpendLogAxis[];
  cells: GatewaySpendLogCell[];
  /** Requests contributing at least one cell. */
  attributedRequests: number;
  /** Requests missing a key on one axis or the other. */
  unattributedRequests: number;
  /** Requests in the sample, attributed or not. */
  sampleRequests: number;
  /** Spend over the whole sample — a floor on the window, never a total for it. */
  sampleSpend: number;
}

/**
 * Cross-tabulate a sample of request logs by two dimensions.
 *
 * Pure, and deliberately neither ranked-and-capped nor share-bearing: the
 * caller knows how many rows its table can draw, and truncating inside the
 * derivation would leave the axis totals disagreeing with the cells that
 * survived. Shares are the caller's business too, because the honest
 * denominator here is the sample and not the gateway.
 */
export function crossTabSpendLogs(
  logs: readonly GatewaySpendLog[],
  rowDimension: GatewayDimension,
  columnDimension: GatewayDimension,
): GatewaySpendLogCrossTab {
  const rows = new Map<string, GatewaySpendLogAxis>();
  const columns = new Map<string, GatewaySpendLogAxis>();
  const cells = new Map<string, GatewaySpendLogCell>();

  let attributedRequests = 0;
  let unattributedRequests = 0;
  let sampleSpend = 0;

  const bump = (axis: Map<string, GatewaySpendLogAxis>, key: string, log: GatewaySpendLog): void => {
    const existing = axis.get(key);
    if (existing === undefined) {
      axis.set(key, { key, spend: log.spend, requests: 1, totalTokens: log.totalTokens });
      return;
    }
    existing.spend += log.spend;
    existing.requests += 1;
    existing.totalTokens += log.totalTokens;
  };

  for (const log of logs) {
    sampleSpend += log.spend;

    const rowKeys = spendLogDimensionKeys(log, rowDimension);
    const columnKeys = spendLogDimensionKeys(log, columnDimension);
    if (rowKeys.length === 0 || columnKeys.length === 0) {
      unattributedRequests += 1;
      continue;
    }
    attributedRequests += 1;

    for (const key of rowKeys) bump(rows, key, log);
    for (const key of columnKeys) bump(columns, key, log);

    const failed = log.status === 'failure' ? 1 : 0;
    for (const row of rowKeys) {
      for (const column of columnKeys) {
        const id = `${row} ${column}`;
        const cell = cells.get(id);
        if (cell === undefined) {
          cells.set(id, {
            row,
            column,
            spend: log.spend,
            requests: 1,
            totalTokens: log.totalTokens,
            failed,
          });
          continue;
        }
        cell.spend += log.spend;
        cell.requests += 1;
        cell.totalTokens += log.totalTokens;
        cell.failed += failed;
      }
    }
  }

  const bySpend = (a: GatewaySpendLogAxis, b: GatewaySpendLogAxis): number => b.spend - a.spend;

  return {
    rowDimension,
    columnDimension,
    rows: [...rows.values()].sort(bySpend),
    columns: [...columns.values()].sort(bySpend),
    cells: [...cells.values()].sort((a, b) => b.spend - a.spend),
    attributedRequests,
    unattributedRequests,
    sampleRequests: logs.length,
    sampleSpend,
  };
}

/**
 * The p-th percentile of the sample's request durations, in milliseconds, or
 * null when nothing in it carries one.
 *
 * Nearest-rank over the sorted sample rather than an interpolation: the input
 * is already a sample of a window rather than the window itself, and a second
 * approximation on top of the first buys nothing.
 */
export function spendLogLatencyPercentile(
  logs: readonly GatewaySpendLog[],
  percentile: number,
): number | null {
  const durations = logs
    .map((log) => log.durationMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;

  const rank = Math.ceil((percentile / 100) * durations.length);
  const index = Math.min(durations.length - 1, Math.max(0, rank - 1));
  return durations[index] ?? null;
}
