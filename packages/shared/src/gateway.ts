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

/**
 * ─── Budgets and limits ──────────────────────────────────────────────────────
 *
 * Everything above is *usage*: what the gateway did, per day, forever. A budget
 * is the opposite kind of fact — current configuration plus the proxy's own
 * live counter for the period in flight. There is exactly one row per key and
 * per team, it is replaced wholesale on every sync, and it has no history.
 *
 * Two rules invert here, and both matter:
 *
 *  - **Null is back.** A usage counter is never null (the proxy omits what never
 *    happened, so zero is a fact). A budget field is null whenever the governance
 *    object simply has no such limit, and `maxBudget: 0` is a different and
 *    much stronger statement — a key budgeted at zero dollars rejects every call.
 *  - **`spend` here is not our sum.** It is LiteLLM's counter for the current
 *    budget period, which resets on the key's own schedule (possibly mid-day,
 *    possibly on a duration nothing else in the dashboard uses). Re-deriving it
 *    from `gateway_daily` would silently disagree with what the proxy enforces,
 *    and the enforced number is the one an owner needs.
 */

/** Whose budget it is. `api_key` joins the `api_key` usage dimension by `key`. */
export const GATEWAY_BUDGET_SCOPES = ['api_key', 'team'] as const;
export type GatewayBudgetScope = (typeof GATEWAY_BUDGET_SCOPES)[number];

export const GATEWAY_BUDGET_SCOPE_LABELS: Record<GatewayBudgetScope, string> = {
  api_key: 'API key',
  team: 'Team',
};

/**
 * One governed object on the proxy — a virtual key or a team.
 *
 * `key` is the same id the matching usage dimension reports (the hashed key
 * token for `api_key`, the team id for `team`), which is what lets a budget row
 * be read next to the spend it governs without a second join key.
 */
export interface GatewayBudget {
  scope: GatewayBudgetScope;
  key: string;
  /** Alias the proxy resolved — `key_alias` / `team_alias`; null renders as `—`. */
  label: string | null;
  /** LiteLLM's own spend counter for the period in flight, dollars. */
  spend: number;
  /** Hard cap in dollars. Null means uncapped; 0 means "blocked by budget". */
  maxBudget: number | null;
  /** Alert threshold below the hard cap, when one is configured. */
  softBudget: number | null;
  /** LiteLLM duration string — `30d`, `1mo`, `24h`, or an alias like `weekly`. */
  budgetDuration: string | null;
  /** ISO 8601 instant the counter next resets to zero. Null when it never does. */
  resetAt: string | null;
  /** Tokens and requests per minute the proxy will admit. Null means unlimited. */
  tpmLimit: number | null;
  rpmLimit: number | null;
  /** Administratively disabled — every call is rejected regardless of budget. */
  blocked: boolean;
}

/** Everything `GET /api/gateway/budgets` returns. */
export interface GatewayBudgets {
  budgets: GatewayBudget[];
}

/**
 * Share of the hard cap consumed, 0–100 (and above 100 when overrun — a proxy
 * can bill past a cap on in-flight requests, and clamping would hide it).
 *
 * Null when there is nothing to divide by: no cap configured, or a cap of zero,
 * which is a block rather than a budget and has no meaningful percentage.
 */
export function budgetUtilization(budget: Readonly<GatewayBudget>): number | null {
  if (budget.maxBudget === null || budget.maxBudget <= 0) return null;
  return (budget.spend / budget.maxBudget) * 100;
}

/** Dollars left before the hard cap; negative when overrun. Null when uncapped. */
export function budgetRemaining(budget: Readonly<GatewayBudget>): number | null {
  if (budget.maxBudget === null) return null;
  return budget.maxBudget - budget.spend;
}

/**
 * LiteLLM duration units, from `litellm_core_utils/duration_parser.py`:
 * `(\d+)(mo|[smhdw]?)`, plus the word aliases the proxy normalises first.
 * Note `monthly` is `30d`, *not* `1mo` — LiteLLM's own alias table says so, and
 * the two differ by up to a day and a half.
 */
const BUDGET_DURATION_ALIASES: Record<string, string> = {
  hourly: '1h',
  daily: '24h',
  weekly: '7d',
  monthly: '30d',
};

export type BudgetDurationUnit = 's' | 'm' | 'h' | 'd' | 'w' | 'mo';

export interface BudgetDuration {
  value: number;
  unit: BudgetDurationUnit;
}

const DURATION_RE = /^(\d+)(mo|[smhdw])$/;

/** `30d` → `{value: 30, unit: 'd'}`. Null on anything the proxy would reject. */
export function parseBudgetDuration(duration: string): BudgetDuration | null {
  const normalised = BUDGET_DURATION_ALIASES[duration.trim().toLowerCase()] ?? duration.trim();
  const match = DURATION_RE.exec(normalised);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, unit: match[2] as BudgetDurationUnit };
}

const MS: Record<Exclude<BudgetDurationUnit, 'mo'>, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * When the period in flight began — `resetAt` less one duration, as an ISO
 * instant. Null when either half is missing or unparseable.
 *
 * Months are walked on the calendar, not as a fixed span of milliseconds: a
 * `1mo` budget resetting on 1 March started on 1 February, 28 days earlier, and
 * subtracting a nominal 30 would put the period start in January. The day is
 * clamped to the target month's length the same way LiteLLM's own month
 * arithmetic clamps it.
 */
export function budgetPeriodStart(budget: Readonly<GatewayBudget>): string | null {
  if (budget.resetAt === null || budget.budgetDuration === null) return null;
  const reset = new Date(budget.resetAt);
  if (Number.isNaN(reset.getTime())) return null;
  const duration = parseBudgetDuration(budget.budgetDuration);
  if (duration === null) return null;

  if (duration.unit !== 'mo') {
    return new Date(reset.getTime() - duration.value * MS[duration.unit]).toISOString();
  }

  const start = new Date(reset.getTime());
  const day = start.getUTCDate();
  // Land on the first of the month before moving the day, so a 31st never rolls
  // the month forward on its own while the subtraction is half-applied.
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - duration.value);
  const lastDay = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(day, lastDay));
  return start.toISOString();
}
