/**
 * LiteLLM proxy client — the live LLM-gateway source.
 *
 * DRAFT, not yet validated against a running proxy. It is written against
 * LiteLLM's published daily-activity contract:
 *
 *   GET /user/daily/activity?start_date&end_date&page&page_size
 *   GET /team/daily/activity
 *   GET /tag/daily/activity
 *     → SpendAnalyticsPaginatedResponse
 *       { results: [{ date, metrics: SpendMetrics, breakdown: BreakdownMetrics }],
 *         metadata: { total_spend, …, page, total_pages, has_more } }
 *
 * `SpendMetrics` is spend / prompt_tokens / completion_tokens /
 * cache_read_input_tokens / cache_creation_input_tokens / total_tokens /
 * successful_requests / failed_requests / api_requests, and `BreakdownMetrics`
 * splits the same numbers by models, providers, api_keys, mcp_servers and
 * `entities` (the endpoint's own entity — user, team or tag).
 *
 * These endpoints read LiteLLM's pre-aggregated `LiteLLM_DailyUserSpend`
 * family of tables, not the raw `LiteLLM_SpendLogs`, which is why a 90-day
 * pull is a handful of requests instead of millions of rows — and why raw
 * spend logs, which the proxy prunes on a retention window, are deliberately
 * not touched here.
 *
 * Two things to re-check the day a real endpoint exists (see
 * docs/litellm-gateway.md):
 *   1. that an admin key with no `user_id` really answers gateway-wide, and
 *   2. that `breakdown.entities` on `/user/daily/activity` is keyed by user.
 * Both are assumptions; everything else comes from the published response
 * model. Neither is load-bearing for the daily totals, only for the
 * user/team/tag dimensions.
 */

import { z } from 'zod';
import type {
  GatewayDimension,
  GatewayProbeCoverage,
  GatewayProbeRoute,
  GatewayProbeStatus,
} from '@dash/shared';
import { moduleLogger } from '../log.js';
import { parseNano } from '../lib/nano.js';
import { addCounters, ZERO_COUNTERS } from './types.js';
import type {
  GatewayBreakdownSnapshot,
  GatewayBudgetSnapshot,
  GatewayClient,
  GatewayCounters,
  GatewayDailySnapshot,
  GatewaySnapshot,
} from './types.js';

const log = moduleLogger('gateway.litellm');

/** Rows per page. LiteLLM defaults to 10; days are few and fat, so ask for more. */
const PAGE_SIZE = 100;

/** Runaway guard — a proxy that never clears `has_more` must not loop forever. */
const MAX_PAGES = 50;

const RETRY_DELAYS_MS = [500, 1_000, 2_000];

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The probe's own timeout — a third of the sync's, because it runs behind a
 * button someone is watching, and "slow" is itself the answer they need.
 */
const PROBE_TIMEOUT_MS = 10_000;

/** One probe request's outcome. `body` exists only on a 2xx that decoded. */
interface ProbeAttempt {
  status: GatewayProbeStatus;
  httpStatus: number | null;
  durationMs: number;
  detail: string | null;
  body?: unknown;
}

/** The first few schema complaints, flattened — the same reading the sync throws. */
function describeIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.')} ${issue.message}`)
    .join('; ');
}

/**
 * `SpendMetrics`. Every field defaults to zero: the proxy omits counters it
 * has no rows for, and a missing counter genuinely means none happened.
 */
const metricsSchema = z.object({
  spend: z.number().default(0),
  prompt_tokens: z.number().default(0),
  completion_tokens: z.number().default(0),
  cache_read_input_tokens: z.number().default(0),
  cache_creation_input_tokens: z.number().default(0),
  total_tokens: z.number().default(0),
  successful_requests: z.number().default(0),
  failed_requests: z.number().default(0),
  api_requests: z.number().default(0),
});

/** One breakdown bucket. `metadata` carries aliases (key_alias, team_id, …). */
const bucketSchema = z.object({
  metrics: metricsSchema,
  metadata: z.record(z.unknown()).default({}),
});

const breakdownSchema = z
  .object({
    models: z.record(bucketSchema).default({}),
    providers: z.record(bucketSchema).default({}),
    api_keys: z.record(bucketSchema).default({}),
    mcp_servers: z.record(bucketSchema).default({}),
    entities: z.record(bucketSchema).default({}),
  })
  .default({});

const dailyRowSchema = z.object({
  date: z.string(),
  metrics: metricsSchema,
  breakdown: breakdownSchema,
});

const activityResponseSchema = z.object({
  results: z.array(dailyRowSchema).default([]),
  metadata: z
    .object({
      page: z.number().default(1),
      total_pages: z.number().default(1),
      has_more: z.boolean().default(false),
    })
    .default({}),
});

