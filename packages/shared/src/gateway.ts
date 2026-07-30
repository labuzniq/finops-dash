/**
 * The LLM-gateway contract — usage and spend from the corporate LiteLLM proxy
 * that fronts Azure AI Foundry, Azure OpenAI and AWS Bedrock.
 *
 * DRAFT: modelled against LiteLLM's published daily-activity response
 * (`SpendAnalyticsPaginatedResponse` → `DailySpendData` → `SpendMetrics`), not
 * against a live gateway. Everything the proxy answers is optional-with-zero
 * on its side, so every metric here is a number, never null — a gateway that
 * never saw a request reports zeros, which is a fact, not an unknown. The one
 * genuinely unknown field is `label` (a key alias / team name the proxy may or
 * may not resolve), which stays nullable and renders as `—`.
 *
 * Money is dollars here and bigint nano-dollars in Postgres, the same rule the
 * Copilot billing tables follow: LiteLLM reports per-request spend down to
 * ~1e-8 USD, so cents cannot hold it and floats drift when summed.
 */

/**
 * Where gateway data comes from. `off` is the default for a fresh clone with
 * no proxy reachable: the sync route answers 503 and the scheduler skips it.
 */
export const GATEWAY_SOURCES = ['off', 'mock', 'litellm'] as const;
export type GatewaySource = (typeof GATEWAY_SOURCES)[number];

/**
 * The breakdown axes LiteLLM exposes. `model`, `provider`, `api_key` and
 * `mcp_server` come from one response's `breakdown` object; `user`, `team` and
 * `tag` are the `entities` breakdown of the correspondingly-scoped endpoint.
 *
 * `provider` is the one that answers "how much of our spend is Bedrock vs
 * Azure" — the reason a gateway view exists at all next to the Copilot one.
 */
export const GATEWAY_DIMENSIONS = [
  'model',
  'provider',
  'api_key',
  'mcp_server',
  'user',
  'team',
  'tag',
] as const;
export type GatewayDimension = (typeof GATEWAY_DIMENSIONS)[number];

/** Human labels for the dimension switcher — the UI never invents its own. */
export const GATEWAY_DIMENSION_LABELS: Record<GatewayDimension, string> = {
  model: 'Model',
  provider: 'Provider',
  api_key: 'API key',
  mcp_server: 'MCP server',
  user: 'User',
  team: 'Team',
  tag: 'Tag',
};

/**
 * One bucket of gateway usage — LiteLLM's `SpendMetrics`, minus the fields the
 * dashboard has no use for (compression savings). Spend is dollars.
 */
export interface GatewayMetrics {
  spend: number;
  /** `api_requests` — the total, successes plus failures. */
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Tokens served from the provider's prompt cache — cheap reads. */
  cacheReadTokens: number;
  /** Tokens written into the prompt cache — a premium-rate write. */
  cacheCreationTokens: number;
}

export const EMPTY_GATEWAY_METRICS: GatewayMetrics = {
  spend: 0,
  requests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** One day of gateway-wide totals. */
export interface GatewayDailyPoint extends GatewayMetrics {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
}

/** One day of one key within one breakdown dimension. */
export interface GatewayBreakdownPoint extends GatewayMetrics {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  dimension: GatewayDimension;
  /** The raw id LiteLLM reports — model name, provider slug, hashed key, user id. */
  key: string;
  /** Key alias / team name when the proxy resolved one; null renders as `—`. */
  label: string | null;
}

/** Everything `GET /api/gateway` returns — a range of days, sliced client-side. */
export interface GatewayUsage {
  daily: GatewayDailyPoint[];
  breakdowns: GatewayBreakdownPoint[];
}

/** Sums any set of buckets into one. Pure — the web app's KPI row runs on it. */
export function sumGatewayMetrics(
  points: ReadonlyArray<Readonly<GatewayMetrics>>,
): GatewayMetrics {
  const total = { ...EMPTY_GATEWAY_METRICS };
  for (const point of points) {
    total.spend += point.spend;
    total.requests += point.requests;
    total.successfulRequests += point.successfulRequests;
    total.failedRequests += point.failedRequests;
    total.promptTokens += point.promptTokens;
    total.completionTokens += point.completionTokens;
    total.totalTokens += point.totalTokens;
    total.cacheReadTokens += point.cacheReadTokens;
    total.cacheCreationTokens += point.cacheCreationTokens;
  }
  return total;
}

/**
 * Successes ÷ requests, 0–100. Null when nothing was requested — an idle day
 * has no success rate, and rendering it as 0% or 100% both assert a falsehood.
 */
export function successRate(metrics: Readonly<GatewayMetrics>): number | null {
  if (metrics.requests === 0) return null;
  return (metrics.successfulRequests / metrics.requests) * 100;
}

/**
 * Share of input tokens served from cache, 0–100. Null when no input tokens
 * were sent. The denominator includes the cached reads themselves — that is
 * what "of everything we fed the model, this much was cached" means.
 */
export function cacheHitRate(metrics: Readonly<GatewayMetrics>): number | null {
  const input = metrics.promptTokens + metrics.cacheReadTokens;
  if (input === 0) return null;
  return (metrics.cacheReadTokens / input) * 100;
}

/** Dollars per million tokens — the comparable unit across models. Null when idle. */
export function costPerMillionTokens(metrics: Readonly<GatewayMetrics>): number | null {
  if (metrics.totalTokens === 0) return null;
  return (metrics.spend / metrics.totalTokens) * 1_000_000;
}

/** Average dollars per request. Null when nothing was requested. */
export function costPerRequest(metrics: Readonly<GatewayMetrics>): number | null {
  if (metrics.requests === 0) return null;
  return metrics.spend / metrics.requests;
}
