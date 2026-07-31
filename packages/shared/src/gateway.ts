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
 * ─── The cache-token convention ──────────────────────────────────────────────
 *
 * `prompt_tokens` is the **whole** input, and both cache counters are subsets of
 * it. Nothing in this repo may add a cache counter to `promptTokens` to get an
 * input total, and nothing may price `promptTokens` at the full input rate
 * without first taking the cache counters back out.
 *
 * This is one statement in one place because it is the one fact every
 * cache-shaped derivation needs and no two of them may answer differently: a
 * hit rate, a re-priced bill and a saving are all ratios whose denominators
 * move by the size of the cache itself, so two modules disagreeing about it
 * disagree about every number they show. (They did, for five iterations — see
 * `docs/litellm-gateway.md`, decision 22.)
 *
 * It holds for both provider families the corporate gateway fronts, for
 * different reasons:
 *
 *  - **OpenAI-shaped** (Azure OpenAI, Azure AI Foundry) — `prompt_tokens`
 *    includes the cache hits, which surface separately as
 *    `prompt_tokens_details.cached_tokens`. There is no cache *write* on these
 *    backends at all: caching is automatic and `cache_creation_input_tokens` is
 *    zero.
 *  - **Anthropic-shaped** (Bedrock, and Anthropic direct) — LiteLLM's own usage
 *    transform sets `prompt_tokens = input_tokens + cache_read_input_tokens +
 *    cache_creation_input_tokens`, so both counters sit inside it.
 *
 * Which is why subtracting *both* counters is safe rather than a compromise
 * between the two: a cache write is only ever non-zero on the family that puts
 * it inside, so on the other family the subtraction is a no-op.
 *
 * It is also falsifiable rather than assumed — `detectCacheTokenConvention`
 * below is the check, and it runs on whatever the proxy actually sent.
 */
export const CACHE_TOKENS_INSIDE_PROMPT_TOKENS = true;

/**
 * Everything fed to the model — which is `prompt_tokens` itself, under the
 * convention above. A function rather than a field access so the convention has
 * one call site to change if a live proxy ever falsifies it.
 */
export function inputTokens(metrics: Readonly<GatewayMetrics>): number {
  return metrics.promptTokens;
}

/**
 * Input tokens that paid the full input rate — the prompt with both cache
 * counters taken back out. Clamped at zero: a proxy reporting more cache than
 * prompt is reporting something this convention does not describe, and a
 * negative token count would quietly become a negative bill.
 */
export function uncachedInputTokens(metrics: Readonly<GatewayMetrics>): number {
  return Math.max(
    0,
    metrics.promptTokens - metrics.cacheReadTokens - metrics.cacheCreationTokens,
  );
}

/**
 * Share of input tokens served from cache, 0..1. Null when no input tokens were
 * sent — an idle key has no hit rate, and 0 would assert one.
 *
 * This is the 0..1 form every `lib/metrics` module reads; `cacheHitRate` below
 * is the same number in percent for the KPI string. Handing the percent form to
 * a derivation that multiplies it by a token count is a two-order-of-magnitude
 * error that nothing else catches.
 */
export function cacheReadShare(metrics: Readonly<GatewayMetrics>): number | null {
  const input = inputTokens(metrics);
  if (input === 0) return null;
  return metrics.cacheReadTokens / input;
}

/** `cacheReadShare` as a percentage, 0–100 — the KPI row's form. */
export function cacheHitRate(metrics: Readonly<GatewayMetrics>): number | null {
  const share = cacheReadShare(metrics);
  return share === null ? null : share * 100;
}

/**
 * What a real payload says about the convention above.
 *
 * `reads_outside` is decisive: a row whose `cache_read_input_tokens` exceed its
 * `prompt_tokens` cannot have those reads inside them, whatever the docs say.
 * `writes_outside` is the same test one counter further — the reads fit and the
 * pair does not — and is the shape a proxy mixing the two families would show.
 * `unobserved` is the honest answer for a window with no cache activity: there
 * is nothing to contradict, which is not the same as agreement.
 *
 * Rounding is why the test is `>` rather than `>=` on a tolerance: the counters
 * are integers all the way from the proxy, so an equal row is a fully cached
 * prompt and not a violation.
 */
export type CacheTokenConventionVerdict =
  | 'consistent'
  | 'reads_outside'
  | 'writes_outside'
  | 'unobserved';

export interface CacheTokenConventionCheck {
  verdict: CacheTokenConventionVerdict;
  /** Rows carrying any cache activity — the only ones that can say anything. */
  rowsObserved: number;
  /** Rows where the cache counters do not fit inside `prompt_tokens`. */
  violations: number;
  /** The largest overshoot seen, in tokens — how badly, not just whether. */
  worstExcessTokens: number;
  /** Up to five violating rows, named by whatever the caller labelled them. */
  sample: string[];
}

const CONVENTION_SAMPLE_CAP = 5;

