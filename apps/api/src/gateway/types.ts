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
