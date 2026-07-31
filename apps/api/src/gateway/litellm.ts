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
 * pull is a handful of requests instead of millions of rows. The raw log is
 * read by exactly one method here — `fetchSpendLogs`, over a window of days
 * rather than months, behind a drill-down and never by the sync — because it
 * is the only place the dimensions appear on one row and therefore the only
 * source of a joint key.
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
import { SPEND_LOG_ROW_CAP } from '@dash/shared';
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
  GatewayHealthSnapshot,
  GatewayModelSnapshot,
  GatewaySnapshot,
  GatewaySpendLogPage,
  GatewaySpendLogRecord,
} from './types.js';

const log = moduleLogger('gateway.litellm');

/** Rows per page. LiteLLM defaults to 10; days are few and fat, so ask for more. */
const PAGE_SIZE = 100;

/** Runaway guard — a proxy that never clears `has_more` must not loop forever. */
const MAX_PAGES = 50;

const RETRY_DELAYS_MS = [500, 1_000, 2_000];

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * `/health`'s own timeout. Every other route reads a table and answers in
 * milliseconds; this one may issue a live test call to each of a corporate
 * gateway's deployments and only then answer, so thirty seconds would time out
 * on exactly the proxies worth checking.
 */
const HEALTH_TIMEOUT_MS = 180_000;

/**
 * The probe's own timeout — a third of the sync's, because it runs behind a
 * button someone is watching, and "slow" is itself the answer they need.
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * `/spend/logs`'s own timeout. It reads a table like the activity routes, but
 * the largest one the proxy has and without the aggregates' pre-computation, so
 * a week of a corporate gateway is a real query rather than a lookup.
 */
const SPEND_LOG_TIMEOUT_MS = 60_000;

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

/**
 * `/model/info` — the fourth management envelope, and the only one that is
 * neither a bare array nor a paginated page: a single `{"data": [...]}` object
 * holding every routable deployment, however many there are.
 *
 * The shape is LiteLLM's `Deployment` model, so each entry is three nested
 * objects rather than a flat row:
 *
 *  - `model_name` — the **public alias**, what a caller puts in `"model"`.
 *  - `litellm_params.model` — the backend the alias routes to. The api key and
 *    base are stripped by the proxy before it answers (`remove_sensitive_info…`),
 *    so what is left is safe to store.
 *  - `model_info` — the config's own block, with LiteLLM's price map merged
 *    *underneath* it (`_get_proxy_model_info`: config values win, the map fills
 *    the gaps). Which is why a proxy with a hand-priced model answers the
 *    override here and not the list price.
 *
 * Prices are per token and can be absent in two different ways that must not be
 * conflated: a model priced per second (`input_cost_per_second`, Bedrock
 * provisioned throughput) has no per-token key at all, while an explicit `0` is
 * a free model — LiteLLM skips budget checks entirely for one, which is a
 * configuration choice rather than missing data.
 */
const modelEntrySchema = z.object({
  model_name: z.string().nullish(),
  litellm_params: z
    .object({
      model: z.string().nullish(),
      custom_llm_provider: z.string().nullish(),
    })
    .passthrough()
    .nullish(),
  model_info: z
    .object({
      id: z.string().nullish(),
      mode: z.string().nullish(),
      litellm_provider: z.string().nullish(),
      input_cost_per_token: nullableNumber,
      output_cost_per_token: nullableNumber,
      cache_read_input_token_cost: nullableNumber,
      cache_creation_input_token_cost: nullableNumber,
      max_input_tokens: nullableNumber,
      max_output_tokens: nullableNumber,
    })
    .passthrough()
    .nullish(),
});

/**
 * `{"data": [...]}`. The single-model form (`?litellm_model_id=`) answers a bare
 * object under the same key, which this integration never asks for — it wants
 * the whole list — but the union costs nothing and stops a proxy quirk from
 * failing a sync.
 */
const modelInfoSchema = z.object({
  data: z.union([z.array(modelEntrySchema), modelEntrySchema]).default([]),
});

type ModelEntry = z.infer<typeof modelEntrySchema>;