export function detectCacheTokenConvention(
  rows: ReadonlyArray<{ metrics: Readonly<GatewayMetrics>; label: string }>,
): CacheTokenConventionCheck {
  let rowsObserved = 0;
  let violations = 0;
  let readsOutside = false;
  let worstExcessTokens = 0;
  const sample: string[] = [];

  for (const { metrics, label } of rows) {
    const cache = metrics.cacheReadTokens + metrics.cacheCreationTokens;
    if (cache === 0) continue;
    rowsObserved += 1;
    if (cache <= metrics.promptTokens) continue;
    violations += 1;
    if (metrics.cacheReadTokens > metrics.promptTokens) readsOutside = true;
    worstExcessTokens = Math.max(worstExcessTokens, cache - metrics.promptTokens);
    if (sample.length < CONVENTION_SAMPLE_CAP) sample.push(label);
  }

  const verdict: CacheTokenConventionVerdict =
    rowsObserved === 0
      ? 'unobserved'
      : violations === 0
        ? 'consistent'
        : readsOutside
          ? 'reads_outside'
          : 'writes_outside';

  return { verdict, rowsObserved, violations, worstExcessTokens, sample };
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
 * ─── The model catalogue ─────────────────────────────────────────────────────
 *
 * The third kind of gateway fact, after usage and governance: what the proxy is
 * *configured to charge*. `GET /model/info` answers one entry per routable model
 * with the price list LiteLLM prices requests against, the context window and
 * the modality — none of which appear anywhere in the daily aggregates.
 *
 * It is a price *list*, and it is worth being clear about what that does and
 * does not license:
 *
 *  - It never replaces `spend`. The proxy's own charge is the billed number, and
 *    a catalogue rate multiplied by a token count is an estimate that ignores
 *    negotiated discounts, provisioned throughput and any per-key override. The
 *    same rule as `gateway_budget`'s counter, one layer up: what the gateway
 *    recorded wins over anything we can recompute.
 *  - It is what lets a *token* count be turned into dollars where the aggregate
 *    cannot. The daily row carries one `spend` covering input, output and both
 *    cache operations together, so no card can say what a cache read saved or
 *    what an output token costs — that is the gap this closes, approximately and
 *    labelled as such.
 *  - Null is the answer wherever the proxy has no price. A model billed per
 *    *second* (Bedrock provisioned throughput) carries no per-token cost at all,
 *    and `input_cost_per_token: 0` is a deliberate free model that LiteLLM skips
 *    budget checks for. Zero-filling would collapse "we do not know" into "it is
 *    free" — the same null-vs-zero rule the budget snapshot lives by.
 */

/**
 * One routable model as the proxy currently has it configured.
 *
 * Keyed by `model` — the **public alias** clients send in `"model": "…"`, which
 * is also what the `model` usage dimension is keyed by. `backend` is the
 * `litellm_params.model` behind it (`azure/gpt-4o`, `bedrock/anthropic…`), kept
 * because the two are different strings on any proxy that renames its
 * deployments, and a join has to be able to try both.
 *
 * Prices are dollars per **million** tokens, converted once here from LiteLLM's
 * per-token floats: a per-token price is 1e-6-shaped and unreadable, and every
 * other rate on the gateway page is already per million.
 */
export interface GatewayModelPrice {
  /** Public model name — the alias callers pass, and the `model` dimension's key. */
  model: string;
  /** `litellm_params.model`: the provider-prefixed deployment behind the alias. */
  backend: string | null;
  /** `azure`, `azure_ai`, `bedrock` — the `provider` dimension's key. */
  provider: string | null;
  /** `chat`, `embedding`, `rerank`, … — null when the proxy did not say. */
  mode: string | null;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  /** Reading a cached prompt token, where the backend prices it separately. */
  cacheReadPerMillion: number | null;
  /** Writing one into the cache — dearer than plain input on every backend. */
  cacheWritePerMillion: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  /** How many router deployments answer to this alias. Always ≥ 1. */
  deployments: number;
  /**
   * Those deployments do not all charge the same. The alias is one row because
   * the daily aggregate has no deployment id to split it by, so the price
   * reported is the **cheapest** of them and is a floor rather than a rate. Any
   * surface reading it has to say so, exactly as the MCP-attributed split does.
   */
  priceVaries: boolean;
}

/** Everything `GET /api/gateway/models` returns. */
export interface GatewayModels {
  models: GatewayModelPrice[];
}

/**
 * The catalogue entry for a key of the `model` usage dimension, or null.
 *
 * Three attempts, narrowing, because the string the aggregates report is not
 * guaranteed to be the string the catalogue is keyed by:
 *
 *  1. the public alias, which is what a correctly configured proxy records;
 *  2. the backend routing string, which is what it records when the caller
 *     passed a fully qualified model rather than an alias;
 *  3. the deployment after the provider prefix, which is what
 *     `_get_proxy_model_info`'s own third pass falls back to.
 *
 * A miss returns null rather than a guess. Coverage — how much of the gateway's
 * spend sits on models the catalogue could price — is then a real number a card
 * can lead with, in the same way `gatewayAdoption` leads with attribution
 * coverage, and a fuzzy match would quietly destroy it.
 */
export function resolveModelPrice(
  catalogue: readonly GatewayModelPrice[],
  key: string,
): GatewayModelPrice | null {
  const wanted = key.trim();
  if (wanted === '') return null;

  const byAlias = catalogue.find((entry) => entry.model === wanted);
  if (byAlias !== undefined) return byAlias;

  const byBackend = catalogue.find((entry) => entry.backend === wanted);
  if (byBackend !== undefined) return byBackend;

  const tail = wanted.slice(wanted.indexOf('/') + 1);
  if (tail === wanted) return null;
  return (
    catalogue.find((entry) => entry.model === tail || entry.backend?.endsWith(`/${tail}`) === true) ??
    null
  );
}

/**
 * ─── Budgets and limits ──────────────────────────────────────────────────────
 *
 * Everything above is *usage*: what the gateway did, per day, forever. A budget
 * is the opposite kind of fact — current configuration plus the proxy's own
 * live counter. There is exactly one row per key, per team and per configured
 * tag, it is replaced wholesale on every sync, and it has no history.
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
 *
 * And one rule that holds per *scope* rather than gateway-wide: whether that
 * counter resets at all. See `budgetCounterResets`.
 */

/**
 * Whose budget it is. Each scope joins the usage dimension of the same name by
 * `key`, which is what lets a cap be read next to the spend it governs.
 */
export const GATEWAY_BUDGET_SCOPES = ['api_key', 'team', 'tag'] as const;
export type GatewayBudgetScope = (typeof GATEWAY_BUDGET_SCOPES)[number];

export const GATEWAY_BUDGET_SCOPE_LABELS: Record<GatewayBudgetScope, string> = {
  api_key: 'API key',
  team: 'Team',
  tag: 'Tag',
};

/**
 * Does the proxy zero this scope's `spend` counter when its period rolls?
 *
 * For a key and a team, yes: LiteLLM's `ResetBudgetJob` walks both tables, so
 * the counter is spend *within the period in flight* and everything built on
 * that reading — a pace projection, a closed-period total, a period reset in the
 * history — means what it says.
 *
 * For a tag, **no**. `LiteLLM_TagTable.spend` has no handler in that job: the
 * linked budget row's `budget_reset_at` advances every cycle while the tag's own
 * counter keeps climbing (BerriAI/litellm#27481). So a tag's `spend` is
 * cumulative since the tag was created, whatever its `budget_duration` says.
 *
 * Two consequences, and both are the point of this predicate existing rather
 * than the rule being spelled out at each call site:
 *
 *  - **Nothing may divide that counter by a fraction of a period.** A pace
 *    projection over a lifetime counter multiplies months of spend by six and
 *    calls it a forecast. It has to be withheld, not computed and caveated.
 *  - **Utilisation still stands, and is the reason the scope is worth reading
 *    at all.** The proxy enforces the cap against this same non-resetting
 *    number, so a tag over its cap really is being refused — and, until the
 *    upstream job learns to reset it, stays refused for good rather than until
 *    the month turns. That is a finding, not a rendering artefact.
 *
 * A property of the scope, not of a row: it is a statement about the proxy's
 * reset job, so it needs no column and no migration, and the API, the card and
 * the invariant scripts all read the one rule.
 */
export function budgetCounterResets(scope: GatewayBudgetScope): boolean {
  return scope !== 'tag';
}

/**
 * One governed object on the proxy — a virtual key, a team or a tag.
 *
 * `key` is the same id the matching usage dimension reports (the hashed key
 * token for `api_key`, the team id for `team`, the tag name for `tag`), which is
 * what lets a budget row be read next to the spend it governs without a second
 * join key.
 */
export interface GatewayBudget {
  scope: GatewayBudgetScope;
  key: string;
  /** Alias the proxy resolved — `key_alias` / `team_alias`; null renders as `—`. */
  label: string | null;
  /**
   * LiteLLM's own spend counter, dollars — for the period in flight on every
   * scope whose `budgetCounterResets` is true, and cumulative since creation on
   * the one where it is not.
   */
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

/**
 * ─── Budget assessment ───────────────────────────────────────────────────────
 *
 * What state a governed object is in, and what its counter is heading for.
 *
 * This lives in `@dash/shared` rather than in the browser's metrics layer for
 * one reason: two things now read it. The budget card derives it from
 * `GET /api/gateway/budgets` to render a table, and the API derives it after
 * every full sync to decide what to *send* somewhere. If each owned its own
 * copy of "over its cap" they would drift the first time one of them was
 * adjusted — a notification saying a key is fine while the card it links to says
 * it is blocked is the same two-answers failure the attention digest is built to
 * avoid, only worse, because one of the answers arrives by mail.
 *
 * Pure and clock-injected: `now` is a parameter, so a projection is testable
 * and a server evaluating at 07:00 and a browser rendering at noon differ only
 * by the argument they passed.
 */

/**
 * Worst first.
 *
 *  - `blocked` — the proxy is rejecting its calls right now, either because an
 *    admin disabled it or because it is budgeted at zero dollars. Two different
 *    causes, one observable effect, so they share a state and carry a reason.
 *  - `over` — past its hard cap. A proxy can bill past a cap on in-flight
 *    requests, so this is reachable without `blocked` being set.
 *  - `soft` — past the alert threshold its owner set, still under the cap. The
 *    last state anybody can act on before calls start failing.
 *  - `warn` — no soft budget configured, but far enough through the cap to say
 *    so. Derived, not reported — a stand-in for the threshold nobody set.
 *  - `ok` — capped and comfortably under.
 *  - `uncapped` — no hard cap at all. Not a good state and not a bad one: on a
 *    corporate gateway the biggest workload is usually the one nobody dares cap.
 */
export type GatewayBudgetState = 'blocked' | 'over' | 'soft' | 'warn' | 'ok' | 'uncapped';

/** Why a `blocked` row is blocked. Null on every other state. */
export type GatewayBudgetBlockReason = 'disabled' | 'zero-cap';

export interface GatewayBudgetAssessmentOptions {
  /**
   * Share of the cap at which a row with no soft budget is called out anyway.
   *
   * A derived threshold is weaker evidence than a configured one — the owner
   * said nothing about 80% — so it gets its own state rather than being folded
   * into `soft`, and both readers word it differently.
   */
  warnAt: number;
  /**
   * How far into a period the pace projection starts answering.
   *
   * `spend ÷ elapsed` is a ratio of two small numbers early on and it swings
   * wildly: one batch job on the first morning of a month projects thirty times
   * itself. A sixth of the period is roughly where a single day stops dominating
   * a monthly counter.
   */
  minElapsed: number;
}

export const DEFAULT_BUDGET_ASSESSMENT_OPTIONS: GatewayBudgetAssessmentOptions = {
  warnAt: 0.8,
  minElapsed: 1 / 6,
};

/** Everything derivable about one governed object from its own row plus a clock. */
export interface GatewayBudgetAssessment {
  state: GatewayBudgetState;
  blockReason: GatewayBudgetBlockReason | null;
  /** Share of the hard cap consumed, 0–100 and above 100 on overrun. Null when uncapped. */
  utilization: number | null;
  /** Dollars left before the cap; negative when overrun. Null when uncapped. */
  remaining: number | null;
  /** Where the soft budget sits on the cap's scale, 0–100. Null when unset or uncapped. */
  softMark: number | null;
  /** ISO instant the period in flight began — `resetAt` less one duration. */
  periodStart: string | null;
  /** Fraction of the period elapsed at `now`, 0–1. Null when the period is unknown. */
  periodElapsed: number | null;
  /**
   * What this period ends at if the current pace holds — `spend ÷ elapsed`.
   *
   * Deliberately linear, deliberately null early in a period, and null for a row
   * with no period at all — which is not a gap in the maths but the fact that a
   * counter that never resets has no period to project to the end of.
   *
   * Also null for every row whose counter the proxy does not reset, however
   * clearly its budget states a period — see `spendIsCumulative`.
   */
  projectedSpend: number | null;
  /** Projected past the cap while not yet over it — the actionable one. */
  projectedOverrun: boolean;
  /** Either limit set. A key with no budget but a TPM ceiling is still governed. */
  rateLimited: boolean;
  /**
   * The counter is spend since the object was created, not spend this period.
   *
   * True for the `tag` scope and nothing else, and it is a statement about
   * LiteLLM rather than about this row (BerriAI/litellm#27481). `utilization` is
   * *more* meaningful here than elsewhere — it is the exact comparison the proxy
   * enforces — while `projectedSpend` is withheld entirely, because dividing a
   * lifetime counter by a fraction of one period is not a slow forecast, it is a
   * wrong one.
   */
  spendIsCumulative: boolean;
}

function classifyBudget(
  budget: Readonly<GatewayBudget>,
  utilization: number | null,
  options: GatewayBudgetAssessmentOptions,
): { state: GatewayBudgetState; blockReason: GatewayBudgetBlockReason | null } {
  // Both block states are checked before anything else because they describe
  // what is happening to calls *now*, which outranks any percentage. A key
  // budgeted at zero is not "0% of its budget used" — it is closed.
  if (budget.blocked) return { state: 'blocked', blockReason: 'disabled' };
  if (budget.maxBudget === 0) return { state: 'blocked', blockReason: 'zero-cap' };
  if (budget.maxBudget === null || utilization === null) {
    return { state: 'uncapped', blockReason: null };
  }
  if (utilization >= 100) return { state: 'over', blockReason: null };
  if (budget.softBudget !== null && budget.spend >= budget.softBudget) {
    return { state: 'soft', blockReason: null };
  }
  if (utilization >= options.warnAt * 100) return { state: 'warn', blockReason: null };
  return { state: 'ok', blockReason: null };
}

/**
 * How far through its period a budget is, 0–1, or null when that is unknowable.
 *
 * Needs both ends: `resetAt` from the proxy and a parseable duration to walk
 * back from it. A counter with no period has no elapsed fraction — it is not 0%
 * through a period, it is outside the concept.
 */
function elapsedFraction(
  budget: Readonly<GatewayBudget>,
  periodStart: string | null,
  now: Date,
): number | null {
  if (periodStart === null || budget.resetAt === null) return null;
  const start = new Date(periodStart).getTime();
  const end = new Date(budget.resetAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.min(1, Math.max(0, (now.getTime() - start) / (end - start)));
}

/** Classify one governed object and project its period. Pure; `now` decides the pace only. */
export function assessBudget(
  budget: Readonly<GatewayBudget>,
  now: Date,
  options: GatewayBudgetAssessmentOptions = DEFAULT_BUDGET_ASSESSMENT_OPTIONS,
): GatewayBudgetAssessment {
  const utilization = budgetUtilization(budget);
  const { state, blockReason } = classifyBudget(budget, utilization, options);
  const periodStart = budgetPeriodStart(budget);
  const periodElapsed = elapsedFraction(budget, periodStart, now);
  const spendIsCumulative = !budgetCounterResets(budget.scope);

  // The period is still reported — the cap's window is real and "resets in four
  // days" is true — but the pace is not, because the numerator does not belong
  // to the denominator on a scope whose counter never went back to zero.
  const projectedSpend =
    !spendIsCumulative && periodElapsed !== null && periodElapsed >= options.minElapsed
      ? budget.spend / periodElapsed
      : null;

  return {
    state,
    blockReason,
    utilization,
    remaining: budgetRemaining(budget),
    softMark:
      budget.softBudget === null || budget.maxBudget === null || budget.maxBudget <= 0
        ? null
        : Math.min(100, (budget.softBudget / budget.maxBudget) * 100),
    periodStart,
    periodElapsed,
    projectedSpend,
    projectedOverrun:
      projectedSpend !== null &&
      budget.maxBudget !== null &&
      budget.maxBudget > 0 &&
      state !== 'over' &&
      state !== 'blocked' &&
      projectedSpend > budget.maxBudget,
    rateLimited: budget.tpmLimit !== null || budget.rpmLimit !== null,
    spendIsCumulative,
  };
}

/**
 * ─── Governance findings that can leave the page ─────────────────────────────
 *
 * The attention digest on the gateway page collects findings from six sources,
 * five of which are derived in the browser from the usage payload. These four
 * are the subset the *server* can reach on its own, because governance is a
 * table rather than a derivation: after every full sync the API can assess the
 * same snapshot the card will, and hand what it finds to something outside the
 * dashboard.
 *
 * The kinds and their severities are shared with the page's digest rather than
 * re-declared, so a mailed alert and the card it names cannot disagree about how
 * urgent the same state is.
 */
export const GATEWAY_BUDGET_ALERT_KINDS = [
  'budget-blocked',
  'budget-over',
  'budget-soft',
  'budget-pacing',
] as const;
export type GatewayBudgetAlertKind = (typeof GATEWAY_BUDGET_ALERT_KINDS)[number];

/**
 * Editorial, not a second test: `critical` is calls already being rejected or
 * money already past a line somebody drew, `warning` is a decision somebody owes.
 */
export const GATEWAY_BUDGET_ALERT_SEVERITY: Record<
  GatewayBudgetAlertKind,
  'critical' | 'warning'
> = {
  'budget-blocked': 'critical',
  'budget-over': 'critical',
  'budget-soft': 'warning',
  'budget-pacing': 'warning',
};

/**
 * One governance finding, with the numbers that justify it.
 *
 * `fingerprint` is the identity of the *episode*, not of the reading: the same
 * key still over the same cap tomorrow is the same finding and must not be sent
 * again. It deliberately excludes every number, so a counter climbing from 104%
 * to 137% does not re-alert — while a key crossing from `soft` to `over` does,
 * because the kind changed.
 */
export interface GatewayBudgetAlert {
  kind: GatewayBudgetAlertKind;
  severity: 'critical' | 'warning';
  scope: GatewayBudgetScope;
  key: string;
  label: string | null;
  fingerprint: string;
  state: GatewayBudgetState;
  blockReason: GatewayBudgetBlockReason | null;
  spend: number;
  maxBudget: number | null;
  utilization: number | null;
  projectedSpend: number | null;
  spendIsCumulative: boolean;
}

export function budgetAlertFingerprint(
  kind: GatewayBudgetAlertKind,
  scope: GatewayBudgetScope,
  key: string,
): string {
  return `${kind}:${scope}:${key}`;
}

const ALERT_KIND_ORDER: Record<GatewayBudgetAlertKind, number> = {
  'budget-blocked': 0,
  'budget-over': 1,
  'budget-soft': 2,
  'budget-pacing': 3,
};

/**
 * The governance findings a budget snapshot carries, worst first.
 *
 * At most one *state* finding per object — the states are ordered and a row is
 * in exactly one of them — plus a pace finding, which is a different claim about
 * the same row ("not over yet, but heading there") and is deliberately kept
 * beside a `soft` finding rather than folded into it. `warn`, `ok` and
 * `uncapped` produce nothing: a derived threshold nobody configured is worth a
 * row on a card and is not worth waking somebody, and an uncapped key is a
 * standing decision rather than an event.
 */
export function deriveBudgetAlerts(
  budgets: readonly GatewayBudget[],
  now: Date,
  options: GatewayBudgetAssessmentOptions = DEFAULT_BUDGET_ASSESSMENT_OPTIONS,
): GatewayBudgetAlert[] {
  const alerts: GatewayBudgetAlert[] = [];

  for (const budget of budgets) {
    const assessment = assessBudget(budget, now, options);
    const kinds: GatewayBudgetAlertKind[] = [];
    if (assessment.state === 'blocked') kinds.push('budget-blocked');
    else if (assessment.state === 'over') kinds.push('budget-over');
    else if (assessment.state === 'soft') kinds.push('budget-soft');
    if (assessment.projectedOverrun) kinds.push('budget-pacing');

    for (const kind of kinds) {
      alerts.push({
        kind,
        severity: GATEWAY_BUDGET_ALERT_SEVERITY[kind],
        scope: budget.scope,
        key: budget.key,
        label: budget.label,
        fingerprint: budgetAlertFingerprint(kind, budget.scope, budget.key),
        state: assessment.state,
        blockReason: assessment.blockReason,
        spend: budget.spend,
        maxBudget: budget.maxBudget,
        utilization: assessment.utilization,
        projectedSpend: assessment.projectedSpend,
        spendIsCumulative: assessment.spendIsCumulative,
      });
    }
  }

  alerts.sort((a, b) => {
    if (a.kind !== b.kind) return ALERT_KIND_ORDER[a.kind] - ALERT_KIND_ORDER[b.kind];
    // Within a kind, by how far past the line — uncapped rows cannot appear here
    // except as `blocked`, which has no percentage, so those fall back to spend.
    const left = a.utilization ?? Number.NEGATIVE_INFINITY;
    const right = b.utilization ?? Number.NEGATIVE_INFINITY;
    if (left !== right) return right > left ? 1 : -1;
    if (a.spend !== b.spend) return b.spend - a.spend;
    return (a.label ?? a.key).localeCompare(b.label ?? b.key);
  });

  return alerts;
}

/**
 * How one finding reads as a sentence.
 *
 * Shared because it is sent *and* displayed: the webhook body carries it so a
 * chat client that renders nothing but text still says something useful, and the
 * delivery panel renders the same string. Two copies would let the message
 * somebody received and the row explaining it drift apart, which is the one
 * thing an alert channel cannot afford.
 */
export function describeBudgetAlert(
  alert: Pick<
    GatewayBudgetAlert,
    'kind' | 'scope' | 'key' | 'label' | 'spend' | 'maxBudget' | 'utilization'
  >,
): string {
  const who = `${GATEWAY_BUDGET_SCOPE_LABELS[alert.scope]} ${alert.label ?? alert.key}`;
  const usd = (value: number): string => `$${value.toFixed(2)}`;
  const share = alert.utilization === null ? null : `${alert.utilization.toFixed(1)}%`;

  switch (alert.kind) {
    case 'budget-blocked':
      return `${who} is blocked — the proxy is rejecting its calls`;
    case 'budget-over':
      return `${who} is over its budget: ${usd(alert.spend)} of ${
        alert.maxBudget === null ? 'no cap' : usd(alert.maxBudget)
      }${share === null ? '' : ` (${share})`}`;
    case 'budget-soft':
      return `${who} is past its soft budget: ${usd(alert.spend)}${
        share === null ? '' : ` (${share} of cap)`
      }`;
    case 'budget-pacing':
      return `${who} is pacing past its cap${
        alert.maxBudget === null ? '' : ` of ${usd(alert.maxBudget)}`
      } before the period ends`;
  }
}

/**
 * ─── Notification records ────────────────────────────────────────────────────
 *
 * What was found, when it was first found, and whether it left the building.
 *
 * The table behind this is the de-duplication story: an alert is delivered once
 * per *episode*, and an episode is bounded by the finding disappearing. Three
 * rules fall out of that, and they are what keep a nightly evaluation from
 * becoming a nightly mailing:
 *
 *  - **A finding still true tomorrow is not a new alert.** Only `lastSeenAt`
 *    moves. This is why the fingerprint carries no numbers.
 *  - **A resolution is recorded, not delivered.** `clearedAt` is what makes the
 *    next appearance a new episode; sending "the key is fine again" is a
 *    different product decision and this one deliberately does not make it.
 *  - **An undelivered finding stays undelivered.** A failed webhook, or no
 *    webhook configured at all, leaves `deliveredAt` null, so the next sync
 *    retries it. That is the whole retry policy — there is no queue, because the
 *    sync is already a schedule.
 */
export interface GatewayNotification {
  fingerprint: string;
  kind: GatewayBudgetAlertKind;
  severity: 'critical' | 'warning';
  scope: GatewayBudgetScope;
  key: string;
  label: string | null;
  /** The state as of the most recent evaluation, with the numbers behind it. */
  state: GatewayBudgetState;
  spend: number;
  maxBudget: number | null;
  utilization: number | null;
  /** ISO instant this episode began — not the first time the object was seen. */
  firstSeenAt: string;
  /** ISO instant the finding was last still true. */
  lastSeenAt: string;
  /** ISO instant it stopped being true; null while it is open. */
  clearedAt: string | null;
  /** ISO instant it was accepted by the delivery target; null while pending. */
  deliveredAt: string | null;
  /** How many delivery attempts this episode has cost. */
  deliveryAttempts: number;
  /** Why the last attempt failed. Null when it succeeded or was never tried. */
  deliveryError: string | null;
}

/** Everything `GET /api/gateway/notifications` returns. */
export interface GatewayNotifications {
  notifications: GatewayNotification[];
  /** A delivery target is configured — without one, findings accrue as pending. */
  deliveryConfigured: boolean;
  /** Open findings, i.e. `clearedAt === null`. */
  open: number;
  /** Open and not yet delivered — what the next sync will try to send. */
  pending: number;
  /**
   * ISO instant governance was last evaluated — the finish of the last
   * successful full sync, since that is what runs the evaluation. Taken from the
   * job rather than from these rows so "nothing is open" and "nothing has ever
   * run" stay distinguishable, exactly as `recordingSince` does for history.
   */
  evaluatedAt: string | null;
}

/**
 * ─── Budget history ──────────────────────────────────────────────────────────
 *
 * `gateway_budget` is current state and nothing else: every sync replaces it,
 * so the moment a key's counter rolls, or its cap is raised, the previous fact
 * is gone. That makes three ordinary governance questions unanswerable — "when
 * did this team go over", "what did it spend last period", "who raised this
 * cap" — and none of them can be recovered from `gateway_daily`, because the
 * proxy's enforced counter runs on the key's own period and is not our sum.
 *
 * So the sync also *appends* what it saw. One row per governed object per UTC
 * day, upserted, so the last observation of a day wins: the table grows with
 * the gateway and the calendar, never with how often the scheduler runs, and a
 * dashboard synced hourly costs exactly what one synced nightly does.
 *
 * Three things follow, and they are what the derivation on top has to respect:
 *
 *  - **It is a sample, not a series.** A day with no observation is *unknown*,
 *    not zero and not "unchanged". Nothing here may be interpolated.
 *  - **A period total read from it is a floor.** The counter is only seen once
 *    a day, so the last value before a roll misses whatever landed between the
 *    observation and the reset.
 *  - **History starts when recording started.** There is no backfill: the proxy
 *    does not serve past budget state, and it never will.
 */

/**
 * One governed object as the proxy had it on one UTC day — the same fields as
 * `GatewayBudget`, stamped with when they were seen.
 *
 * `scope`/`key` join to the budget snapshot and to the usage dimension of the
 * same name, so an observation can be read next to both.
 */
export interface GatewayBudgetObservation {
  scope: GatewayBudgetScope;
  key: string;
  /** The alias as it read *that day* — a renamed team shows its old name here. */
  label: string | null;
  /** UTC calendar day the observation belongs to, `YYYY-MM-DD`. */
  date: string;
  /** ISO instant of the sync whose reading this row kept — the last one that day. */
  observedAt: string;
  /** LiteLLM's own counter for the period that was in flight at `observedAt`. */
  spend: number;
  maxBudget: number | null;
  softBudget: number | null;
  budgetDuration: string | null;
  resetAt: string | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
  blocked: boolean;
}

/** Everything `GET /api/gateway/budgets/history` returns for a day window. */
export interface GatewayBudgetHistory {
  /** The inclusive window asked for, whether or not anything was recorded in it. */
  from: string;
  to: string;
  /**
   * The earliest day the table holds *any* observation, ignoring the window.
   *
   * The one number that separates "this key was never over its cap" from "we
   * were not watching yet", which is why it is answered outside the range.
   */
  recordingSince: string | null;
  /** Ascending by date, then scope, then key. */
  observations: GatewayBudgetObservation[];
}

/* ------------------------------------------------------- deployment health */

/**
 * ─── Deployment health ───────────────────────────────────────────────────────
 *
 * Every other gateway fact in this file is keyed by something a *caller* can
 * name — a model alias, a key, a team, a tag. This one is keyed by a
 * **deployment**: the individual Azure Foundry / Azure OpenAI / Bedrock
 * endpoint the router picked, which no usage payload carries and no card above
 * can see.
 *
 * That gap is not cosmetic. LiteLLM load-balances several deployments behind
 * one public alias and fails over silently between them, so an alias with three
 * regions and one of them dead answers every request successfully, bills
 * normally, and shows nothing at all on the reliability card — it is running on
 * a third less capacity and the only surface that says so is `/health`. The one
 * statement worth making from this data is therefore about the *alias*:
 *
 *  - **down** — every deployment behind it is failing. Nothing routed there can
 *    succeed, and this is the only state the usage payload would eventually see
 *    (as failures, tomorrow).
 *  - **degraded** — some are failing and some are not. The alias still answers.
 *    This is a *capacity* finding rather than an error one, it is invisible in
 *    spend and in failures alike, and it is the reason this table exists.
 *  - **up** — nothing is failing.
 *
 * Deployment health is current state, like budgets and the price catalogue: one
 * row per deployment, replaced wholesale by every full sync, no history.
 */

/** One deployment as `GET /health` last reported it. */
export interface GatewayDeployment {
  /**
   * LiteLLM's own deployment id (`model_info.id`), or the routing string when
   * the proxy reported none — an id is what makes two deployments of one alias
   * two rows rather than one.
   */
  id: string;
  /** The routing string it answers on: `azure/gpt-4o-eu2`, `bedrock/anthropic…`. */
  backend: string;
  /**
   * The public alias it serves, resolved through the price catalogue — null
   * when nothing in the catalogue names it.
   *
   * Health reports deployments and the catalogue reports aliases, so this join
   * is `resolveModelPrice` run backwards; a null is a deployment the router
   * offers under a name the catalogue did not answer with, which is worth
   * showing rather than dropping.
   */
  model: string | null;
  provider: string | null;
  /**
   * The endpoint it fronts. Null when the proxy is configured with
   * `health_check_details: false`, which strips URLs and error text from the
   * response — a deliberate setting on a widely exposed proxy, so an absent
   * base is not a fault.
   */
  apiBase: string | null;
  healthy: boolean;
  /** The proxy's error text. Null on a healthy deployment *and* on a stripped one. */
  error: string | null;
  /** The upstream status the failure carried (`exception_status`), where it had one. */
  errorStatus: number | null;
  /** When the sync last read `/health`. */
  checkedAt: string;
}

/** Everything `GET /api/gateway/health` returns. */
export interface GatewayHealth {
  deployments: GatewayDeployment[];
  /**
   * When the stored reading was taken, or null when `/health` has never
   * answered. Kept apart from an empty deployment list for the same reason
   * `evaluatedAt` is on the notifications route: "the proxy routes nothing" and
   * "we have never asked" are different answers.
   */
  checkedAt: string | null;
}

export const GATEWAY_MODEL_HEALTH_STATES = ['up', 'degraded', 'down'] as const;
export type GatewayModelHealthState = (typeof GATEWAY_MODEL_HEALTH_STATES)[number];

/** One public alias, with every deployment the router has behind it. */
export interface GatewayModelHealth {
  /** The alias, or null for the deployments the catalogue could not name. */
  model: string | null;
  state: GatewayModelHealthState;
  deployments: number;
  unhealthy: number;
  /** Distinct providers behind the alias — more than one is a cross-cloud alias. */
  providers: string[];
  /** Distinct error texts, deduplicated: three regions failing identically is one fault. */
  errors: string[];
}

export interface GatewayProviderHealth {
  provider: string | null;
  deployments: number;
  unhealthy: number;
}

export interface GatewayHealthSummary {
  checkedAt: string | null;
  deployments: number;
  unhealthy: number;
  /** Every alias with at least one deployment, worst state first. */
  models: GatewayModelHealth[];
  /** `models` filtered — the two states worth a finding, kept out of the caller's way. */
  down: GatewayModelHealth[];
  degraded: GatewayModelHealth[];
  /** One row per backend. A whole cloud failing is a different incident from one model. */
  providers: GatewayProviderHealth[];
  /** Deployments no catalogue row named — counted, never silently merged. */
  unnamed: number;
}

/**
 * The catalogue row a deployment belongs to, resolved backwards.
 *
 * `resolveModelPrice` goes alias → catalogue; this goes deployment → alias,
 * which is the direction `/health` forces because it reports `litellm_params`
 * and never the public name. Two attempts, narrowing, and a miss is null:
 *
 *  1. the routing string matches a catalogue row's `backend`, which is what a
 *     proxy whose alias differs from its deployment reports;
 *  2. it matches a row's own `model`, which is what a proxy that never renamed
 *     anything reports — there the alias *is* the routing string.
 *
 * Deliberately no suffix matching. A near-match here would put a deployment
 * under an alias it does not serve, and the whole value of the row is knowing
 * which alias loses capacity when it fails.
 *
 * Takes the two columns it reads rather than a `GatewayModelPrice`, so the sync
 * can hand it storage-shaped catalogue rows (prices in nano) without converting
 * a price list to answer a question about names.
 */
export function resolveDeploymentModel(
  catalogue: readonly { model: string; backend: string | null }[],
  backend: string,
): string | null {
  const wanted = backend.trim();
  if (wanted === '') return null;
  return (
    catalogue.find((entry) => entry.backend === wanted)?.model ??
    catalogue.find((entry) => entry.model === wanted)?.model ??
    null
  );
}

/**
 * Deployments → the per-alias reading the page actually shows.
 *
 * Pure, and the only place the up/degraded/down rule is written. The ordering
 * is worst-first and then by blast radius (how many deployments are affected),
 * because a four-region alias with two dead regions is a bigger problem than a
 * single-deployment model that is merely degraded — which it cannot be, by
 * construction: a lone deployment is either up or down.
 */
export function summarizeDeploymentHealth(
  deployments: readonly GatewayDeployment[],
  checkedAt: string | null,
): GatewayHealthSummary {
  // Keyed by the alias itself, null included: a Map takes null as a key, which
  // is what keeps the unnamed deployments a bucket of their own rather than a
  // sentinel string some alias could one day collide with.
  const byModel = new Map<string | null, GatewayDeployment[]>();
  for (const deployment of deployments) {
    const key = deployment.model;
    const bucket = byModel.get(key);
    if (bucket === undefined) byModel.set(key, [deployment]);
    else bucket.push(deployment);
  }

  const models: GatewayModelHealth[] = [...byModel.values()].map((group) => {
    const unhealthy = group.filter((entry) => !entry.healthy).length;
    const first = group[0];
    return {
      model: first?.model ?? null,
      state: unhealthy === 0 ? 'up' : unhealthy === group.length ? 'down' : 'degraded',
      deployments: group.length,
      unhealthy,
      providers: [
        ...new Set(
          group
            .map((entry) => entry.provider)
            .filter((provider): provider is string => provider !== null),
        ),
      ].sort((a, b) => a.localeCompare(b)),
      errors: [
        ...new Set(
          group
            .map((entry) => entry.error)
            .filter((error): error is string => error !== null && error !== ''),
        ),
      ],
    };
  });

  const rank: Record<GatewayModelHealthState, number> = { down: 0, degraded: 1, up: 2 };
  models.sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    if (a.unhealthy !== b.unhealthy) return b.unhealthy - a.unhealthy;
    return (a.model ?? '').localeCompare(b.model ?? '');
  });

  const byProvider = new Map<string | null, GatewayProviderHealth>();
  for (const deployment of deployments) {
    const key = deployment.provider;
    const row = byProvider.get(key) ?? {
      provider: deployment.provider,
      deployments: 0,
      unhealthy: 0,
    };
    row.deployments += 1;
    if (!deployment.healthy) row.unhealthy += 1;
    byProvider.set(key, row);
  }

  return {
    checkedAt,
    deployments: deployments.length,
    unhealthy: deployments.filter((entry) => !entry.healthy).length,
    models,
    down: models.filter((entry) => entry.state === 'down'),
    degraded: models.filter((entry) => entry.state === 'degraded'),
    providers: [...byProvider.values()].sort((a, b) => {
      if (a.unhealthy !== b.unhealthy) return b.unhealthy - a.unhealthy;
      return (a.provider ?? '').localeCompare(b.provider ?? '');
    }),
    unnamed: deployments.filter((entry) => entry.model === null).length,
  };
}

/* -------------------------------------------- deployment health history */

/**
 * What `/health` said on the days it was asked — the one deployment fact that
 * has a range.
 *
 * `gateway_deployment_health` is current state and answers "is this alias
 * losing capacity right now". It cannot answer the question an owner asks
 * next, which is whether that has been true for a week: a pool that refuses
 * every night is a standing fault somebody has to fix, and one that refused
 * once is a blip. Both look identical in the snapshot.
 *
 * The recording is a **sample, not a series**, and more emphatically so than
 * the budget one. A budget counter changes on the proxy's schedule and a daily
 * reading of it is a fair spot check; a deployment can fail and recover between
 * two readings and leave nothing behind. So every number here is counted in
 * *readings* rather than in days or in hours, nothing is interpolated across a
 * day nobody looked at, and there is no availability percentage anywhere —
 * "failing at 9 of 14 readings" is a fact, "64% uptime" is not.
 */

/** One deployment as `/health` read on one UTC day. */
export interface GatewayDeploymentObservation {
  /** LiteLLM's `model_info.id`, or the routing string — the deployment's identity. */
  id: string;
  backend: string;
  /** The alias it served *that day*, as resolved then. A re-alias is itself a change. */
  model: string | null;
  provider: string | null;
  /** The UTC day the reading was filed under. */
  date: string;
  /** The instant the reading was taken — what says where in the day it landed. */
  observedAt: string;
  healthy: boolean;
  error: string | null;
  errorStatus: number | null;
}

/** Everything `GET /api/gateway/health/history` returns. */
export interface GatewayDeploymentHistory {
  from: string;
  to: string;
  /**
   * The first day any reading was ever filed, answered outside the window on
   * purpose: without it, "this deployment never failed in the last 30 days" is
   * indistinguishable from "recording started yesterday", and only the first is
   * a finding.
   */
  recordingSince: string | null;
  observations: GatewayDeploymentObservation[];
}

/**
 * A run of consecutive *readings* that all said failing.
 *
 * Bounded by dates because that is how it is shown, but measured in readings
 * because that is what was observed. A day inside the span that carries no
 * reading does not break the run — claiming two episodes there would assert a
 * recovery nobody saw, which is the same invention as claiming one long one —
 * so it is counted and reported instead.
 */
export interface GatewayDeploymentOutage {
  /** First day observed failing. */
  from: string;
  /** Last day observed failing. */
  to: string;
  /** How many readings inside the span said failing. The evidence, not a duration. */
  readings: number;
  /** Calendar days inside the span with no reading at all. Neither failing nor recovered. */
  unobservedDays: number;
  /** True when the run reaches this deployment's newest reading — it has not recovered. */
  open: boolean;
  /** Distinct error texts across the run: three nights of the same fault is one message. */
  errors: string[];
}

/** One deployment read across the window. */
export interface GatewayDeploymentUptime {
  id: string;
  /** The routing string as of the newest reading. */
  backend: string;
  /** The alias as of the newest reading — see `renamed` when the older ones disagree. */
  model: string | null;
  provider: string | null;
  /** How many days carried a reading of this deployment. */
  readings: number;
  failingReadings: number;
  /** failingReadings ÷ readings. A share of *readings*, never of time. */
  failingShare: number;
  firstSeen: string;
  lastSeen: string;
  /** The newest reading's state. */
  lastHealthy: boolean;
  /** State changes between consecutive readings. A stable deployment has none. */
  transitions: number;
  outages: GatewayDeploymentOutage[];
  /** The open run, when the newest reading is failing. */
  standing: GatewayDeploymentOutage | null;
  /** The run with the most failing readings. */
  longest: GatewayDeploymentOutage | null;
  /** Healthy at the previous reading, failing at the newest. */
  newlyFailing: boolean;
  /** Failing at the previous reading, healthy at the newest. */
  recovered: boolean;
  /** The alias this deployment served changed inside the window. */
  renamed: boolean;
}

/** Gateway-wide, for one observed day. */
export interface GatewayDeploymentHistoryDay {
  date: string;
  deployments: number;
  unhealthy: number;
}

export interface GatewayDeploymentHistorySummary {
  from: string;
  to: string;
  recordingSince: string | null;
  /** Days that carry at least one reading, ascending. The sample, not the calendar. */
  observedDays: string[];
  days: GatewayDeploymentHistoryDay[];
  /** Every deployment seen in the window, worst first. */
  deployments: GatewayDeploymentUptime[];
  /** Failing now, and for long enough that it is a fault rather than a blip. */
  standing: GatewayDeploymentUptime[];
  /** More than one distinct episode in the window — intermittent, not broken. */
  flapping: GatewayDeploymentUptime[];
  /** Distinct runs across every deployment. */
  outages: number;
}

/**
 * How many consecutive failing readings make an open run a *standing* fault.
 *
 * Three, because the sync runs nightly: one is the snapshot's own finding and
 * says nothing new, two could be one incident spanning a night, and three is
 * the first count that cannot be explained by a single evening's trouble. It is
 * deliberately a count of readings rather than a number of days — a scheduler
 * that missed a night makes those the same thing and the readings are what was
 * actually seen.
 */
export const STANDING_OUTAGE_READINGS = 3;

/** Distinct runs in the window that make a deployment intermittent rather than broken. */
export const FLAPPING_OUTAGES = 2;

/** `2026-07-31`, `2026-07-28` → 3. Both UTC midnights, so DST never shifts it. */
function daysBetweenIso(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Observations → what each deployment did across the window.
 *
 * Pure, and the counterpart to `summarizeDeploymentHealth`: that one states the
 * up/degraded/down rule over one reading, this one states what a *sequence* of
 * readings may and may not be read to mean. Three rules carry it:
 *
 *  - a run is broken by an observed recovery and by nothing else, so an
 *    unobserved day is reported inside the run rather than splitting it;
 *  - every count is of readings, so nothing here can be read as a duration;
 *  - a deployment with no reading in the window is absent rather than healthy.
 *
 * Ordering is standing faults first, then by failing readings, so the row that
 * needs somebody is at the top whatever the window.
 */
export function summarizeDeploymentHistory(
  history: GatewayDeploymentHistory,
): GatewayDeploymentHistorySummary {
  const byDeployment = new Map<string, GatewayDeploymentObservation[]>();
  for (const observation of history.observations) {
    const bucket = byDeployment.get(observation.id);
    if (bucket === undefined) byDeployment.set(observation.id, [observation]);
    else bucket.push(observation);
  }

  const byDay = new Map<string, GatewayDeploymentHistoryDay>();
  for (const observation of history.observations) {
    const row = byDay.get(observation.date) ?? {
      date: observation.date,
      deployments: 0,
      unhealthy: 0,
    };
    row.deployments += 1;
    if (!observation.healthy) row.unhealthy += 1;
    byDay.set(observation.date, row);
  }
  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));

  const deployments: GatewayDeploymentUptime[] = [];
  for (const [id, unsorted] of byDeployment) {
    // Ascending, because every statement below is about what followed what. The
    // service reads in date order already; sorting here keeps the function
    // honest for a caller that constructed its rows some other way.
    const readings = [...unsorted].sort((a, b) => a.date.localeCompare(b.date));
    const newest = readings[readings.length - 1];
    const oldest = readings[0];
    if (newest === undefined || oldest === undefined) continue;

    const outages: GatewayDeploymentOutage[] = [];
    let open: { from: string; to: string; readings: number; errors: string[] } | null = null;
    let transitions = 0;
    let previous: GatewayDeploymentObservation | undefined;

    for (const reading of readings) {
      if (previous !== undefined && previous.healthy !== reading.healthy) transitions += 1;
      if (reading.healthy) {
        if (open !== null) {
          outages.push(closeOutage(open, false));
          open = null;
        }
      } else if (open === null) {
        open = {
          from: reading.date,
          to: reading.date,
          readings: 1,
          errors: reading.error === null || reading.error === '' ? [] : [reading.error],
        };
      } else {
        open.to = reading.date;
        open.readings += 1;
        if (reading.error !== null && reading.error !== '' && !open.errors.includes(reading.error)) {
          open.errors.push(reading.error);
        }
      }
      previous = reading;
    }
    if (open !== null) outages.push(closeOutage(open, true));

    const failingReadings = readings.filter((reading) => !reading.healthy).length;
    const standing = outages.find((outage) => outage.open) ?? null;
    const longest = outages.reduce<GatewayDeploymentOutage | null>(
      (best, outage) => (best === null || outage.readings > best.readings ? outage : best),
      null,
    );
    const priorState = readings[readings.length - 2]?.healthy;

    deployments.push({
      id,
      backend: newest.backend,
      model: newest.model,
      provider: newest.provider,
      readings: readings.length,
      failingReadings,
      failingShare: failingReadings / readings.length,
      firstSeen: oldest.date,
      lastSeen: newest.date,
      lastHealthy: newest.healthy,
      transitions,
      outages,
      standing,
      longest,
      newlyFailing: priorState === true && !newest.healthy,
      recovered: priorState === false && newest.healthy,
      renamed: new Set(readings.map((reading) => reading.model)).size > 1,
    });
  }

  deployments.sort((a, b) => {
    const aStanding = a.standing !== null && a.standing.readings >= STANDING_OUTAGE_READINGS;
    const bStanding = b.standing !== null && b.standing.readings >= STANDING_OUTAGE_READINGS;
    if (aStanding !== bStanding) return aStanding ? -1 : 1;
    if (a.failingReadings !== b.failingReadings) return b.failingReadings - a.failingReadings;
    return a.id.localeCompare(b.id);
  });

  return {
    from: history.from,
    to: history.to,
    recordingSince: history.recordingSince,
    observedDays: days.map((day) => day.date),
    days,
    deployments,
    standing: deployments.filter(
      (entry) => entry.standing !== null && entry.standing.readings >= STANDING_OUTAGE_READINGS,
    ),
    flapping: deployments.filter((entry) => entry.outages.length >= FLAPPING_OUTAGES),
    outages: deployments.reduce((total, entry) => total + entry.outages.length, 0),
  };
}

