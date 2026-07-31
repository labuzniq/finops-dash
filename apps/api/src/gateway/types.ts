import type {
  GatewayBudgetScope,
  GatewayDimension,
  GatewayProbeRoute,
  GatewaySource,
} from '@dash/shared';

/**
 * What a gateway source hands the sync — insert-shaped rows, money already in
 * bigint nano-dollars. Same contract shape as `CopilotSnapshot`: the client
 * owns the wire format, the service owns Postgres.
 */

/** One bucket's counters, in storage units. */
export interface GatewayCounters {
  /** USD × 1e9. */
  spendNano: bigint;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** One day of gateway-wide totals. */
export interface GatewayDailySnapshot extends GatewayCounters {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
}

/** One day of one key within one dimension. */
export interface GatewayBreakdownSnapshot extends GatewayCounters {
  date: string;
  dimension: GatewayDimension;
  key: string;
  label: string | null;
}

export interface GatewaySnapshot {
  daily: GatewayDailySnapshot[];
  breakdowns: GatewayBreakdownSnapshot[];
  /**
   * The days the fetch actually covered, ISO, ascending. The sync replaces
   * exactly these dates — a day the gateway reported nothing for is still
   * covered (it means "zero", not "no data"), so its stale rows must go.
   */
  dates: string[];
}

/**
 * One governed object as the proxy currently has it — a virtual key or a team.
 *
 * Not a time series: there is one row per (scope, key) and the sync replaces the
 * lot. Every limit is nullable because "no cap" and "a cap of zero" are
 * different states on a proxy, and a zero-filled null would turn the first into
 * the second. Money is bigint nano-dollars like everything else.
 */
export interface GatewayBudgetSnapshot {
  scope: GatewayBudgetScope;
  /** The proxy's own id — hashed key token, or team id. */
  key: string;
  label: string | null;
  /** LiteLLM's counter for the budget period in flight. USD × 1e9. */
  spendNano: bigint;
  maxBudgetNano: bigint | null;
  softBudgetNano: bigint | null;
  budgetDuration: string | null;
  resetAt: Date | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
  blocked: boolean;
}

/**
 * One routable model as `GET /model/info` reports it, in storage units.
 *
 * Prices are nano-dollars per *million* tokens rather than per token: LiteLLM
 * quotes `2.5e-06` per token, and nine fractional digits of a per-token price
 * would round every cheap model to the same handful of nanos. Per million, the
 * same integer scale carries $0.01/M without losing a digit.
 *
 * Every price is nullable and never zero-filled, for the same reason a budget
 * limit is: a model priced per second has no per-token cost at all, while an
 * explicit `0` is a free model the proxy deliberately skips budget checks for.
 */
export interface GatewayModelSnapshot {
  model: string;
  backend: string | null;
  provider: string | null;
  mode: string | null;
  /** USD × 1e9 per 1,000,000 tokens. */
  inputPerMillionNano: bigint | null;
  outputPerMillionNano: bigint | null;
  cacheReadPerMillionNano: bigint | null;
  cacheWritePerMillionNano: bigint | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  deployments: number;
  priceVaries: boolean;
}

/**
 * One deployment as `GET /health` last reported it — the router's own view of a
 * single Azure/Bedrock endpoint rather than of the alias in front of it.
 *
 * `model` is deliberately absent here: the client reads `/health`, which reports
 * routing strings and never public aliases, so resolving the alias is a *join*
 * against the catalogue and belongs to the sync, which holds both snapshots.
 */
export interface GatewayHealthSnapshot {
  /** `model_info.id`, or the routing string when the proxy reported no id. */
  id: string;
  backend: string;
  provider: string | null;
  apiBase: string | null;
  healthy: boolean;
  error: string | null;
  errorStatus: number | null;
}

/**
 * One request as `GET /spend/logs` reported it, in storage units.
 *
 * The same fields as the shared `GatewaySpendLog` read model with money still
 * in bigint nano-dollars: nothing about this route is special enough to move
 * the one place dollars are made (`nanoToDollars`, in the read service), even
 * though the rows here are forwarded rather than stored.
 */
export interface GatewaySpendLogRecord {
  requestId: string;
  callType: string;
  startTime: string;
  endTime: string | null;
  durationMs: number | null;
  model: string | null;
  modelGroup: string | null;
  deploymentId: string | null;
  provider: string | null;
  apiBase: string | null;
  apiKey: string | null;
  keyAlias: string | null;
  user: string | null;
  teamId: string | null;
  teamAlias: string | null;
  endUser: string | null;
  tags: string[];
  mcpTool: string | null;
  sessionId: string | null;
  agentId: string | null;
  /** USD × 1e9. */
  spendNano: bigint;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHit: boolean | null;
  status: string | null;
}

/**
 * What one `/spend/logs` read answered.
 *
 * `available: false` is a first-class result rather than an empty list: a proxy
 * run with `disable_spend_logs` refuses or empties the route while billing
 * perfectly, and reporting that as "no requests in this window" would be a
 * different and false claim.
 */
export interface GatewaySpendLogPage {
  rows: GatewaySpendLogRecord[];
  available: boolean;
  /** The row cap stopped the read — every total over `rows` is a floor. */
  truncated: boolean;
}

/**
 * One deployment's exception counts for a window, as
 * `GET /model/metrics/exceptions` reported them.
 *
 * The one snapshot here that carries no money at all, so it needs no storage
 * units: an error log is a reason and a count of reasons, nothing else. The
 * shape matches the shared read model exactly and is re-declared on this side
 * only so the client keeps owning the wire format.
 */
export interface GatewayExceptionRecord {
  /** LiteLLM's `combined_model_api_base`, verbatim and never parsed. */
  deployment: string;
  /** The alias the read was scoped to — the query parameter, not the row. */
  model: string;
  exceptions: { type: string; count: number }[];
  /** The proxy's own `total_exceptions`, which counts classes rather than exceptions. */
  reportedTotal: number;
}

/**
 * What one `/model/metrics/exceptions` sweep answered.
 *
 * `available: false` is a first-class result for the same reason it is on
 * `/spend/logs`: error logging is separately switchable upstream
 * (`disable_error_logs`) and the route is admin-scoped, so a proxy that bills
 * and fails perfectly may still refuse it.
 */
export interface GatewayExceptionPage {
  rows: GatewayExceptionRecord[];
  available: boolean;
}

/**
 * One deployment key's latency on one day, as `GET /model/metrics` averaged it.
 *
 * `key` is LiteLLM's combined name — the `api_base` where there is one, the
 * backend model string where there is not — and `model` is the alias the read
 * was scoped to, because the row itself does not carry it. Flat rather than
 * nested so the client can accumulate across the one-call-per-alias sweep
 * without building a tree it would only have to flatten again.
 */
export interface GatewayLatencyRecord {
  model: string;
  key: string;
  /** ISO date, UTC. */
  date: string;
  /** Seconds of wall clock per completion token. Never a request duration. */
  secondsPerToken: number;
}

/**
 * What one `/model/metrics` sweep answered.
 *
 * `available: false` is a first-class result for the same reason it is on
 * `/spend/logs`: this route aggregates the *same* table, so a proxy running
 * `disable_spend_logs` bills perfectly and reports no latency at all.
 */
export interface GatewayLatencyPage {
  rows: GatewayLatencyRecord[];
  /** The proxy's own `all_api_bases`, merged across the sweep. Evidence only. */
  apiBases: string[];
  available: boolean;
}

/**
 * One `api_base` group's hang count for one alias, as
 * `GET /model/metrics/slow_responses` counted it.
 *
 * `total` is the route's own denominator — request-log rows for that alias and
 * endpoint with cache hits excluded — and never the ledger's request count.
 * `slow` is how many of them ran at or past the proxy's `alerting_threshold`,
 * which the response does not carry, so neither does this record.
 */
export interface GatewaySlowResponseRecord {
  /** The alias the read was scoped to — the query parameter, not the row. */
  model: string;
  /** The `api_base`, cut at `/openai/`, or `UNKEYED_DEPLOYMENT` for a null. */
  key: string;
  total: number;
  slow: number;
}

/**
 * What one `/model/metrics/slow_responses` sweep answered.
 *
 * `available: false` is a first-class result for the same reason it is on
 * `/model/metrics`: this route scans the same `LiteLLM_SpendLogs`, so a proxy
 * running `disable_spend_logs` bills perfectly and reports nothing hanging.
 */
export interface GatewaySlowResponsePage {
  rows: GatewaySlowResponseRecord[];
  available: boolean;
}

export interface GatewayClient {
  /** Source name, for job logs. */
  readonly name: GatewaySource;
  /** Usage for the inclusive ISO date range, gateway-wide plus every breakdown. */
  fetchUsage(from: string, to: string): Promise<GatewaySnapshot>;
  /**
   * Current budgets and rate limits for every key and team the calling
   * credential can see. Returns `[]` — never throws — when the proxy offers no
   * management routes to this key: governance is a secondary view and must not
   * be able to fail a usage sync.
   */
  fetchBudgets(): Promise<GatewayBudgetSnapshot[]>;
  /**
   * The proxy's configured price list, one entry per routable model.
   *
   * Optional exactly like `fetchBudgets`: `/model/info` is a management route,
   * an analytics-only credential is refused it, and a catalogue is a garnish on
   * a usage sync rather than a precondition for one. `[]` is a supported answer.
   */
  fetchModels(): Promise<GatewayModelSnapshot[]>;
  /**
   * Per-deployment health, from the router rather than from the usage tables.
   *
   * Optional exactly like the other two management reads, and with one extra
   * caveat of its own: unless the proxy is configured with
   * `background_health_checks`, `/health` performs a live test call against
   * every deployment while answering. That is a real (small) cost on a real
   * gateway, which is why it is taken once per nightly full sync and never on a
   * backfill, and why nothing in the dashboard calls it behind a button.
   */
  fetchHealth(): Promise<GatewayHealthSnapshot[]>;
  /**
   * Request-level logs for a bounded window — the joint-keyed evidence layer
   * under every aggregate this client otherwise reads.
   *
   * The one read that is *not* part of the sync: nothing stores these rows.
   * They are fetched live behind a drill-down, capped, and thrown away, because
   * the table they come from is the largest in LiteLLM's database, is pruned on
   * a retention schedule of its own, and may be switched off entirely
   * (`disable_spend_logs`) on a proxy that bills perfectly.
   *
   * Optional like the management routes, and for a reason that is not an
   * error: `available: false` is what a proxy that keeps no logs answers.
   */
  fetchSpendLogs(from: string, to: string, limit: number): Promise<GatewaySpendLogPage>;
  /**
   * Exception counts per deployment for a window, for the aliases named.
   *
   * Live and stored nowhere, like `fetchSpendLogs`, and asked one alias at a
   * time because the proxy's own query filters on `model_group` — there is no
   * "everything" call to make. The caller decides which aliases are worth a
   * round trip and reports the ones it skipped.
   *
   * Optional like the management routes, and `available: false` is a supported
   * configuration rather than a fault: `disable_error_logs` is the twin of
   * `disable_spend_logs`, and this route is admin-scoped besides.
   */
  fetchModelExceptions(
    from: string,
    to: string,
    models: readonly string[],
  ): Promise<GatewayExceptionPage>;
  /**
   * Per-deployment latency for a window, for the aliases named — the proxy's own
   * aggregation over its request log.
   *
   * Live and stored nowhere, and asked one alias at a time, exactly like
   * `fetchModelExceptions`: the proxy's query filters on `model_group` with no
   * wildcard. It is the other half of that layer's answer — the exception sweep
   * says which calls failed and why, this says how slowly the ones that
   * succeeded came back — and it is the only latency the proxy exports over a
   * whole window rather than over a capped sample.
   *
   * Optional like the other live reads: it aggregates `LiteLLM_SpendLogs`, so
   * `disable_spend_logs` answers `available: false` on a gateway that is
   * working perfectly.
   */
  fetchModelLatency(
    from: string,
    to: string,
    models: readonly string[],
  ): Promise<GatewayLatencyPage>;
  /**
   * How many calls hung, per `api_base`, for the aliases named.
   *
   * The third per-alias sweep and the only reading of *wall clock* the proxy
   * will aggregate: `/model/metrics` answers seconds per completion token, which
   * a long answer at an ordinary rate satisfies while somebody waits four
   * minutes for it. This route counts the requests that ran past the proxy's own
   * alerting threshold, beside the requests it counted them out of.
   *
   * Live and stored nowhere, one call per alias, and optional like every other
   * request-log read: it scans `LiteLLM_SpendLogs`, so `disable_spend_logs`
   * answers `available: false` on a gateway that is working perfectly.
   */
  fetchModelSlowResponses(
    from: string,
    to: string,
    models: readonly string[],
  ): Promise<GatewaySlowResponsePage>;
  /**
   * A connection check: call every route this client depends on once, for a
   * single day, and report what each answered.
   *
   * Deliberately not a sync — it writes nothing, retries nothing, and cannot
   * fail. Every failure mode is a `GatewayProbeRoute` with a status on it,
   * because "the proxy refused /team/list" is the *result* of a probe, not an
   * error in running one. It takes the day rather than reading the clock so a
   * harness can pin it.
   */
  probe(day: string): Promise<GatewayProbeRoute[]>;
}

export const ZERO_COUNTERS: GatewayCounters = {
  spendNano: 0n,
  requests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** Accumulates `add` into `into`. Buckets arrive split across pages and calls. */
export function addCounters(into: GatewayCounters, add: Readonly<GatewayCounters>): void {
  into.spendNano += add.spendNano;
  into.requests += add.requests;
  into.successfulRequests += add.successfulRequests;
  into.failedRequests += add.failedRequests;
  into.promptTokens += add.promptTokens;
  into.completionTokens += add.completionTokens;
  into.totalTokens += add.totalTokens;
  into.cacheReadTokens += add.cacheReadTokens;
  into.cacheCreationTokens += add.cacheCreationTokens;
}