/**
 * `GET /health` — one entry per *deployment*, split into two lists.
 *
 * A fifth envelope, and the only one that is not a table: the proxy answers
 * `{healthy_endpoints, unhealthy_endpoints, healthy_count, unhealthy_count}`,
 * and which list an entry is in *is* the state — there is no status field to
 * read. Each entry is that deployment's `litellm_params` with the secrets
 * removed (`ILLEGAL_DISPLAY_PARAMS` drops `api_key`, `messages`, the Vertex and
 * AWS credentials and the raw exception object), so what survives is the
 * routing string, the base URL and — for a failure — an `error` string and the
 * `exception_status` LiteLLM copies off the upstream error.
 *
 * Everything except the two lists is optional on purpose. A proxy configured
 * with `health_check_details: false` answers only `{"model": …}` per entry
 * (`MINIMAL_DISPLAY_PARAMS`), which is a legitimate hardening choice on a widely
 * exposed gateway: the deployment is still named, the state is still known, and
 * only the error text and the endpoint go missing.
 */
const healthEntrySchema = z
  .object({
    model: z.string().nullish(),
    model_id: z.string().nullish(),
    api_base: z.string().nullish(),
    custom_llm_provider: z.string().nullish(),
    error: z.string().nullish(),
    mode_error: z.string().nullish(),
    exception_status: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

const healthSchema = z.object({
  healthy_endpoints: z.array(healthEntrySchema).default([]),
  unhealthy_endpoints: z.array(healthEntrySchema).default([]),
});

type HealthEntry = z.infer<typeof healthEntrySchema>;

/**
 * `GET /health/readiness` — the proxy's own state, and the only LiteLLM route
 * this client touches that needs no credential and costs nothing to call.
 *
 * Low-detail by default (`{"status": "healthy", "db": "connected"}`); a proxy
 * with `allow_public_health_readiness_details` also answers its version. Both
 * shapes parse.
 */
const readinessSchema = z
  .object({
    status: z.string().nullish(),
    db: z.string().nullish(),
    litellm_version: z.string().nullish(),
  })
  .passthrough();

/**
 * `GET /spend/logs?start_date&end_date&summarize=false` — one entry per
 * request, straight off `LiteLLM_SpendLogs`.
 *
 * A sixth envelope, and the loosest of them: the documented answer is a bare
 * JSON array of table rows, while newer proxies wrap the same rows in a
 * `{"data": […]}` object alongside the paginated UI route. Both parse here,
 * because which one a given proxy answers with is a version question this
 * draft cannot settle.
 *
 * `summarize` is the parameter that matters: it defaults to *true*, which
 * answers pre-aggregated daily totals — the same numbers the activity routes
 * already give, and none of the joint keys this route is fetched for. Asking
 * without it would fetch the wrong thing successfully.
 *
 * Every column except `request_id` is optional. The table has grown steadily
 * (`session_id`, `status`, `agent_id`, `mcp_namespaced_tool_name` and
 * `request_duration_ms` are all recent), and an older proxy omitting them is
 * ordinary rather than malformed.
 */
const spendLogRowSchema = z
  .object({
    // Optional even though the table's primary key is not: a sample tolerates a
    // row it cannot use, where a *ledger* payload does not. Every other gateway
    // schema here throws on a shape it did not expect, because a malformed
    // aggregate would sync silently wrong numbers; one unreadable log line is a
    // dropped piece of evidence and nothing else.
    request_id: z.string().nullish(),
    call_type: z.string().nullish(),
    api_key: z.string().nullish(),
    spend: z.number().nullish(),
    total_tokens: z.number().nullish(),
    prompt_tokens: z.number().nullish(),
    completion_tokens: z.number().nullish(),
    startTime: z.union([z.string(), z.number()]).nullish(),
    endTime: z.union([z.string(), z.number()]).nullish(),
    request_duration_ms: z.number().nullish(),
    model: z.string().nullish(),
    model_id: z.string().nullish(),
    model_group: z.string().nullish(),
    custom_llm_provider: z.string().nullish(),
    api_base: z.string().nullish(),
    user: z.string().nullish(),
    metadata: z.record(z.unknown()).nullish(),
    cache_hit: z.string().nullish(),
    request_tags: z.union([z.array(z.string()), z.string()]).nullish(),
    team_id: z.string().nullish(),
    end_user: z.string().nullish(),
    session_id: z.string().nullish(),
    status: z.string().nullish(),
    mcp_namespaced_tool_name: z.string().nullish(),
    agent_id: z.string().nullish(),
  })
  .passthrough();

const spendLogsSchema = z.union([
  z.array(spendLogRowSchema),
  z.object({ data: z.array(spendLogRowSchema) }).passthrough(),
]);

type SpendLogRow = z.infer<typeof spendLogRowSchema>;

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
 * A per-*token* price → nano-dollars per *million* tokens.
 *
 * The scale change happens here rather than at the edge because it is the whole
 * reason the catalogue is storable as an integer: `2.5e-06` per token pinned to
 * nine fractional digits is `2500` nano and a $0.05/M model is `50` — three
 * significant figures away from rounding to nothing. Times a million it is
 * `2_500_000_000` and the cheapest model on any list still has room.
 *
 * Null in, null out, and a negative price is not a fact either. Zero *is* one:
 * a model configured at 0 is free on purpose.
 */
function perTokenToNanoPerMillion(cost: number | null | undefined): bigint | null {
  if (cost === null || cost === undefined || !Number.isFinite(cost) || cost < 0) return null;
  return dollarsToNano(cost * 1_000_000);
}

/** A context-window size, or null. Same shape as `toLimit` — 0 tokens is not a window. */
function toWindow(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

/**
 * The public alias an entry belongs under, or null when it has no usable name.
 *
 * A wildcard row (`*`, `azure/*`) is a *routing* rule rather than a model: it
 * prices nothing, and no usage key will ever equal it. Admitting it would put a
 * priceless row into the denominator the catalogue's coverage is measured
 * against — the same reason `/tag/list`'s dynamic tags are dropped.
 */
function modelKeyOf(entry: ModelEntry): string | null {
  const alias = entry.model_name?.trim() ?? '';
  const backend = entry.litellm_params?.model?.trim() ?? '';
  const key = alias !== '' ? alias : backend;
  if (key === '' || key === '*' || key.endsWith('/*')) return null;
  return key.slice(0, 200);
}

/** The four per-token price fields, read off one deployment in storage units. */
function pricesOf(entry: ModelEntry): (bigint | null)[] {
  const info = entry.model_info ?? null;
  return [
    perTokenToNanoPerMillion(info?.input_cost_per_token),
    perTokenToNanoPerMillion(info?.output_cost_per_token),
    perTokenToNanoPerMillion(info?.cache_read_input_token_cost),
    perTokenToNanoPerMillion(info?.cache_creation_input_token_cost),
  ];
}

/** The cheapest non-null value, or null when no deployment carried one. */
function cheapest(values: readonly (bigint | null)[]): bigint | null {
  let best: bigint | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (best === null || value < best) best = value;
  }
  return best;
}

/** The smallest non-null, for counts rather than money. */
function smallest(values: readonly (number | null)[]): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (best === null || value < best) best = value;
  }
  return best;
}