function closeOutage(
  run: { from: string; to: string; readings: number; errors: string[] },
  open: boolean,
): GatewayDeploymentOutage {
  return {
    from: run.from,
    to: run.to,
    readings: run.readings,
    // Every reading inside the span is failing by construction, so whatever the
    // span holds beyond them is days nobody looked at.
    unobservedDays: daysBetweenIso(run.from, run.to) + 1 - run.readings,
    open,
    errors: run.errors,
  };
}

/* ------------------------------------------------------------------ probe */

/**
 * A connection check against the live proxy — the one gateway surface that
 * reads nothing from Postgres.
 *
 * Everything else in this file describes data that has already been synced.
 * This describes whether a sync is *possible*: which of LiteLLM's routes the
 * configured credential can actually reach, and which of the dashboard's
 * dimensions and cards that leaves with nothing to draw. It exists because the
 * whole gateway integration is a draft written against published docs — the day
 * a real proxy and a real key appear, "does this key see the whole gateway"
 * is the first question, and answering it by starting a 90-day sync and
 * reading the job's error string is a poor way to ask.
 *
 * It is a live call, not a stored snapshot: nothing about it is written, and
 * two probes a minute apart may legitimately disagree.
 */
export const GATEWAY_PROBE_STATUSES = [
  /** Answered, parsed, and carried rows. */
  'ok',
  /** Answered and parsed, but reported nothing for the probed day. */
  'empty',
  /** 401/403 — the route exists and this credential may not have it. */
  'denied',
  /** 404/405/501 — this proxy does not offer the route at all. */
  'absent',
  /** Answered 2xx with a body this client cannot read. */
  'malformed',
  /** Network error, timeout, or a status that is neither of the above. */
  'unreachable',
] as const;
export type GatewayProbeStatus = (typeof GATEWAY_PROBE_STATUSES)[number];