type Bucket = z.infer<typeof bucketSchema>;
type DailyRow = z.infer<typeof dailyRowSchema>;

/**
 * The management side: `GET /key/list?return_full_object=true` and
 * `GET /team/list`, which carry the budgets and rate limits the proxy actually
 * enforces. Neither is a daily aggregate — they are the current state of the
 * governance objects, so the sync stores one row per object and no history.
 *
 * Field names come from LiteLLM's own models (`LiteLLM_VerificationToken` and
 * `LiteLLM_TeamTable`). Every limit is optional *and* nullable there: the
 * column exists on every row and holds NULL when nothing is configured, which
 * is why nothing here defaults to zero.
 */
const nullableNumber = z.number().nullish();

const keyRowSchema = z.object({
  token: z.string().nullish(),
  key_name: z.string().nullish(),
  key_alias: z.string().nullish(),
  team_id: z.string().nullish(),
  spend: z.number().nullish(),
  max_budget: nullableNumber,
  soft_budget: nullableNumber,
  budget_duration: z.string().nullish(),
  budget_reset_at: z.string().nullish(),
  tpm_limit: nullableNumber,
  rpm_limit: nullableNumber,
  blocked: z.boolean().nullish(),
});

/**
 * `keys` is `List[str] | List[UserAPIKeyAuth]` — a proxy that ignores
 * `return_full_object` answers with bare token strings, which carry no budget
 * at all. Those are parsed and then dropped rather than rejected: the usage
 * sync must survive a proxy that only lists key names.
 */
const keyListSchema = z.object({
  keys: z.array(z.union([keyRowSchema, z.string()])).default([]),
  total_pages: z.number().nullish(),
  current_page: z.number().nullish(),
});

const teamRowSchema = z.object({
  team_id: z.string(),
  team_alias: z.string().nullish(),
  spend: z.number().nullish(),
  max_budget: nullableNumber,
  soft_budget: nullableNumber,
  budget_duration: z.string().nullish(),
  budget_reset_at: z.string().nullish(),
  tpm_limit: nullableNumber,
  rpm_limit: nullableNumber,
  blocked: z.boolean().nullish(),
});

/** `/team/list` answers a bare array — no pagination envelope, unlike keys. */
const teamListSchema = z.array(teamRowSchema);

/**
 * `/tag/list` — the third management envelope, and the one shaped least like
 * the other two.
 *
 * Three differences, each of which the parsing below has to deal with:
 *
 *  1. **A bare array, like teams**, but with no pagination of any kind. Tags are
 *     a small configured set; the route returns all of them.
 *  2. **The limits are not inline.** `LiteLLM_TagTable` carries only
 *     `tag_name`, `description`, `models`, `spend` and a `budget_id`; the caps,
 *     the duration and the rate limits live on the joined `LiteLLM_BudgetTable`
 *     row, which the endpoint includes as `litellm_budget_table`. A key row
 *     spells `max_budget` at the top level and a tag row does not.
 *  3. **It mixes configured tags with observed ones.** The endpoint appends
 *     *dynamic* tags — strings that merely appeared in spend data and were never
 *     created — built from a spend aggregation, so they have a name and dates
 *     and nothing else. Those are not governance objects; see `isGoverned`.
 */
const tagBudgetTableSchema = z.object({
  budget_id: z.string().nullish(),
  max_budget: nullableNumber,
  soft_budget: nullableNumber,
  budget_duration: z.string().nullish(),
  budget_reset_at: z.string().nullish(),
  tpm_limit: nullableNumber,
  rpm_limit: nullableNumber,
});

const tagRowSchema = z.object({
  name: z.string(),
  description: z.string().nullish(),
  spend: z.number().nullish(),
  budget_id: z.string().nullish(),
  litellm_budget_table: tagBudgetTableSchema.nullish(),
  blocked: z.boolean().nullish(),
});

const tagListSchema = z.array(tagRowSchema);

/**
 * Is this row a tag somebody configured, or one the proxy merely saw?
 *
 * A dynamic tag is assembled from a spend-log aggregation and carries no budget
 * link and no `spend` column — it is a *usage* fact, and it is already on this
 * page as a row of the `tag` breakdown dimension. Admitting it here as an
 * "uncapped" governance object would count objects nobody ever governed, which
 * is precisely the denominator the budget card reports coverage against: a
 * gateway with two capped tags and forty observed strings would read as 5%
 * governed when in truth every tag anyone created is capped.
 *
 * So the test is for evidence of the tag *table*, not for a budget: a stored tag
 * with no cap is genuinely ungoverned and belongs on the card as such.
 */
function isGoverned(row: z.infer<typeof tagRowSchema>): boolean {
  return (
    row.budget_id !== null &&
    row.budget_id !== undefined &&
    row.budget_id !== ''
  ) ||
    (row.litellm_budget_table !== null && row.litellm_budget_table !== undefined) ||
    typeof row.spend === 'number';
}