/** The first non-empty string, for the descriptive fields where there is nothing to minimise. */
function firstOf(values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

/**
 * Every deployment answering to one public alias, collapsed into one catalogue
 * row.
 *
 * `priceVaries` is deliberately strict: two deployments *disagree* not only when
 * they quote different numbers but when one quotes a price and the other quotes
 * none. A PTU deployment billed per second sitting behind the same alias as a
 * pay-as-you-go one is exactly that case, and it is the one where a single rate
 * misleads most — traffic split across them costs something between the quoted
 * price and nothing at all.
 */
function toModelSnapshot(model: string, group: readonly ModelEntry[]): GatewayModelSnapshot {
  const priced = group.map(pricesOf);
  const varies = [0, 1, 2, 3].some((field) => {
    const values = priced.map((row) => row[field] ?? null);
    return values.some((value) => value !== values[0]);
  });

  const backend = firstOf(group.map((entry) => entry.litellm_params?.model?.trim()));
  const provider =
    firstOf(group.map((entry) => entry.model_info?.litellm_provider?.trim())) ??
    firstOf(group.map((entry) => entry.litellm_params?.custom_llm_provider?.trim())) ??
    // Last resort, and the same rule the `provider` usage dimension is keyed by:
    // LiteLLM writes the routing string as `<provider>/<deployment>`.
    (backend !== null && backend.includes('/') ? (backend.split('/')[0] ?? null) : null);

  return {
    model,
    backend: backend === null ? null : backend.slice(0, 200),
    provider: provider === null || provider === '' ? null : provider.slice(0, 60),
    mode: firstOf(group.map((entry) => entry.model_info?.mode?.trim()))?.slice(0, 40) ?? null,
    inputPerMillionNano: cheapest(priced.map((row) => row[0] ?? null)),
    outputPerMillionNano: cheapest(priced.map((row) => row[1] ?? null)),
    cacheReadPerMillionNano: cheapest(priced.map((row) => row[2] ?? null)),
    cacheWritePerMillionNano: cheapest(priced.map((row) => row[3] ?? null)),
    // Context windows collapse to the smallest for a different reason than
    // prices do: it is the one every deployment behind the alias honours, so a
    // prompt that fits it routes anywhere.
    maxInputTokens: smallest(group.map((entry) => toWindow(entry.model_info?.max_input_tokens))),
    maxOutputTokens: smallest(group.map((entry) => toWindow(entry.model_info?.max_output_tokens))),
    deployments: group.length,
    priceVaries: varies,
  };
}

/**
 * An upstream status off a failed health check, or null.
 *
 * `exception_status` is `getattr(exc, "status_code", 500)` on the proxy's side,
 * so it is usually an int and occasionally a string a provider SDK carried
 * through. Anything that is not a plausible HTTP status becomes null rather than
 * a number nobody can read — a `429` here is the difference between "this
 * deployment is out of quota" and "this deployment is gone".
 */
function toErrorStatus(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 100 || parsed > 599) return null;
  return Math.trunc(parsed);
}