/**
 * `denied` and `absent` are deliberately separate even though the sync treats
 * both as "skip this optional route": one is fixed by granting the key a
 * permission, the other cannot be fixed at all. Collapsing them is what makes a
 * misconfigured key look like a proxy without teams.
 */
export const GATEWAY_PROBE_STATUS_LABELS: Record<GatewayProbeStatus, string> = {
  ok: 'OK',
  empty: 'No rows',
  denied: 'Not permitted',
  absent: 'Not offered',
  malformed: 'Unreadable',
  unreachable: 'Unreachable',
};

/** How many distinct keys one route answered with, per dimension it fills. */
export interface GatewayProbeCoverage {
  dimension: GatewayDimension;
  keys: number;
  /**
   * Whether an empty count is a gap. Every call has a model, a provider and a
   * key, so a zero there means the breakdown did not arrive; `mcp_server` is a
   * strict subset of the traffic and a gateway with no MCP servers legitimately
   * reports none, which is a fact about the gateway rather than about the
   * credential.
   */
  expected: boolean;
}

export interface GatewayProbeRoute {
  /** Path as called, without the base URL or any query string. */
  path: string;
  /** What the dashboard loses without it, in the dashboard's own terms. */
  purpose: string;
  /** A required route failing means no gateway data at all. */
  required: boolean;
  status: GatewayProbeStatus;
  /** Null when nothing answered — a network error has no status. */
  httpStatus: number | null;
  durationMs: number;
  /** Rows (days, keys, teams) the route answered with; null when it did not answer. */
  rows: number | null;
  /** The proxy's own message, the parse failure, or a one-line reading of the rows. */
  detail: string | null;
  dimensions: GatewayProbeCoverage[];
}