/** `/key/list` caps `size` at 100 (`Query(10, ge=1, le=100)`). */
const KEY_PAGE_SIZE = 100;

/**
 * Which endpoint fills which dimensions.
 *
 * Only the user endpoint contributes gateway-wide totals — the team and tag
 * endpoints report the same spend re-sliced, and adding their `metrics` in
 * would triple-count every dollar. They are pulled purely for their
 * `entities` breakdown, and only when the key is allowed to see them: a proxy
 * without teams or tags configured simply has no such route, which is why
 * anything but the user endpoint is optional.
 */
interface DailyEndpoint {
  path: string;
  /** Dimension the `entities` breakdown maps to, or null when unused. */
  entityDimension: GatewayDimension | null;
  /** Whether this endpoint's `metrics` are the gateway-wide totals. */
  totals: boolean;
  /** A missing/forbidden optional endpoint is logged and skipped, not fatal. */
  required: boolean;
  /** What the dashboard loses without it — the probe's wording, not a log line. */
  purpose: string;
}

const ENDPOINTS: readonly DailyEndpoint[] = [
  {
    path: '/user/daily/activity',
    entityDimension: 'user',
    totals: true,
    required: true,
    purpose:
      'Gateway-wide spend, tokens and requests come from here, along with the model, provider, API key, MCP server and user dimensions. Without it there is no gateway data at all.',
  },
  {
    path: '/team/daily/activity',
    entityDimension: 'team',
    totals: false,
    required: false,
    purpose: 'The team dimension will be blank; every other view is unaffected.',
  },
  {
    path: '/tag/daily/activity',
    entityDimension: 'tag',
    totals: false,
    required: false,
    purpose: 'The tag dimension will be blank; every other view is unaffected.',
  },
];

/**
 * Which dimensions a probed activity route fills, and which of them an empty
 * count would be a gap in. `mcp_server` is a subset of the traffic, so nothing
 * is wrong with a gateway that reports none.
 */
function coverageOf(endpoint: DailyEndpoint, counts: Map<GatewayDimension, number>): GatewayProbeCoverage[] {
  const dimensions: GatewayDimension[] = endpoint.totals
    ? ['model', 'provider', 'api_key', 'mcp_server']
    : [];
  if (endpoint.entityDimension !== null) dimensions.push(endpoint.entityDimension);
  return dimensions.map((dimension) => ({
    dimension,
    keys: counts.get(dimension) ?? 0,
    expected: dimension !== 'mcp_server',
  }));
}

/** Status codes that mean "this proxy does not offer that" rather than "broken". */
const ABSENT_STATUSES = new Set([401, 403, 404, 405, 501]);

/**
 * Worth retrying. Deliberately *not* every 5xx: `501 Not Implemented` is a
 * permanent statement about the route, and it is also in `ABSENT_STATUSES` —
 * retrying it would burn the whole backoff and then throw "unreachable",
 * turning a skippable optional endpoint into a failed sync.
 */