/**
 * One `/health` entry → a stored row, or null when it names no deployment.
 *
 * The id is `model_id` where the proxy gave one and the routing string
 * otherwise, and the fallback is load-bearing rather than defensive: two
 * deployments of one alias are two rows *only* if they have distinct ids, so a
 * proxy that answers without them collapses its own load-balanced pool into one
 * row. That is a real loss of resolution and the reason `model_id` is tried
 * first — but a single row saying "azure/gpt-4o is failing" still beats
 * dropping the entry.
 */
function toHealthSnapshot(entry: HealthEntry, healthy: boolean): GatewayHealthSnapshot | null {
  const backend = entry.model?.trim() ?? '';
  if (backend === '') return null;

  const id = entry.model_id?.trim();
  const provider =
    entry.custom_llm_provider?.trim() ??
    (backend.includes('/') ? (backend.split('/')[0] ?? null) : null);

  // `error` is the health check's own message; `mode_error` is the narrower
  // "this deployment does not support the mode we probed it with", which is a
  // configuration fault rather than an outage and still means the check failed.
  const error = firstOf([entry.error?.trim(), entry.mode_error?.trim()]);

  return {
    id: (id === undefined || id === '' ? backend : id).slice(0, 200),
    backend: backend.slice(0, 200),
    provider: provider === null || provider === '' ? null : provider.slice(0, 60),
    apiBase: entry.api_base?.trim().slice(0, 300) || null,
    healthy,
    // A healthy deployment's entry can still carry stray keys; an error on one
    // would be nonsense, so the state decides whether the text is kept.
    error: healthy ? null : (error?.slice(0, 500) ?? null),
    errorStatus: healthy ? null : toErrorStatus(entry.exception_status),
  };
}

/** A LiteLLM timestamp as an ISO instant, or null. */
function toInstantIso(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * `cache_hit` is a *string* column with an empty default, so it has three
 * states rather than two: `"True"`, `"False"`, and "nobody recorded it". Only
 * the first two are booleans; the third is null, because a proxy that logs no
 * cache flag has not told us the request missed the cache.
 */
function toCacheHit(value: string | null | undefined): boolean | null {
  if (value === null || value === undefined) return null;
  const text = value.trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}

/**
 * `request_tags` is a Prisma `Json?` defaulting to `[]`, and a proxy that
 * round-trips it through a text column answers with the JSON *string* instead
 * of an array. Both are read; anything else yields no tags, which is a fact
 * about the request rather than a parse failure worth throwing over.
 */
function toTags(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value.filter((tag) => typeof tag === 'string' && tag !== '');
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
      : [];
  } catch {
    return [];
  }
}