export interface GatewayProbe {
  source: GatewaySource;
  configured: boolean;
  /** Host only. The credential never leaves the API and neither does a URL carrying one. */
  target: string | null;
  /** When the probe ran, ISO. Not stored anywhere — it is true for this response only. */
  checkedAt: string;
  /** The single day the probe asked the activity routes about. */
  probedDay: string | null;
  routes: GatewayProbeRoute[];
  /** Every required route answered usably. */
  usable: boolean;
  /** What this credential cannot show, one statement per gap. */
  warnings: string[];
}

/** Nothing answered usably, and nothing will. */
const PROBE_FAILED: ReadonlySet<GatewayProbeStatus> = new Set([
  'denied',
  'absent',
  'malformed',
  'unreachable',
]);

/**
 * Turns route results into the two things a reader wants: can this sync, and
 * what will be missing if it does.
 *
 * Pure, and the only place the mapping from a route outcome to a *dashboard*
 * consequence lives — the API composes the response with it and the contract
 * harness asserts against it, so the wording cannot drift between them.
 *
 * `empty` on a required route is deliberately not a failure and deliberately
 * still a warning: a proxy that genuinely saw no traffic yesterday and a
 * credential scoped to one team that saw none are indistinguishable from here,
 * and pretending otherwise is exactly the open question this probe exists to
 * put in front of someone.
 */