function isTransient(status: number): boolean {
  return status === 429 || (status >= 500 && !ABSENT_STATUSES.has(status));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * JSON float dollars → nano bigint. `toFixed(9)` both pins the value to the
 * nine fractional digits `parseNano` accepts and expands exponent notation —
 * LiteLLM emits per-model spend as `1.095e-05`, which `String()` would hand
 * over verbatim and `parseNano` would reject.
 *
 * Spend below 5e-10 USD rounds to zero. That is a rounding of a half-nanodollar
 * and is accepted deliberately; the alternative is a wider integer scale for
 * numbers no report ever shows.
 */
function dollarsToNano(dollars: number): bigint {
  if (!Number.isFinite(dollars)) return 0n;
  return parseNano(dollars.toFixed(9));
}

/**
 * A budget field, in nano — or null when the proxy has no such limit.
 *
 * Deliberately *not* zero-filled: LiteLLM stores NULL for "uncapped" and 0.0
 * for a key budgeted at nothing, and those are opposite states. A missing
 * counter on the usage side means "none happened"; a missing limit here means
 * "no limit", which is the one place in the gateway contract where absence is
 * genuinely unknown-shaped rather than zero-shaped.
 */
function optionalDollarsToNano(dollars: number | null | undefined): bigint | null {
  if (dollars === null || dollars === undefined || !Number.isFinite(dollars)) return null;
  return dollarsToNano(dollars);
}

/**
 * A rate limit, or null. Same rule as budgets — 0 rpm is a hard stop, absent is
 * no limit — with a floor guard because a negative limit is not a fact.
 */
function toLimit(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * A LiteLLM timestamp → Date, or null. The proxy serialises Prisma datetimes
 * with six fractional digits (`2026-08-01T00:00:00.594000Z`), which `Date`
 * accepts; anything it does not parse becomes null rather than an Invalid Date
 * that would reach Postgres.
 */
function toInstant(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toCounters(metrics: z.infer<typeof metricsSchema>): GatewayCounters {
  return {
    spendNano: dollarsToNano(metrics.spend),
    requests: metrics.api_requests,
    successfulRequests: metrics.successful_requests,
    failedRequests: metrics.failed_requests,
    promptTokens: metrics.prompt_tokens,
    completionTokens: metrics.completion_tokens,
    totalTokens: metrics.total_tokens,
    cacheReadTokens: metrics.cache_read_input_tokens,
    cacheCreationTokens: metrics.cache_creation_input_tokens,
  };
}

/**
 * The friendliest name in a bucket's metadata. LiteLLM names it differently
 * per breakdown (`key_alias` for keys, `team_alias` for teams, `user_email`
 * for users), so try each and fall back to null rather than echoing the raw id
 * twice — the UI already shows the key.
 */
const LABEL_FIELDS = ['key_alias', 'team_alias', 'team_name', 'user_email', 'alias', 'name'];

function pickLabel(metadata: Record<string, unknown>): string | null {
  for (const field of LABEL_FIELDS) {
    const value = metadata[field];
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 200);
  }
  return null;
}

/** `2025-03-27T00:00:00` and `2025-03-27` both normalise to the calendar day. */
function toIsoDate(value: string): string {
  return value.slice(0, 10);
}

/** Accumulator key — one row per (date, dimension, key). */
function bucketKey(date: string, dimension: GatewayDimension, key: string): string {
  return `${date} ${dimension} ${key}`;
}

export class LiteLlmGatewayClient implements GatewayClient {
  readonly name = 'litellm' as const;

  private readonly root: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.root = baseUrl.replace(/\/+$/, '');
  }

  async fetchUsage(from: string, to: string): Promise<GatewaySnapshot> {
    const daily = new Map<string, GatewayDailySnapshot>();
    const breakdowns = new Map<string, GatewayBreakdownSnapshot>();

    for (const endpoint of ENDPOINTS) {
      const rows = await this.fetchAllPages(endpoint, from, to);
      if (rows === null) continue;

      for (const row of rows) {
        const date = toIsoDate(row.date);

        if (endpoint.totals) {
          const day = daily.get(date) ?? { date, ...ZERO_COUNTERS };
          addCounters(day, toCounters(row.metrics));
          daily.set(date, day);

          this.collect(breakdowns, date, 'model', row.breakdown.models);
          this.collect(breakdowns, date, 'provider', row.breakdown.providers);
          this.collect(breakdowns, date, 'api_key', row.breakdown.api_keys);
          this.collect(breakdowns, date, 'mcp_server', row.breakdown.mcp_servers);
        }

        if (endpoint.entityDimension !== null) {
          this.collect(breakdowns, date, endpoint.entityDimension, row.breakdown.entities);
        }
      }
    }

    const snapshot: GatewaySnapshot = {
      daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
      breakdowns: [...breakdowns.values()],
      // Every day in the requested window is replaced, not only the days the
      // proxy answered for: a day that dropped to zero must lose its old rows.
      dates: eachDay(from, to),
    };

    log.info(
      {
        dash: {
          from,
          to,
          days: snapshot.daily.length,
          breakdownRows: snapshot.breakdowns.length,
        },
      },
      'litellm usage fetched',
    );

    return snapshot;
  }

  /**
   * Current budgets and rate limits for every key, team and tag the credential
   * can see, from the management routes rather than the analytics ones.
   *
   * All three routes are optional, and independently so — a proxy can perfectly
   * well have keys and no tags, and a tag-management route only exists on newer
   * versions at all. A read-only analytics key is also a reasonable thing to
   * point this integration at, and it will be refused every one of them:
   * governance simply goes missing then, which the UI can say, and the usage
   * sync carries on. That is why the whole method swallows an absent route
   * instead of letting it propagate — `fetchBudgets` returning `[]` is a
   * supported answer.
   */
  async fetchBudgets(): Promise<GatewayBudgetSnapshot[]> {
    const budgets = new Map<string, GatewayBudgetSnapshot>();

    for (const budget of await this.fetchKeyBudgets()) {
      budgets.set(`api_key ${budget.key}`, budgets.get(`api_key ${budget.key}`) ?? budget);
    }
    for (const budget of await this.fetchTeamBudgets()) {
      budgets.set(`team ${budget.key}`, budgets.get(`team ${budget.key}`) ?? budget);
    }
    for (const budget of await this.fetchTagBudgets()) {
      budgets.set(`tag ${budget.key}`, budgets.get(`tag ${budget.key}`) ?? budget);
    }

    log.info({ dash: { budgets: budgets.size } }, 'litellm budgets fetched');
    return [...budgets.values()];
  }

  /** Every page of `/key/list`. Bare-string key rows carry no budget and are dropped. */
  private async fetchKeyBudgets(): Promise<GatewayBudgetSnapshot[]> {
    const budgets: GatewayBudgetSnapshot[] = [];
    let unidentified = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = new URL(`${this.root}/key/list`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('size', String(KEY_PAGE_SIZE));
      url.searchParams.set('return_full_object', 'true');

      const body = await this.getJson(url, true);
      if (body === null) return budgets;

      const parsed = keyListSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error(
          `LiteLLM /key/list returned an unexpected shape: ${parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.')} ${issue.message}`)
            .join('; ')}`,
        );
      }

      for (const row of parsed.data.keys) {
        // A bare token string, or a full object the proxy declined to identify:
        // the hashed token is the only id that joins to the `api_key` usage
        // dimension, so a row without one would be an orphan and is dropped.
        if (typeof row === 'string' || !row.token) {
          unidentified += 1;
          continue;
        }
        budgets.push({
          scope: 'api_key',
          key: row.token.slice(0, 200),
          label: row.key_alias?.trim() ? row.key_alias.trim().slice(0, 200) : null,
          spendNano: dollarsToNano(row.spend ?? 0),
          maxBudgetNano: optionalDollarsToNano(row.max_budget),
          softBudgetNano: optionalDollarsToNano(row.soft_budget),
          budgetDuration: row.budget_duration?.trim().slice(0, 20) ?? null,
          resetAt: toInstant(row.budget_reset_at),
          tpmLimit: toLimit(row.tpm_limit),
          rpmLimit: toLimit(row.rpm_limit),
          blocked: row.blocked === true,
        });
      }

      const totalPages = parsed.data.total_pages ?? 1;
      if (parsed.data.keys.length === 0 || page >= totalPages) break;
    }

    if (unidentified > 0) {
      log.warn(
        { dash: { unidentified } },
        'key rows without a hashed token — budgets for them cannot be joined to usage',
      );
    }
    return budgets;
  }

  /** `/team/list` — a bare array, no pagination envelope. */
  private async fetchTeamBudgets(): Promise<GatewayBudgetSnapshot[]> {
    const body = await this.getJson(new URL(`${this.root}/team/list`), true);
    if (body === null) return [];

    const parsed = teamListSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `LiteLLM /team/list returned an unexpected shape: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      );
    }

    return parsed.data
      .filter((row) => row.team_id !== '')
      .map((row) => ({
        scope: 'team' as const,
        key: row.team_id.slice(0, 200),
        label: row.team_alias?.trim() ? row.team_alias.trim().slice(0, 200) : null,
        spendNano: dollarsToNano(row.spend ?? 0),
        maxBudgetNano: optionalDollarsToNano(row.max_budget),
        softBudgetNano: optionalDollarsToNano(row.soft_budget),
        budgetDuration: row.budget_duration?.trim().slice(0, 20) ?? null,
        resetAt: toInstant(row.budget_reset_at),
        tpmLimit: toLimit(row.tpm_limit),
        rpmLimit: toLimit(row.rpm_limit),
        blocked: row.blocked === true,
      }));
  }

  /**
   * `/tag/list` — a bare array like teams, but with the limits one level down.
   *
   * Everything a key row spells at the top level (`max_budget`, `soft_budget`,
   * `budget_duration`, `budget_reset_at`, the rate limits) lives on the joined
   * `litellm_budget_table` here, and the tag row itself carries only its name,
   * its `spend` and the `budget_id` it is linked by. A tag with a `budget_id`
   * but no included budget object is therefore capped-by-something-we-cannot-see
   * rather than uncapped, and it lands with every limit null — which reads as
   * uncapped on the card. That is the honest answer from this payload; the
   * alternative would be inventing a limit.
   *
   * Dynamic tags are dropped (see `isGoverned`) and counted, because a proxy
   * where every tag is dynamic means nobody has created a tag budget at all —
   * which is a different thing to report than "no tags".
   */
  private async fetchTagBudgets(): Promise<GatewayBudgetSnapshot[]> {
    const body = await this.getJson(new URL(`${this.root}/tag/list`), true);
    if (body === null) return [];

    const parsed = tagListSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `LiteLLM /tag/list returned an unexpected shape: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      );
    }

    let dynamic = 0;
    const budgets: GatewayBudgetSnapshot[] = [];

    for (const row of parsed.data) {
      if (row.name.trim() === '') continue;
      if (!isGoverned(row)) {
        dynamic += 1;
        continue;
      }
      const limits = row.litellm_budget_table ?? null;
      budgets.push({
        scope: 'tag',
        // The tag name IS the id — it is the primary key of LiteLLM_TagTable and
        // the same string the `tag` usage dimension is keyed by, so no alias
        // resolution is possible or needed. `description` is prose, not a label.
        key: row.name.trim().slice(0, 200),
        label: null,
        spendNano: dollarsToNano(row.spend ?? 0),
        maxBudgetNano: optionalDollarsToNano(limits?.max_budget),
        softBudgetNano: optionalDollarsToNano(limits?.soft_budget),
        budgetDuration: limits?.budget_duration?.trim().slice(0, 20) ?? null,
        resetAt: toInstant(limits?.budget_reset_at),
        tpmLimit: toLimit(limits?.tpm_limit),
        rpmLimit: toLimit(limits?.rpm_limit),
        blocked: row.blocked === true,
      });
    }

    if (dynamic > 0) {
      log.info(
        { dash: { dynamic, governed: budgets.length } },
        'tag rows seen only in spend data — reported as usage, not as governance',
      );
    }
    return budgets;
  }

  /**
   * Call every route the sync depends on once, for one day, and report what
   * each answered.
   *
   * Three things it deliberately does differently from a sync:
   *
   *   - **No retries.** A probe reports the proxy as it is right now; retrying
   *     a 503 three times would turn a flaky gateway into a green tick and make
   *     the button take eight seconds to say so.
   *   - **No throwing.** A refused route, an unreadable body and a dead host
   *     are all *results* here, each with its own status, where the sync can
   *     only distinguish "skip" from "fail".
   *   - **401/403 is not 404.** `ABSENT_STATUSES` folds them together because
   *     the sync's only choice is to skip; the probe keeps them apart because
   *     one is fixed by granting the key a permission and the other cannot be
   *     fixed at all.
   */
  async probe(day: string): Promise<GatewayProbeRoute[]> {
    const routes: GatewayProbeRoute[] = [];

    for (const endpoint of ENDPOINTS) {
      const url = new URL(`${this.root}${endpoint.path}`);
      url.searchParams.set('start_date', day);
      url.searchParams.set('end_date', day);
      url.searchParams.set('page', '1');
      url.searchParams.set('page_size', String(PAGE_SIZE));
      routes.push(await this.probeActivity(endpoint, url));
    }

    routes.push(await this.probeKeyList());
    routes.push(await this.probeTeamList());
    routes.push(await this.probeTagList());

    log.info(
      { dash: { statuses: routes.map((route) => `${route.path} ${route.status}`) } },
      'litellm probe complete',
    );
    return routes;
  }

  private async probeActivity(endpoint: DailyEndpoint, url: URL): Promise<GatewayProbeRoute> {
    const attempt = await this.probeOnce(url);
    const base = {
      path: endpoint.path,
      purpose: endpoint.purpose,
      required: endpoint.required,
      httpStatus: attempt.httpStatus,
      durationMs: attempt.durationMs,
    };
    if (attempt.body === undefined) {
      return { ...base, status: attempt.status, rows: null, detail: attempt.detail, dimensions: [] };
    }

    const parsed = activityResponseSchema.safeParse(attempt.body);
    if (!parsed.success) {
      return {
        ...base,
        status: 'malformed',
        rows: null,
        detail: describeIssues(parsed.error.issues),
        dimensions: [],
      };
    }

    // Distinct keys per dimension across the day, which is what decides whether
    // a breakdown card has anything to draw — a route can answer 200 with rows
    // and still carry an empty `breakdown`.
    const counts = new Map<GatewayDimension, number>();
    const seen = new Map<GatewayDimension, Set<string>>();
    const note = (dimension: GatewayDimension, buckets: Record<string, Bucket>): void => {
      const keys = seen.get(dimension) ?? new Set<string>();
      for (const key of Object.keys(buckets)) if (key !== '') keys.add(key);
      seen.set(dimension, keys);
      counts.set(dimension, keys.size);
    };
    for (const row of parsed.data.results) {
      if (endpoint.totals) {
        note('model', row.breakdown.models);
        note('provider', row.breakdown.providers);
        note('api_key', row.breakdown.api_keys);
        note('mcp_server', row.breakdown.mcp_servers);
      }
      if (endpoint.entityDimension !== null) note(endpoint.entityDimension, row.breakdown.entities);
    }

    const rows = parsed.data.results.length;
    const spend = parsed.data.results.reduce((sum, row) => sum + row.metrics.spend, 0);
    return {
      ...base,
      status: rows === 0 ? 'empty' : 'ok',
      rows,
      detail:
        rows === 0
          ? null
          : `${rows} day(s), $${spend.toFixed(2)} spend${endpoint.totals ? '' : ' (re-sliced, not counted in totals)'}`,
      dimensions: coverageOf(endpoint, counts),
    };
  }

  private async probeKeyList(): Promise<GatewayProbeRoute> {
    const url = new URL(`${this.root}/key/list`);
    url.searchParams.set('page', '1');
    url.searchParams.set('size', String(KEY_PAGE_SIZE));
    url.searchParams.set('return_full_object', 'true');

    const attempt = await this.probeOnce(url);
    const base = {
      path: '/key/list',
      purpose:
        'The budget card will be empty for API keys — caps, rate limits and the enforced period counter all come from here.',
      required: false,
      httpStatus: attempt.httpStatus,
      durationMs: attempt.durationMs,
      dimensions: [],
    };
    if (attempt.body === undefined) {
      return { ...base, status: attempt.status, rows: null, detail: attempt.detail };
    }

    const parsed = keyListSchema.safeParse(attempt.body);
    if (!parsed.success) {
      return { ...base, status: 'malformed', rows: null, detail: describeIssues(parsed.error.issues) };
    }

    // A proxy that ignores `return_full_object` answers bare token strings,
    // which carry no budget and cannot be joined to the api_key dimension. That
    // is a 200 the sync silently drops every row of, so it is worth its own
    // reading here rather than a count.
    const rows = parsed.data.keys.length;
    const usable = parsed.data.keys.filter(
      (row) => typeof row !== 'string' && typeof row.token === 'string' && row.token !== '',
    ).length;
    return {
      ...base,
      status: rows === 0 ? 'empty' : 'ok',
      rows,
      detail:
        rows === 0
          ? null
          : usable === rows
            ? `${rows} key(s), all carrying budgets`
            : `${rows} key(s), only ${usable} identified — the rest answered as bare tokens and cannot be joined to usage`,
    };
  }

  private async probeTeamList(): Promise<GatewayProbeRoute> {
    const attempt = await this.probeOnce(new URL(`${this.root}/team/list`));
    const base = {
      path: '/team/list',
      purpose: 'The budget card will be empty for teams; API-key budgets are unaffected.',
      required: false,
      httpStatus: attempt.httpStatus,
      durationMs: attempt.durationMs,
      dimensions: [],
    };
    if (attempt.body === undefined) {
      return { ...base, status: attempt.status, rows: null, detail: attempt.detail };
    }

    const parsed = teamListSchema.safeParse(attempt.body);
    if (!parsed.success) {
      return { ...base, status: 'malformed', rows: null, detail: describeIssues(parsed.error.issues) };
    }
    const rows = parsed.data.length;
    return {
      ...base,
      status: rows === 0 ? 'empty' : 'ok',
      rows,
      detail: rows === 0 ? null : `${rows} team(s)`,
    };
  }

  /**
   * `/tag/list`, which answers three distinguishable things and only one of them
   * is "tag budgets work here":
   *
   *   - `absent` — an older proxy with no tag management at all. The likeliest
   *     outcome, and the only one that cannot be fixed by configuration.
   *   - `ok` with every row dynamic — the route exists and nobody has created a
   *     tag. The card would be empty and the reason is not a permission.
   *   - `ok` with governed rows — tag budgets are actually in use.
   *
   * The count that matters is therefore the governed one, not `rows`, which is
   * why the detail spells both.
   */
  private async probeTagList(): Promise<GatewayProbeRoute> {
    const attempt = await this.probeOnce(new URL(`${this.root}/tag/list`));
    const base = {
      path: '/tag/list',
      purpose:
        'The budget card will be empty for tags; API-key and team budgets are unaffected. Older proxies have no tag management at all.',
      required: false,
      httpStatus: attempt.httpStatus,
      durationMs: attempt.durationMs,
      dimensions: [],
    };
    if (attempt.body === undefined) {
      return { ...base, status: attempt.status, rows: null, detail: attempt.detail };
    }

    const parsed = tagListSchema.safeParse(attempt.body);
    if (!parsed.success) {
      return { ...base, status: 'malformed', rows: null, detail: describeIssues(parsed.error.issues) };
    }
    const rows = parsed.data.length;
    const governed = parsed.data.filter(isGoverned).length;
    return {
      ...base,
      // A route answering only dynamic tags has nothing to govern, which is the
      // same consequence as an empty one: no tag rows on the budget card.
      status: governed === 0 ? 'empty' : 'ok',
      rows,
      detail:
        rows === 0
          ? null
          : governed === rows
            ? `${rows} tag(s), all configured`
            : `${rows} tag(s), ${governed} configured — the rest were only seen in spend data and carry no budget`,
    };
  }

  /**
   * One GET, one attempt, classified. `body` is present only on a 2xx; every
   * other outcome carries the status that says why not.
   */
  private async probeOnce(url: URL): Promise<ProbeAttempt> {
    const started = Date.now();
    const elapsed = () => Date.now() - started;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        status: 'unreachable',
        httpStatus: null,
        durationMs: elapsed(),
        detail: String(error instanceof Error ? error.message : error).slice(0, 300),
      };
    }

    if (response.ok) {
      try {
        return {
          status: 'ok',
          httpStatus: response.status,
          durationMs: elapsed(),
          detail: null,
          body: await response.json(),
        };
      } catch (error) {
        return {
          status: 'malformed',
          httpStatus: response.status,
          durationMs: elapsed(),
          detail: `body is not JSON: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`,
        };
      }
    }

    const text = await response.text().catch(() => '');
    const status =
      response.status === 401 || response.status === 403
        ? 'denied'
        : ABSENT_STATUSES.has(response.status)
          ? 'absent'
          : 'unreachable';
    return {
      status,
      httpStatus: response.status,
      durationMs: elapsed(),
      detail: text.trim() === '' ? null : text.slice(0, 300),
    };
  }

  /** Folds one breakdown object into the accumulator. */
  private collect(
    into: Map<string, GatewayBreakdownSnapshot>,
    date: string,
    dimension: GatewayDimension,
    buckets: Record<string, Bucket>,
  ): void {
    for (const [key, bucket] of Object.entries(buckets)) {
      if (key === '') continue;
      const id = key.slice(0, 200);
      const mapKey = bucketKey(date, dimension, id);
      const existing = into.get(mapKey);
      if (existing) {
        addCounters(existing, toCounters(bucket.metrics));
        existing.label ??= pickLabel(bucket.metadata);
        continue;
      }
      into.set(mapKey, {
        date,
        dimension,
        key: id,
        label: pickLabel(bucket.metadata),
        ...ZERO_COUNTERS,
        ...toCounters(bucket.metrics),
      });
    }
  }

  /**
   * Every page of one endpoint, or null when an optional endpoint is absent.
   * Pagination stops on `has_more`, on the reported page count, or on an empty
   * page — a proxy that leaves `has_more` true forever would otherwise spin.
   */
  private async fetchAllPages(
    endpoint: DailyEndpoint,
    from: string,
    to: string,
  ): Promise<DailyRow[] | null> {
    const rows: DailyRow[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = new URL(`${this.root}${endpoint.path}`);
      url.searchParams.set('start_date', from);
      url.searchParams.set('end_date', to);
      url.searchParams.set('page', String(page));
      url.searchParams.set('page_size', String(PAGE_SIZE));

      const body = await this.getJson(url, !endpoint.required);
      if (body === null) return null;

      const parsed = activityResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error(
          `LiteLLM ${endpoint.path} returned an unexpected shape: ${parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.')} ${issue.message}`)
            .join('; ')}`,
        );
      }

      rows.push(...parsed.data.results);

      const { has_more: hasMore, total_pages: totalPages } = parsed.data.metadata;
      if (parsed.data.results.length === 0 || !hasMore || page >= totalPages) break;
      if (page === MAX_PAGES) {
        log.warn(
          { dash: { path: endpoint.path, pages: MAX_PAGES } },
          'stopped paging the gateway at the page cap — data may be truncated',
        );
      }
    }

    return rows;
  }

  /**
   * One GET, decoded as JSON — or null when an *optional* route answers one of
   * the "this proxy does not offer that" statuses. Every gateway request goes
   * through here so absent-vs-broken is classified in exactly one place; two
   * predicates over the same status code in two functions is how the 501 retry
   * bug got in.
   */
  private async getJson(url: URL, optional: boolean): Promise<unknown | null> {
    const response = await this.request(url);
    if (response.ok) return response.json();

    const body = await response.text().catch(() => '');
    if (optional && ABSENT_STATUSES.has(response.status)) {
      log.info(
        { dash: { path: url.pathname, status: response.status } },
        'optional gateway endpoint unavailable — skipped',
      );
      return null;
    }
    throw new Error(`LiteLLM ${url.pathname} responded ${response.status}: ${body.slice(0, 300)}`);
  }

  /** GET with bearer auth, a timeout, and retries on network errors and `isTransient` statuses. */
  private async request(url: URL): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!isTransient(response.status)) return response;
        lastError = new Error(`status ${response.status}`);
      } catch (error) {
        lastError = error;
      }

      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      log.warn(
        { err: lastError, dash: { url: url.pathname, attempt: attempt + 1, delay } },
        'litellm request failed — retrying',
      );
      await sleep(delay);
    }

    throw new Error(`LiteLLM ${url.pathname} unreachable: ${String(lastError)}`);
  }
}

/** Every ISO day in an inclusive range, ascending. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}