/** A metadata field, when it is a non-empty string. */
function metadataString(
  metadata: Record<string, unknown> | null | undefined,
  field: string,
): string | null {
  const value = metadata?.[field];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * One `LiteLLM_SpendLogs` row → the record the drill-down reads.
 *
 * The identity columns are read top-level *then* from `metadata`, in that
 * order, because the proxy writes both and they are not always both filled: the
 * columns are what the spend tables are keyed by, while `metadata` carries the
 * `user_api_key_*` fields the request was authenticated with — which is where a
 * key's alias lives, and the only place any alias appears at all.
 *
 * Duration is `request_duration_ms` where the proxy has the column and the two
 * timestamps' difference where it does not. Latency is the one thing here no
 * aggregate reports, so losing it on older proxies would cost the whole reason
 * this row carries timestamps.
 */
function toSpendLogRecord(row: SpendLogRow): GatewaySpendLogRecord | null {
  const requestId = row.request_id?.trim() ?? '';
  if (requestId === '') return null;

  const startTime = toInstantIso(row.startTime);
  if (startTime === null) return null;
  const endTime = toInstantIso(row.endTime);

  const measured = row.request_duration_ms;
  const spanned =
    endTime === null ? null : new Date(endTime).getTime() - new Date(startTime).getTime();
  const durationMs =
    measured !== null && measured !== undefined && Number.isFinite(measured) && measured >= 0
      ? Math.round(measured)
      : spanned !== null && spanned >= 0
        ? spanned
        : null;

  const text = (value: string | null | undefined): string | null => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? null : trimmed.slice(0, 300);
  };

  return {
    requestId: requestId.slice(0, 200),
    callType: text(row.call_type) ?? 'unknown',
    startTime,
    endTime,
    durationMs,
    model: text(row.model),
    modelGroup: text(row.model_group),
    deploymentId: text(row.model_id),
    provider: text(row.custom_llm_provider),
    apiBase: text(row.api_base),
    apiKey: text(row.api_key) ?? metadataString(row.metadata, 'user_api_key'),
    keyAlias: metadataString(row.metadata, 'user_api_key_alias'),
    user: text(row.user) ?? metadataString(row.metadata, 'user_api_key_user_id'),
    teamId: text(row.team_id) ?? metadataString(row.metadata, 'user_api_key_team_id'),
    teamAlias: metadataString(row.metadata, 'user_api_key_team_alias'),
    endUser: text(row.end_user),
    tags: toTags(row.request_tags).map((tag) => tag.slice(0, 200)),
    mcpTool: text(row.mcp_namespaced_tool_name),
    sessionId: text(row.session_id),
    agentId: text(row.agent_id),
    spendNano: dollarsToNano(row.spend ?? 0),
    promptTokens: Math.max(0, Math.round(row.prompt_tokens ?? 0)),
    completionTokens: Math.max(0, Math.round(row.completion_tokens ?? 0)),
    totalTokens: Math.max(0, Math.round(row.total_tokens ?? 0)),
    cacheHit: toCacheHit(row.cache_hit),
    status: text(row.status),
  };
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
   * `GET /model/info` — the proxy's configured price list.
   *
   * One row per *public alias*, not per deployment. LiteLLM load-balances any
   * number of deployments behind one `model_name` (two regions, a PTU pool and
   * a pay-as-you-go fallback), and the daily aggregates carry no deployment id
   * to split them by, so a per-deployment table could never be joined to usage.
   * Collapsing is therefore forced rather than chosen — and where the collapsed
   * deployments disagree on price, the row reports the **cheapest** and says it
   * varies, because a floor with a flag on it is a number a card can be honest
   * about and an average of two price lists is not.
   *
   * Optional, like every management route: an analytics-only credential is
   * refused it and the usage sync must not care.
   */
  async fetchModels(): Promise<GatewayModelSnapshot[]> {
    const body = await this.getJson(new URL(`${this.root}/model/info`), true);
    if (body === null) return [];

    const parsed = modelInfoSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `LiteLLM /model/info returned an unexpected shape: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      );
    }

    const entries = Array.isArray(parsed.data.data) ? parsed.data.data : [parsed.data.data];
    const grouped = new Map<string, ModelEntry[]>();
    let wildcards = 0;

    for (const entry of entries) {
      const key = modelKeyOf(entry);
      if (key === null) {
        wildcards += 1;
        continue;
      }
      const bucket = grouped.get(key);
      if (bucket === undefined) grouped.set(key, [entry]);
      else bucket.push(entry);
    }

    const models = [...grouped.entries()].map(([model, group]) => toModelSnapshot(model, group));

    log.info(
      {
        dash: {
          deployments: entries.length,
          models: models.length,
          varying: models.filter((entry) => entry.priceVaries).length,
          wildcards,
        },
      },
      'litellm model catalogue fetched',
    );
    return models;
  }

  /**
   * `GET /health` — the router's own view of every deployment behind it.
   *
   * The only route this client calls that *does something* rather than reading
   * a table: unless the proxy runs `background_health_checks`, it issues a
   * one-token test call to every configured deployment while answering, which
   * is why the timeout here is minutes rather than seconds and why the sync
   * takes it once a night and a backfill takes it not at all. On a proxy with
   * background checks configured the same route answers the cached result
   * instantly, which is the recommended configuration and is documented as
   * such — but nothing in the response says which of the two happened, so this
   * client cannot tell and does not pretend to.
   *
   * Optional like every management route. A refused `/health` costs the sync
   * nothing: it is the one gateway fact that is purely operational, and no
   * money, token or coverage number depends on it.
   *
   * Duplicate ids are collapsed rather than counted twice, and an *unhealthy*
   * duplicate wins: a deployment reported in both lists (a check that flapped
   * mid-sweep) is not healthy, and the row that would be silently dropped is
   * exactly the one somebody needs to see.
   */
  async fetchHealth(): Promise<GatewayHealthSnapshot[]> {
    const body = await this.getJson(new URL(`${this.root}/health`), true, HEALTH_TIMEOUT_MS);
    if (body === null) return [];

    const parsed = healthSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `LiteLLM /health returned an unexpected shape: ${describeIssues(parsed.error.issues)}`,
      );
    }

    const deployments = new Map<string, GatewayHealthSnapshot>();
    let unnamed = 0;
    const take = (entries: readonly HealthEntry[], healthy: boolean): void => {
      for (const entry of entries) {
        const row = toHealthSnapshot(entry, healthy);
        if (row === null) {
          unnamed += 1;
          continue;
        }
        const existing = deployments.get(row.id);
        if (existing === undefined || (existing.healthy && !row.healthy)) {
          deployments.set(row.id, row);
        }
      }
    };
    take(parsed.data.healthy_endpoints, true);
    take(parsed.data.unhealthy_endpoints, false);

    const rows = [...deployments.values()];
    log.info(
      {
        dash: {
          deployments: rows.length,
          unhealthy: rows.filter((row) => !row.healthy).length,
          unnamed,
        },
      },
      'litellm deployment health fetched',
    );
    return rows;
  }

  /**
   * `GET /spend/logs` — the raw request log for a bounded window.
   *
   * The only read in this client that is not part of a sync and stores nothing.
   * Three things about it are deliberate:
   *
   *   - **`summarize=false`.** The parameter defaults to *true*, which answers
   *     pre-aggregated daily totals: the same numbers `/user/daily/activity`
   *     already gives, without a single joint key. Omitting it would fetch the
   *     wrong thing and succeed.
   *   - **A row cap, not pagination.** The documented route takes a date range
   *     and no page parameters, so the only bound available is the window —
   *     which the caller has already narrowed — plus a hard stop on rows. A
   *     truncated read is reported as truncated; it is never quietly presented
   *     as the window.
   *   - **Optional, and `available: false` is not an error.** A proxy run with
   *     `disable_spend_logs` writes no rows at all, which is a supported way to
   *     run LiteLLM at volume. Refused, absent and empty are all answers here.
   */
  async fetchSpendLogs(from: string, to: string, limit: number): Promise<GatewaySpendLogPage> {
    const url = new URL(`${this.root}/spend/logs`);
    url.searchParams.set('start_date', from);
    url.searchParams.set('end_date', to);
    url.searchParams.set('summarize', 'false');

    const body = await this.getJson(url, true, SPEND_LOG_TIMEOUT_MS);
    if (body === null) return { rows: [], available: false, truncated: false };

    const parsed = spendLogsSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `LiteLLM /spend/logs returned an unexpected shape: ${describeIssues(parsed.error.issues)}`,
      );
    }

    const entries = Array.isArray(parsed.data) ? parsed.data : parsed.data.data;
    const cap = Math.max(1, Math.min(limit, SPEND_LOG_ROW_CAP));
    const rows: GatewaySpendLogRecord[] = [];
    let unusable = 0;

    for (const entry of entries) {
      if (rows.length >= cap) break;
      const record = toSpendLogRecord(entry);
      if (record === null) {
        unusable += 1;
        continue;
      }
      rows.push(record);
    }

    log.info(
      {
        dash: {
          from,
          to,
          returned: entries.length,
          rows: rows.length,
          unusable,
          truncated: entries.length > cap,
        },
      },
      'litellm spend logs fetched',
    );
    return { rows, available: true, truncated: entries.length > cap };
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
    routes.push(await this.probeModelInfo());
    routes.push(await this.probeReadiness());

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
   * `/model/info`, where a `200` carrying rows is still not proof the catalogue
   * is usable: the route answers every routable deployment whether or not the
   * proxy knows what any of them cost. A model LiteLLM's price map has never
   * heard of (an on-prem deployment, a preview SKU) comes back with a name, a
   * backend and no price at all, and a catalogue of those prices nothing.
   *
   * So the count that decides `empty` is the *priced* one, exactly as
   * `/tag/list` judges itself on governed rather than returned rows.
   */
  private async probeModelInfo(): Promise<GatewayProbeRoute> {
    const attempt = await this.probeOnce(new URL(`${this.root}/model/info`));
    const base = {
      path: '/model/info',
      purpose:
        'Per-model list prices, context windows and modality are unavailable — spend, tokens and every usage view are unaffected, but nothing can price a token count.',
      required: false,
      httpStatus: attempt.httpStatus,
      durationMs: attempt.durationMs,
      dimensions: [],
    };
    if (attempt.body === undefined) {
      return { ...base, status: attempt.status, rows: null, detail: attempt.detail };
    }

    const parsed = modelInfoSchema.safeParse(attempt.body);
    if (!parsed.success) {
      return { ...base, status: 'malformed', rows: null, detail: describeIssues(parsed.error.issues) };
    }

    const entries = Array.isArray(parsed.data.data) ? parsed.data.data : [parsed.data.data];
    const named = entries.filter((entry) => modelKeyOf(entry) !== null);
    const priced = named.filter((entry) => pricesOf(entry).some((price) => price !== null)).length;
    const rows = entries.length;

    return {
      ...base,
      status: priced === 0 ? 'empty' : 'ok',
      rows,
      detail:
        rows === 0
          ? null
          : priced === named.length
            ? `${rows} deployment(s), all priced`
            : `${rows} deployment(s), ${priced} priced — the rest carry no per-token cost the proxy could resolve`,
    };
  }

  /**
   * `/health/readiness` — and deliberately **not** `/health`, which is the route
   * the sync actually calls.
   *
   * Every other probe reads a table, so pressing the button costs a query.
   * `/health` issues a live test call to every deployment, so probing it would
   * bill the corporation a token per model per press — a probe has to be free
   * to press or nobody presses it, and the reading it would produce is already
   * taken nightly and stored. Readiness is the honest substitute: it is
   * unauthenticated, it costs nothing, and it answers the question that sits
   * *upstream* of every other route here — is the proxy up, and can it reach its
   * own database. A proxy answering `503` here explains every other row on the
   * panel at once.
   *
   * The one thing it cannot tell us is whether `/health` is permitted, so the
   * purpose line says which card goes dark rather than implying it was checked.
   */
  private async probeReadiness(): Promise<GatewayProbeRoute> {
    const attempt = await this.probeOnce(new URL(`${this.root}/health/readiness`));
    const base = {
      path: '/health/readiness',
      purpose:
        "The proxy's own liveness and database connection. Deployment health comes from /health, which is taken by the nightly sync and deliberately not probed here — it issues a live test call to every deployment.",
      required: false,
      httpStatus: attempt.httpStatus,
      durationMs: attempt.durationMs,
      dimensions: [],
    };
    if (attempt.body === undefined) {
      return { ...base, status: attempt.status, rows: null, detail: attempt.detail };
    }

    const parsed = readinessSchema.safeParse(attempt.body);
    if (!parsed.success) {
      return { ...base, status: 'malformed', rows: null, detail: describeIssues(parsed.error.issues) };
    }

    const status = parsed.data.status?.trim() ?? 'unknown';
    const db = parsed.data.db?.trim() ?? null;
    const version = parsed.data.litellm_version?.trim() ?? null;
    return {
      ...base,
      // A readiness route that answered at all is `ok`: it has no rows to be
      // empty of, and a proxy that is not ready answers 503, which `probeOnce`
      // has already classified as unreachable.
      status: 'ok',
      rows: null,
      detail: [
        status,
        db === null ? null : `db ${db}`,
        version === null ? null : `LiteLLM ${version}`,
      ]
        .filter((part) => part !== null)
        .join(' · '),
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
  private async getJson(
    url: URL,
    optional: boolean,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<unknown | null> {
    const response = await this.request(url, timeoutMs);
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
  private async request(url: URL, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(timeoutMs),
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