export function summarizeGatewayProbe(routes: readonly GatewayProbeRoute[]): {
  usable: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  let usable = routes.some((route) => route.required);

  for (const route of routes) {
    const label = GATEWAY_PROBE_STATUS_LABELS[route.status].toLowerCase();

    if (PROBE_FAILED.has(route.status)) {
      if (route.required) usable = false;
      warnings.push(
        `${route.path} — ${label}${route.httpStatus === null ? '' : ` (${route.httpStatus})`}. ${route.purpose}`,
      );
      continue;
    }

    if (route.status === 'empty') {
      warnings.push(
        route.required
          ? `${route.path} reported no usage for the probed day. Either the gateway was idle, or this credential is scoped to an entity that was — the proxy answers both the same way.`
          : `${route.path} reported no rows. ${route.purpose}`,
      );
      continue;
    }

    for (const coverage of route.dimensions) {
      if (coverage.expected && coverage.keys === 0) {
        warnings.push(
          `${route.path} answered, but carried no ${GATEWAY_DIMENSION_LABELS[coverage.dimension].toLowerCase()} keys — that dimension will be blank.`,
        );
      }
    }
  }

  return { usable, warnings };
}

/* --------------------------------------------------------------- coverage */

/**
 * How many days of daily aggregates a LiteLLM proxy keeps.
 *
 * The proxy prunes `LiteLLM_SpendLogs` on a retention window and the daily
 * rollup is bounded with it, so a sync can never reach further back than this.
 * It is the *proxy's* limit, not the dashboard's: the sync deletes only the
 * dates it re-fetched, so `gateway_daily` keeps every day it has ever seen and
 * grows past this window the longer the scheduler runs.
 */
