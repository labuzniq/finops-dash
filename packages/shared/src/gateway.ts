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