export const GATEWAY_RETENTION_DAYS = 90;

/** A run of consecutive days inside the stored span that carry no row at all. */
export interface GatewayCoverageGap {
  from: string;
  to: string;
  days: number;
}

/**
 * What the dashboard has actually stored, as opposed to what the proxy can
 * still be asked for.
 *
 * Every gateway card derives from one range fetch and assumes the days it gets
 * back are the days that happened — an interior zero is read as a quiet
 * weekend, deliberately, because that is what it usually is. That reading is
 * only safe while the range sits inside the window the sync re-pulls nightly.
 * Past it, two things stop being true at once: history older than the proxy's
 * retention exists *only* here and can never be re-fetched, and a stretch when
 * the scheduler was down is a hole nothing will ever fill. Both are facts about
 * the table rather than about the gateway, so they are reported separately from
 * usage and never mixed into it.
 */
export interface GatewayCoverage {
  /** Earliest stored day; null when nothing has ever synced. */
  firstDay: string | null;
  /** Latest stored day; null when nothing has ever synced. */
  lastDay: string | null;
  /** Days carrying a row. */
  storedDays: number;
  /** Calendar length of `firstDay..lastDay`, so `storedDays + missingDays` matches it. */
  spanDays: number;
  /** Days inside the span with no row — a sync that never ran, not a quiet day. */
  missingDays: number;
  /** The runs those missing days form, newest first. */
  gaps: GatewayCoverageGap[];
  /** True when `gaps` was cut to a sample; `missingDays` stays the full count. */
  gapsTruncated: boolean;
  /**
   * Earliest day the proxy itself can still be asked for — the first day of the
   * window the sync pulls, so `today − retentionDays`.
   */
  retentionFloor: string;
  retentionDays: number;
  /** Stored days older than `retentionFloor` — history only this dashboard now holds. */
  daysBeyondRetention: number;
  /**
   * The earliest day worth offering a reader: the first stored day, or the
   * retention floor when nothing is stored yet.
   *
   * One number rather than three copies of the same `if` in the range picker,
   * the comparison window and the chargeback month list.
   */
  floor: string;
}

/**
 * The dimensions a bill can be issued against — "who pays", not "how can the
 * spend be sliced".
 *
 * `model` and `provider` are the supply side (a statement charging AWS Bedrock
 * bills nobody) and `mcp_server` is a strict subset of the traffic rather than
 * a slice of it. Shared rather than web-only because the month seal stores
 * exactly these four dimensions' lines, so the API and the card have to agree
 * on the list.
 */
export const GATEWAY_PAYER_DIMENSIONS = ['team', 'tag', 'api_key', 'user'] as const;
export type GatewayPayerDimension = (typeof GATEWAY_PAYER_DIMENSIONS)[number];

/** How many gap runs are enumerated before the list becomes a sample. */
const MAX_COVERAGE_GAPS = 12;

const MS_PER_DAY = 86_400_000;

/** `2026-07-31`, `-1` → `2026-07-30`. UTC, so DST never shifts a date. */
function shiftDay(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`, both ISO dates. Negative when `b` precedes `a`. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_PER_DAY);
}

/**
 * Turns the set of stored dates into the coverage read.
 *
 * Pure, and shared so the API composes the response with the same arithmetic
 * the invariant script asserts against. `days` must be distinct and ascending —
 * which is what `SELECT date … ORDER BY date` yields from a table whose primary
 * key is the date.
 *
 * `todayIso` is passed rather than read from the clock: the retention floor
 * moves every midnight, and a function that reads `Date.now()` cannot be
 * asserted against a fixture.
 */
export function summarizeGatewayCoverage(
  days: readonly string[],
  todayIso: string,
  retentionDays: number = GATEWAY_RETENTION_DAYS,
): GatewayCoverage {
  // The same day the sync asks the proxy for: its window is `retentionDays`
  // days *ending yesterday*, so it starts at `today − retentionDays` rather
  // than at `today − (retentionDays − 1)`. Off by one in the other direction
  // and the first day of every ordinary sync reports as unrepeatable archive.
  const retentionFloor = shiftDay(todayIso, -retentionDays);

  const firstDay = days[0] ?? null;
  const lastDay = days[days.length - 1] ?? null;

  if (firstDay === null || lastDay === null) {
    return {
      firstDay: null,
      lastDay: null,
      storedDays: 0,
      spanDays: 0,
      missingDays: 0,
      gaps: [],
      gapsTruncated: false,
      retentionFloor,
      retentionDays,
      daysBeyondRetention: 0,
      floor: retentionFloor,
    };
  }

  const gaps: GatewayCoverageGap[] = [];
  let missingDays = 0;
  for (let i = 1; i < days.length; i += 1) {
    const previous = days[i - 1] as string;
    const current = days[i] as string;
    const step = daysBetween(previous, current);
    if (step <= 1) continue;
    missingDays += step - 1;
    gaps.push({ from: shiftDay(previous, 1), to: shiftDay(current, -1), days: step - 1 });
  }
  gaps.reverse();

  let daysBeyondRetention = 0;
  for (const day of days) {
    if (day >= retentionFloor) break;
    daysBeyondRetention += 1;
  }

  return {
    firstDay,
    lastDay,
    storedDays: days.length,
    spanDays: daysBetween(firstDay, lastDay) + 1,
    missingDays,
    gaps: gaps.slice(0, MAX_COVERAGE_GAPS),
    gapsTruncated: gaps.length > MAX_COVERAGE_GAPS,
    retentionFloor,
    retentionDays,
    daysBeyondRetention,
    floor: firstDay,
  };
}

/* ---------------------------------------------------------------------------
 * Month seals — a closed month held still.
 * ------------------------------------------------------------------------ */

/**
 * A sealed month: what the gateway cost over one calendar month, recorded once
 * the month can no longer change, and never recomputed.
 *
 * Every other gateway number on this dashboard is derived on the fly from
 * `gateway_daily`, which is exactly right for analysis and wrong for a bill.
 * A statement leaves the dashboard — it is exported, argued with, and quoted
 * back months later — and the rows behind it are ordinary daily rows that any
 * sync may rewrite: LiteLLM revises late-landing usage, a backfill re-fetches
 * a repaired day, and a schema change to the daily tables moves the ground the
 * statement stood on. A seal is the fixed thing to quote: the month's totals
 * and its per-payer lines, taken once, with the instant it was taken.
 *
 * It is deliberately *not* a second source of truth for analysis. Nothing on
 * the page reads a seal instead of the daily rows; the seal's job is to be
 * compared against them, so that "June's bill has moved since we issued it" is
 * a question with an answer.
 */
export interface GatewaySeal {
  /** `YYYY-MM`. */
  month: string;
  monthStart: string;
  monthEnd: string;
  /** Days of the month that carried a row when it was sealed — the month's length. */
  days: number;
  /** When the seal was taken. */
  sealedAt: string;
  /** `scheduler` for the automatic seal at month close, `manual` for the route. */
  sealedBy: GatewaySealOrigin;
  /**
   * Which statement this is: `1` for the month's first seal, `2` for the one
   * that replaced it, and so on. A re-seal does not overwrite — the statement
   * that was issued is kept beside the one that replaced it, because "we billed
   * £X in June, then corrected it to £Y" is the question a revision raises.
   */
  revision: number;
  /**
   * When a later revision replaced this one; `null` on the current statement.
   * Exactly one revision of a month is current at a time.
   */
  supersededAt: string | null;
  /** The month's gateway-wide totals, as sealed. */
  total: GatewayMetrics;
}

export const GATEWAY_SEAL_ORIGINS = ['scheduler', 'manual'] as const;
export type GatewaySealOrigin = (typeof GATEWAY_SEAL_ORIGINS)[number];

/** One payer's line on a sealed month. */
export interface GatewaySealLine extends GatewayMetrics {
  dimension: GatewayPayerDimension;
  key: string;
  label: string | null;
}

/** A seal with the lines it recorded — what `GET /api/gateway/months/:month` returns. */
export interface GatewaySealedMonth extends GatewaySeal {
  lines: GatewaySealLine[];
}

/** What `GET /api/gateway/months` returns: headers only, newest month first. */
export interface GatewaySeals {
  seals: GatewaySeal[];
}

/** How many missing days a refusal enumerates before the list becomes a sample. */
const MAX_SEAL_MISSING_DAYS = 12;

/** Why a month cannot be sealed yet, or `null` when it can. */
export type GatewaySealBlocker = 'in_flight' | 'incomplete' | 'empty';

/** Whether one month is ready to be held still, and what is in the way if not. */
export interface GatewaySealCheck {
  month: string;
  monthStart: string;
  monthEnd: string;
  sealable: boolean;
  blocker: GatewaySealBlocker | null;
  /** Human sentence naming the blocker; null when sealable. */
  reason: string | null;
  /** Days of the month carrying a row. */
  storedDays: number;
  /** Calendar length of the month. */
  expectedDays: number;
  /** The days that are missing, up to a sample; `expectedDays − storedDays` is the count. */
  missingDays: string[];
}

/** Last calendar day of `YYYY-MM`, UTC — day 0 of the next month. */
function monthEndOf(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return new Date(Date.UTC(year, index, 0)).toISOString().slice(0, 10);
}

/**
 * Whether `month` may be sealed, given the days the table actually holds.
 *
 * Two conditions, and both are about the month being *finished* rather than
 * about it being old:
 *
 * - **The month has ended.** A month in flight is a preview; sealing one would
 *   record a partial bill as final. `todayIso` decides this, not the stored
 *   rows — a gateway that stopped syncing mid-month must not have that month
 *   sealed short the moment the calendar rolls over.
 * - **Every day of it is stored.** The seal is a sum, and a sum over 29 of 30
 *   days is not the month's cost. A hole inside the month is exactly what
 *   `GET /api/gateway/coverage` reports and `POST /api/refresh/gateway` fills,
 *   so the refusal names the days rather than the count — the fix is a
 *   backfill, and the caller needs the range to ask for.
 *
 * Pure, and `todayIso` is passed rather than read from the clock for the same
 * reason `summarizeGatewayCoverage` takes it: the answer moves at midnight and
 * a function reading `Date.now()` cannot be asserted against a fixture.
 */
export function resolveMonthSeal(
  month: string,
  storedDays: readonly string[],
  todayIso: string,
): GatewaySealCheck {
  const monthStart = `${month}-01`;
  const monthEnd = monthEndOf(month);
  const expectedDays = daysBetween(monthStart, monthEnd) + 1;

  const stored = new Set(storedDays.filter((day) => day >= monthStart && day <= monthEnd));
  const missing: string[] = [];
  for (let day = monthStart; day <= monthEnd; day = shiftDay(day, 1)) {
    if (!stored.has(day)) missing.push(day);
  }

  const base = {
    month,
    monthStart,
    monthEnd,
    storedDays: stored.size,
    expectedDays,
    missingDays: missing.slice(0, MAX_SEAL_MISSING_DAYS),
  };

  // Strictly before today: the sync ends at yesterday UTC, so on the 1st the
  // month that just closed is still one day short and lands on `incomplete`
  // below — which is the honest blocker, since a backfill fixes it.
  if (monthEnd >= todayIso) {
    return {
      ...base,
      sealable: false,
      blocker: 'in_flight',
      reason: `${month} has not ended yet — it can be sealed from ${shiftDay(monthEnd, 1)}`,
    };
  }
  if (stored.size === 0) {
    return {
      ...base,
      sealable: false,
      blocker: 'empty',
      reason: `no day of ${month} is stored, so there is nothing to seal`,
    };
  }
  if (missing.length > 0) {
    const sample = missing.slice(0, 3).join(', ');
    return {
      ...base,
      sealable: false,
      blocker: 'incomplete',
      reason: `${missing.length} day${missing.length === 1 ? '' : 's'} of ${month} ${
        missing.length === 1 ? 'is' : 'are'
      } missing (${sample}${missing.length > 3 ? ', …' : ''}) — backfill them first`,
    };
  }

  return { ...base, sealable: true, blocker: null, reason: null };
}

/**
 * How a sealed month compares with what the daily rows say *now*.
 *
 * The seal exists to be checked against, not to replace the derivation: if a
 * later sync revised the month, the two disagree and the statement on screen is
 * no longer the statement that was issued. Dollars only — a revision that moved
 * no money is not worth an alarm, and the counters move for benign reasons
 * (a re-fetched day's request count settling) far more often than spend does.
 */
export interface GatewaySealDrift {
  /** `live − sealed`, in dollars. */
  spendDelta: number;
  /** True when the two agree to the cent. */
  matches: boolean;
}

export function sealDrift(seal: Readonly<GatewaySeal>, live: Readonly<GatewayMetrics>): GatewaySealDrift {
  const spendDelta = live.spend - seal.total.spend;
  return { spendDelta, matches: Math.abs(spendDelta) < 0.005 };
}

/* ---------------------------------------------------------------------------
 * Seal revisions — what changed between two statements of the same month.
 * ------------------------------------------------------------------------ */

/** How many changed lines a diff enumerates per dimension before it is a sample. */
const MAX_SEAL_DIFF_LINES = 12;

/** Dollars below which two spend figures are the same statement line. */
const CENT = 0.005;

/** One payer's line as it moved between two revisions of a month. */
export interface GatewaySealLineChange {
  dimension: GatewayPayerDimension;
  key: string;
  label: string | null;
  /** The line as first issued; `0` when the payer is new to the revision. */
  previousSpend: number;
  /** The line as re-issued; `0` when the payer vanished from it. */
  spend: number;
  /** `spend − previousSpend`. */
  spendDelta: number;
  change: 'added' | 'removed' | 'changed';
}

/** How one payer dimension's lines moved between two revisions. */
export interface GatewaySealDimensionDiff {
  dimension: GatewayPayerDimension;
  /** Lines that moved by at least a cent, appeared, or vanished. */
  movedLines: number;
  /** The biggest movers first, capped — `movedLines` stays the true count. */
  lines: GatewaySealLineChange[];
  linesTruncated: boolean;
  /**
   * The month's movement this dimension does not account for: the gateway
   * total moved by `spendDelta`, its lines by the sum of their own deltas, and
   * the difference is spend the proxy attributed to nobody in one revision or
   * the other. It is reported rather than spread, for the same reason the
   * statement's `unallocated` row is.
   *
   * Measured over *every* line, including the sub-cent settles `lines` does
   * not show — so it stays the honest "billed to nobody" figure rather than
   * absorbing display noise, and the visible rows plus this number land within
   * a cent per suppressed line of the month's movement.
   */
  unattributedDelta: number;
}

/**
 * What one re-seal changed — the audit trail a revision needs to be auditable.
 *
 * A seal alone is enough to *notice* that a month moved (`sealDrift` compares
 * it with the live rows). It is not enough to say who moved: a department
 * arguing with a corrected bill needs its own line before and after, not the
 * gateway's total. This is that, per payer dimension, on the statement's own
 * terms — and it is pure, because both sides are records rather than
 * derivations, so nothing about it can drift with the daily rows.
 */
export interface GatewaySealRevisionDiff {
  month: string;
  /** The newer revision's number, and the one it replaced. */
  revision: number;
  previousRevision: number;
  /** When the newer revision was taken. */
  sealedAt: string;
  /** `newer.total.spend − older.total.spend`. */
  spendDelta: number;
  /** `newer.days − older.days` — a re-seal after a backfill moves this. */
  daysDelta: number;
  dimensions: GatewaySealDimensionDiff[];
}

/** Every revision of one month, newest first, with what each one changed. */
export interface GatewaySealHistory {
  month: string;
  /** Newest revision first; the current statement is `revisions[0]`. */
  revisions: GatewaySeal[];
  /** One entry per consecutive pair, newest first. Empty for a month sealed once. */
  diffs: GatewaySealRevisionDiff[];
}

/**
 * Compare two revisions of the same month, line by line.
 *
 * Lines are matched on `dimension + key`, never on the label: an alias is
 * resolved per day and a key whose alias was filled in between two seals is
 * the same payer, not a new one plus a vanished one.
 *
 * A line that moved by less than a cent is not a change — the seal stores
 * nano-dollars and a re-fetched day settles the last digits routinely, which
 * would otherwise fill the diff with rows nobody can act on. Appearing and
 * vanishing are always reported, however small: a payer whose line is gone
 * from the re-issued bill is a fact about the bill, not about the amount.
 */
export function diffSeals(
  previous: Readonly<GatewaySealedMonth>,
  current: Readonly<GatewaySealedMonth>,
): GatewaySealRevisionDiff {
  const dimensions: GatewaySealDimensionDiff[] = [];

  for (const dimension of GATEWAY_PAYER_DIMENSIONS) {
    const before = previous.lines.filter((line) => line.dimension === dimension);
    const after = current.lines.filter((line) => line.dimension === dimension);
    const beforeByKey = new Map(before.map((line) => [line.key, line]));
    const afterByKey = new Map(after.map((line) => [line.key, line]));

    const changes: GatewaySealLineChange[] = [];
    let attributedDelta = 0;

    for (const [key, line] of afterByKey) {
      const prior = beforeByKey.get(key);
      const previousSpend = prior?.spend ?? 0;
      const spendDelta = line.spend - previousSpend;
      attributedDelta += spendDelta;
      if (prior === undefined) {
        changes.push({
          dimension,
          key,
          label: line.label,
          previousSpend: 0,
          spend: line.spend,
          spendDelta,
          change: 'added',
        });
      } else if (Math.abs(spendDelta) >= CENT) {
        changes.push({
          dimension,
          key,
          label: line.label ?? prior.label,
          previousSpend,
          spend: line.spend,
          spendDelta,
          change: 'changed',
        });
      }
    }

    for (const [key, line] of beforeByKey) {
      if (afterByKey.has(key)) continue;
      attributedDelta -= line.spend;
      changes.push({
        dimension,
        key,
        label: line.label,
        previousSpend: line.spend,
        spend: 0,
        spendDelta: -line.spend,
        change: 'removed',
      });
    }

    changes.sort((a, b) => Math.abs(b.spendDelta) - Math.abs(a.spendDelta));

    dimensions.push({
      dimension,
      movedLines: changes.length,
      lines: changes.slice(0, MAX_SEAL_DIFF_LINES),
      linesTruncated: changes.length > MAX_SEAL_DIFF_LINES,
      unattributedDelta: current.total.spend - previous.total.spend - attributedDelta,
    });
  }

  return {
    month: current.month,
    revision: current.revision,
    previousRevision: previous.revision,
    sealedAt: current.sealedAt,
    spendDelta: current.total.spend - previous.total.spend,
    daysDelta: current.days - previous.days,
    dimensions,
  };
}
