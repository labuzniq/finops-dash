import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  IMPORT_LOG_STATUSES,
  IMPORT_SLOTS,
  PLANS,
  REFRESH_KINDS,
  REFRESH_STATUSES,
} from '@dash/shared';
import type { GatewayNotificationHealthDetail } from '@dash/shared';

export const planEnum = pgEnum('plan', PLANS);
export const refreshStatusEnum = pgEnum('refresh_status', REFRESH_STATUSES);
export const refreshKindEnum = pgEnum('refresh_kind', REFRESH_KINDS);
export const importSlotEnum = pgEnum('import_slot', IMPORT_SLOTS);
export const importLogStatusEnum = pgEnum('import_log_status', IMPORT_LOG_STATUSES);

/**
 * Current seat state, keyed by login. A refresh replaces this wholesale —
 * it is a snapshot of the org, not a history.
 *
 * `last_activity_at` is stored as the timestamp GitHub reports; the
 * "days ago" the UI shows is derived at read time so it never goes stale.
 */
export const copilotSeats = pgTable('copilot_seats', {
  login: varchar('login', { length: 100 }).primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  plan: planEnum('plan').notNull(),
  editor: varchar('editor', { length: 50 }),
  language: varchar('language', { length: 50 }),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
  premiumRequests28d: integer('premium_requests_28d'),
  acceptanceRate: smallint('acceptance_rate'),
  usedAgent: boolean('used_agent'),
  usedChat: boolean('used_chat'),
  topModel: varchar('top_model', { length: 60 }),
  team: varchar('team', { length: 120 }),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-day org aggregate from the `organization-1-day` report, upserted by date.
 * Backfilled up to 90 days; the trend chart and range selector slice this.
 */
export const orgDaily = pgTable('org_daily', {
  date: date('date').primaryKey(),
  dailyActiveUsers: integer('daily_active_users').notNull(),
  weeklyActiveUsers: integer('weekly_active_users').notNull(),
  monthlyActiveUsers: integer('monthly_active_users').notNull(),
  interactions: integer('interactions').notNull(),
  generations: integer('generations').notNull(),
  acceptances: integer('acceptances').notNull(),
  locAdded: integer('loc_added').notNull(),
  locDeleted: integer('loc_deleted').notNull(),
  // Suggested LOC and engaged-cohort counts from the same daily report row.
  // Defaults keep rows synced before this migration readable as zeros.
  locSuggestedAdd: integer('loc_suggested_add').notNull().default(0),
  locSuggestedDelete: integer('loc_suggested_delete').notNull().default(0),
  chatMau: integer('chat_mau').notNull().default(0),
  agentMau: integer('agent_mau').notNull().default(0),
  codeReviewDau: integer('code_review_dau').notNull().default(0),
  codeReviewWau: integer('code_review_wau').notNull().default(0),
  codeReviewMau: integer('code_review_mau').notNull().default(0),
  codeReviewPassiveMau: integer('code_review_passive_mau').notNull().default(0),
  cloudAgentDau: integer('cloud_agent_dau').notNull().default(0),
  cloudAgentWau: integer('cloud_agent_wau').notNull().default(0),
  cloudAgentMau: integer('cloud_agent_mau').notNull().default(0),
  prCreated: integer('pr_created').notNull().default(0),
  prMerged: integer('pr_merged').notNull().default(0),
  prCreatedByCopilot: integer('pr_created_by_copilot').notNull().default(0),
  prMergedCreatedByCopilot: integer('pr_merged_created_by_copilot').notNull().default(0),
  prReviewedByCopilot: integer('pr_reviewed_by_copilot').notNull().default(0),
  prCopilotSuggestions: integer('pr_copilot_suggestions').notNull().default(0),
  prCopilotAppliedSuggestions: integer('pr_copilot_applied_suggestions').notNull().default(0),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-day, per-category activity for one breakdown dimension of the daily org
 * report (`totals_by_ide`, `totals_by_feature`, and the language/model sides
 * of the composite arrays). One generic table instead of one per dimension —
 * the shape is identical and the UI treats every dimension the same way.
 */
export const usageBreakdownDaily = pgTable(
  'usage_breakdown_daily',
  {
    date: date('date').notNull(),
    /** `ide` | `language` | `feature` | `model` — see USAGE_DIMENSIONS in @dash/shared. */
    dimension: varchar('dimension', { length: 20 }).notNull(),
    key: varchar('key', { length: 80 }).notNull(),
    interactions: integer('interactions').notNull(),
    generations: integer('generations').notNull(),
    acceptances: integer('acceptances').notNull(),
    locAdded: integer('loc_added').notNull(),
    locDeleted: integer('loc_deleted').notNull(),
    locSuggestedAdd: integer('loc_suggested_add').notNull(),
    locSuggestedDelete: integer('loc_suggested_delete').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.date, table.dimension, table.key] })],
);

/** Per-day AI-adoption-phase cohort from `totals_by_ai_adoption_phase`. */
export const adoptionPhaseDaily = pgTable(
  'adoption_phase_daily',
  {
    date: date('date').notNull(),
    phaseNumber: smallint('phase_number').notNull(),
    phase: varchar('phase', { length: 40 }).notNull(),
    engagedUsers: integer('engaged_users').notNull(),
    avgInteractions: doublePrecision('avg_interactions').notNull(),
    avgGenerations: doublePrecision('avg_generations').notNull(),
    avgAcceptances: doublePrecision('avg_acceptances').notNull(),
    avgLocAdded: doublePrecision('avg_loc_added').notNull(),
    avgLocDeleted: doublePrecision('avg_loc_deleted').notNull(),
    avgPrCreated: doublePrecision('avg_pr_created').notNull(),
    avgPrReviewed: doublePrecision('avg_pr_reviewed').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.date, table.phaseNumber] })],
);

/**
 * Per-day, per-user activity — what lets the usage charts follow the seat
 * filters. The mock source fills the full history; live GitHub only covers the
 * users report's trailing 28-day window, so older days simply have no rows.
 * Days with no activity for a login have no row (zero, not unknown — the org
 * reports cover every day, so absence here means "did nothing that day").
 */
export const userDaily = pgTable(
  'user_daily',
  {
    date: date('date').notNull(),
    login: varchar('login', { length: 100 }).notNull(),
    interactions: integer('interactions').notNull(),
    generations: integer('generations').notNull(),
    acceptances: integer('acceptances').notNull(),
    locAdded: integer('loc_added').notNull(),
    locDeleted: integer('loc_deleted').notNull(),
    locSuggestedAdd: integer('loc_suggested_add').notNull(),
    locSuggestedDelete: integer('loc_suggested_delete').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.date, table.login] })],
);

/**
 * Per-day, per-model activity from a daily report's `totals_by_language_model`,
 * summed across languages. Keyed by (date, model). Feeds the per-model view.
 */
export const modelDaily = pgTable(
  'model_daily',
  {
    date: date('date').notNull(),
    model: varchar('model', { length: 60 }).notNull(),
    generations: integer('generations').notNull(),
    acceptances: integer('acceptances').notNull(),
    locAdded: integer('loc_added').notNull(),
    locDeleted: integer('loc_deleted').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.date, table.model] })],
);

/**
 * Report 2 (billing usage report) rows — the sole money authority, licences
 * included. Money is bigint nano-dollars (1e-9 USD): CSV amounts carry up to
 * 9 decimals, so integer cents cannot hold them; nano-dollars keep sums exact.
 * Conversion to dollars happens once, at the API response edge (nanoToDollars).
 */
export const billingDaily = pgTable(
  'billing_daily',
  {
    date: date('date').notNull(),
    login: varchar('login', { length: 100 }).notNull(),
    /**
     * Validated at import against BILLING_SKUS — kept varchar, not a pg enum,
     * so an unknown sku in a future CSV fails loudly at import time instead of
     * requiring a migration to even name it.
     */
    sku: varchar('sku', { length: 40 }).notNull(),
    /** Credits or user-months × 1e9. */
    quantityNano: bigint('quantity_nano', { mode: 'bigint' }).notNull(),
    /** USD × 1e9. */
    grossNano: bigint('gross_nano', { mode: 'bigint' }).notNull(),
    discountNano: bigint('discount_nano', { mode: 'bigint' }).notNull(),
    netNano: bigint('net_nano', { mode: 'bigint' }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.date, table.login, table.sku] })],
);

/**
 * Report 1 rows — per-day, per-login, per-model AI-credit statistics.
 * Never summed into money totals: it overlaps Report 2's AI-credit money by
 * construction, and only billing_daily feeds the money KPIs.
 */
export const modelSpendDaily = pgTable(
  'model_spend_daily',
  {
    date: date('date').notNull(),
    login: varchar('login', { length: 100 }).notNull(),
    model: varchar('model', { length: 80 }).notNull(),
    /** AI-credit quantity × 1e9. */
    creditsNano: bigint('credits_nano', { mode: 'bigint' }).notNull(),
    grossNano: bigint('gross_nano', { mode: 'bigint' }).notNull(),
    discountNano: bigint('discount_nano', { mode: 'bigint' }).notNull(),
    netNano: bigint('net_nano', { mode: 'bigint' }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.date, table.login, table.model] })],
);

/**
 * GitHub org user export — the identity bridge from login to SAML name id.
 * No FKs to billing or jira tables: imports arrive in any order and the
 * login → saml → person join happens in code at read time.
 */
export const githubUsers = pgTable('github_users', {
  login: varchar('login', { length: 100 }).primaryKey(),
  /** May be blank in the export — stored as null, renders unmapped. */
  samlNameId: varchar('saml_name_id', { length: 40 }),
  /**
   * Sticky activity flag: set the first time the login appears in a billing
   * report import and never cleared. Rows are never deleted — the user filter
   * shows active logins only, while the full org roster (and every synced
   * JIRA person) stays in the database.
   */
  active: boolean('active').notNull().default(false),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

/** JIRA Insight batch sync — one row per person, keyed by SAML name id. */
export const jiraPeople = pgTable('jira_people', {
  /** Stored uppercase; matched case-insensitively against github_users. */
  samlNameId: varchar('saml_name_id', { length: 40 }).primaryKey(),
  firstName: varchar('first_name', { length: 100 }),
  lastName: varchar('last_name', { length: 100 }),
  department: varchar('department', { length: 200 }),
  /** `referencedObject.label` verbatim. */
  b1Manager: varchar('b1_manager', { length: 200 }),
  b2Manager: varchar('b2_manager', { length: 200 }),
  jiraUserId: varchar('jira_user_id', { length: 40 }),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-day gateway-wide totals from the LiteLLM proxy — one row per calendar
 * day, replaced wholesale for every day a sync fetches.
 *
 * Money is bigint nano-dollars (1e-9 USD) like `billing_daily`: LiteLLM
 * reports per-request spend down to ~1e-8 USD, so cents cannot hold it and
 * float sums drift. Token counters are bigint too — a corporate gateway
 * clears int32's 2.1B ceiling in a single busy day.
 */
export const gatewayDaily = pgTable('gateway_daily', {
  date: date('date').primaryKey(),
  /** USD × 1e9. */
  spendNano: bigint('spend_nano', { mode: 'bigint' }).notNull(),
  requests: integer('requests').notNull(),
  successfulRequests: integer('successful_requests').notNull(),
  failedRequests: integer('failed_requests').notNull(),
  promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull(),
  completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull(),
  totalTokens: bigint('total_tokens', { mode: 'number' }).notNull(),
  cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull(),
  cacheCreationTokens: bigint('cache_creation_tokens', { mode: 'number' }).notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-day, per-key gateway usage for one breakdown dimension — the same
 * one-generic-table shape as `usage_breakdown_daily`, for the same reason: the
 * axes (model, provider, api_key, mcp_server, user, team, tag) carry identical
 * metrics and the UI treats them identically.
 *
 * `key` is the raw id the proxy reports (hashed key tokens and user ids can be
 * long, hence 200); `label` is the alias it resolved, null when it did not.
 * Dimensions overlap by construction — never sum across them.
 */
export const gatewayBreakdownDaily = pgTable(
  'gateway_breakdown_daily',
  {
    date: date('date').notNull(),
    /** See GATEWAY_DIMENSIONS in @dash/shared. */
    dimension: varchar('dimension', { length: 20 }).notNull(),
    key: varchar('key', { length: 200 }).notNull(),
    label: varchar('label', { length: 200 }),
    spendNano: bigint('spend_nano', { mode: 'bigint' }).notNull(),
    requests: integer('requests').notNull(),
    successfulRequests: integer('successful_requests').notNull(),
    failedRequests: integer('failed_requests').notNull(),
    promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull(),
    completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull(),
    totalTokens: bigint('total_tokens', { mode: 'number' }).notNull(),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull(),
    cacheCreationTokens: bigint('cache_creation_tokens', { mode: 'number' }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.date, table.dimension, table.key] }),
    // The range read filters on date and then groups by dimension; the primary
    // key already leads with date, so this only serves the dimension-first
    // lookups the drill-down issues.
    index('gateway_breakdown_dimension_idx').on(table.dimension, table.date),
  ],
);

/**
 * Current budgets and rate limits per governed object on the LiteLLM proxy —
 * one row per (scope, key), replaced wholesale on every gateway sync.
 *
 * The only gateway table with no date column, because it is not a time series:
 * a budget is configuration plus the proxy's own counter for the period in
 * flight, and the proxy is the system of record for both. `spend_nano` is
 * deliberately *not* re-derivable from `gateway_daily` — a key's period resets
 * on its own schedule, and only the enforced counter says how close to the cap
 * the proxy thinks it is.
 *
 * Every limit column is nullable and none of them default to zero: NULL means
 * "no such limit" while 0 means "budgeted at nothing, reject everything". This
 * is the one place in the gateway schema where absence is unknown-shaped
 * rather than zero-shaped.
 */
export const gatewayBudget = pgTable(
  'gateway_budget',
  {
    /** See GATEWAY_BUDGET_SCOPES in @dash/shared — `api_key`, `team`, `tag` or `user`. */
    scope: varchar('scope', { length: 20 }).notNull(),
    /** The proxy's id: hashed key token, team id, tag name or user id — joins the usage dimension of the same name. */
    key: varchar('key', { length: 200 }).notNull(),
    label: varchar('label', { length: 200 }),
    /** USD × 1e9, for the budget period in flight. */
    spendNano: bigint('spend_nano', { mode: 'bigint' }).notNull(),
    maxBudgetNano: bigint('max_budget_nano', { mode: 'bigint' }),
    softBudgetNano: bigint('soft_budget_nano', { mode: 'bigint' }),
    /** LiteLLM duration string — `30d`, `1mo`, `24h`. */
    budgetDuration: varchar('budget_duration', { length: 20 }),
    resetAt: timestamp('reset_at', { withTimezone: true }),
    tpmLimit: bigint('tpm_limit', { mode: 'number' }),
    rpmLimit: bigint('rpm_limit', { mode: 'number' }),
    blocked: boolean('blocked').notNull().default(false),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key] })],
);

/**
 * What `gateway_budget` said, kept — one row per governed object per UTC day.
 *
 * The snapshot table above is replaced wholesale by every sync, which makes it
 * exactly the wrong shape for the three questions an owner actually asks about
 * a budget: when did this cross, what did the last period come to, and who
 * moved the cap. None of the three can be re-derived from `gateway_daily`,
 * because the proxy's enforced counter runs on the key's own period.
 *
 * Keyed on the *day*, not on the sync: the last observation of a day wins, so
 * the table grows with the gateway and the calendar and is indifferent to how
 * often the scheduler runs. `observed_at` keeps the instant that reading was
 * taken, which is what says how stale the day's value is.
 *
 * Written only by a full sync. A ranged backfill does not fetch budgets at all
 * (governance is a snapshot of the proxy, not of a date range), so it appends
 * nothing here either — a repair of six days in May cannot invent a governance
 * observation for May.
 *
 * Null still means "no such limit", exactly as in the snapshot: a row whose
 * `max_budget_nano` is NULL was uncapped that day, and one whose value is 0 was
 * rejecting every call.
 */
export const gatewayBudgetHistory = pgTable(
  'gateway_budget_history',
  {
    scope: varchar('scope', { length: 20 }).notNull(),
    key: varchar('key', { length: 200 }).notNull(),
    /** UTC day the observation belongs to. */
    date: date('date').notNull(),
    /** The alias as it read that day — a rename is itself a recorded change. */
    label: varchar('label', { length: 200 }),
    spendNano: bigint('spend_nano', { mode: 'bigint' }).notNull(),
    maxBudgetNano: bigint('max_budget_nano', { mode: 'bigint' }),
    softBudgetNano: bigint('soft_budget_nano', { mode: 'bigint' }),
    budgetDuration: varchar('budget_duration', { length: 20 }),
    resetAt: timestamp('reset_at', { withTimezone: true }),
    tpmLimit: bigint('tpm_limit', { mode: 'number' }),
    rpmLimit: bigint('rpm_limit', { mode: 'number' }),
    blocked: boolean('blocked').notNull().default(false),
    /** When the reading this row kept was taken. */
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.key, table.date] }),
    // The read is always a window over every object, so date leads.
    index('gateway_budget_history_date_idx').on(table.date),
  ],
);

/**
 * One governance finding per *episode* — what was found, and whether it left
 * the building.
 *
 * Every other gateway finding on the dashboard is derived in the browser from
 * the usage payload and exists only while somebody is looking at the page.
 * Governance is the exception: it is a table, so the API can assess it after
 * every full sync and hand what it finds to something outside the dashboard.
 * This is the de-duplication story that makes a nightly evaluation something
 * other than a nightly mailing.
 *
 * Keyed on the finding's fingerprint (`kind:scope:key`) and on nothing
 * numeric, which is the whole design: a key still over the same cap tomorrow is
 * the *same* finding and only moves `last_seen_at`, while one crossing from
 * `soft` to `over` changes kind and is a new row. `cleared_at` closes an
 * episode; the next time the same finding appears it starts a new one and
 * delivers again, which is why the row is reset rather than deleted — the
 * previous episode's dates are what say "this key has been over its cap three
 * times this quarter".
 *
 * `delivered_at` is the retry policy in one column. Null means the alert has not
 * been accepted by a delivery target, whether because the attempt failed or
 * because none is configured, and the next sync tries again. There is no queue,
 * because the sync is already a schedule.
 *
 * Money is nano-dollars like every other table here, and `max_budget_nano`
 * keeps the snapshot's null-vs-zero rule: null is uncapped, 0 rejects everything.
 */
export const gatewayNotification = pgTable(
  'gateway_notification',
  {
    /** `kind:scope:key` — the identity of the episode, carrying no numbers. */
    fingerprint: varchar('fingerprint', { length: 260 }).primaryKey(),
    /** See GATEWAY_ALERT_KINDS in @dash/shared. */
    kind: varchar('kind', { length: 40 }).notNull(),
    severity: varchar('severity', { length: 20 }).notNull(),
    /**
     * Which table the finding was assessed from — `budget` or `health`.
     *
     * Recorded rather than inferred from the kind, because it is what scopes the
     * close pass: a source that could not be assessed this run must leave its
     * open episodes alone, and "no findings" and "nothing to read" are opposite
     * facts. Defaulted so every row written before deployment findings existed
     * reads as the governance finding it was.
     */
    source: varchar('source', { length: 20 }).notNull().default('budget'),
    /** A budget scope, or `model` — the one scope a deployment finding has. */
    scope: varchar('scope', { length: 20 }).notNull(),
    key: varchar('key', { length: 200 }).notNull(),
    label: varchar('label', { length: 200 }),
    /** The governed object's, or the alias's, state at the most recent evaluation. */
    state: varchar('state', { length: 20 }).notNull(),
    /** Null on a deployment finding: there is no counter behind one. */
    spendNano: bigint('spend_nano', { mode: 'bigint' }),
    maxBudgetNano: bigint('max_budget_nano', { mode: 'bigint' }),
    /**
     * The reading behind a deployment finding — how many of how many, on which
     * backends, with the proxy's own error texts. Null on a governance finding.
     *
     * Stored rather than rendered at evaluation time for the same reason the
     * budget numbers are: the sentence is re-derived from the numbers, so the
     * mail and the panel cannot say different things about one episode.
     */
    detail: jsonb('detail').$type<GatewayNotificationHealthDetail>(),
    /** When this episode began — not when the object was first seen. */
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** The last evaluation at which the finding was still true. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** When it stopped being true. Null while open. */
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    /** When a delivery target accepted it. Null while pending — the retry flag. */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    deliveryError: text('delivery_error'),
  },
  (table) => [
    // The panel reads open findings newest-first; the sync reads the pending
    // ones. Both start from "is this cleared".
    index('gateway_notification_cleared_idx').on(table.clearedAt, table.lastSeenAt),
  ],
);

/**
 * The proxy's configured price list — one row per routable public model name.
 *
 * The third kind of gateway fact and the second snapshot table: `gateway_daily`
 * is what the gateway *did*, `gateway_budget` is what it will *refuse*, and this
 * is what it is set up to *charge*. Replaced wholesale by every full sync, for
 * the same reason budgets are — a model withdrawn from the router has no price
 * any more, and a stale row would price traffic that can no longer happen.
 *
 * Money is nano-dollars per **million** tokens, not per token: LiteLLM quotes
 * `2.5e-06` per token, and at nine fractional digits a per-token scale rounds a
 * $0.05/M model down to three significant figures.
 *
 * Every price is nullable and none is ever zero-filled. Two genuinely different
 * things produce an absent price — a model billed per second, and one LiteLLM's
 * cost map cannot resolve at all — and both are "we cannot price this", which is
 * the opposite of an explicit `0` (a free model the proxy skips budget checks
 * for). Same rule as `gateway_budget`, one layer up.
 */
export const gatewayModel = pgTable('gateway_model', {
  /** The public alias callers pass — also the `model` usage dimension's key. */
  model: varchar('model', { length: 200 }).primaryKey(),
  /** `litellm_params.model`: the provider-prefixed deployment behind the alias. */
  backend: varchar('backend', { length: 200 }),
  provider: varchar('provider', { length: 60 }),
  /** `chat`, `embedding`, `rerank`, … */
  mode: varchar('mode', { length: 40 }),
  /** USD × 1e9 per 1,000,000 tokens. */
  inputPerMillionNano: bigint('input_per_million_nano', { mode: 'bigint' }),
  outputPerMillionNano: bigint('output_per_million_nano', { mode: 'bigint' }),
  cacheReadPerMillionNano: bigint('cache_read_per_million_nano', { mode: 'bigint' }),
  cacheWritePerMillionNano: bigint('cache_write_per_million_nano', { mode: 'bigint' }),
  maxInputTokens: bigint('max_input_tokens', { mode: 'number' }),
  maxOutputTokens: bigint('max_output_tokens', { mode: 'number' }),
  /** How many router deployments answer to this alias. */
  deployments: integer('deployments').notNull().default(1),
  /**
   * Those deployments do not all charge the same, so the stored price is the
   * cheapest of them — a floor. The daily aggregates carry no deployment id, so
   * splitting the row is not possible; flagging it is.
   */
  priceVaries: boolean('price_varies').notNull().default(false),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One deployment as `GET /health` last reported it — the only gateway table
 * keyed below the model alias.
 *
 * Every other table here is keyed by something a caller can name. This one is
 * keyed by the individual Azure/Bedrock endpoint the router chose, which is a
 * resolution the usage aggregates simply do not have: LiteLLM fails over
 * silently between the deployments of one alias, so an alias with a dead region
 * bills normally, fails nothing, and shows up nowhere except here.
 *
 * Current state like `gateway_budget` and `gateway_model`, replaced wholesale by
 * a full sync and untouched by a ranged one. `model` is a *resolved* column
 * rather than a fetched one — `/health` reports routing strings and never public
 * aliases, so the sync joins it against the catalogue it fetched in the same
 * run, and a null means no catalogue row claimed the deployment.
 */
export const gatewayDeploymentHealth = pgTable('gateway_deployment_health', {
  /** LiteLLM's `model_info.id`, or the routing string when it reported none. */
  id: varchar('id', { length: 200 }).primaryKey(),
  /** `litellm_params.model` — the deployment this row is about. */
  backend: varchar('backend', { length: 200 }).notNull(),
  /** The public alias it serves, resolved through `gateway_model`. */
  model: varchar('model', { length: 200 }),
  provider: varchar('provider', { length: 60 }),
  /** Null on Bedrock (addressed by region) and on a details-stripped proxy alike. */
  apiBase: varchar('api_base', { length: 300 }),
  healthy: boolean('healthy').notNull(),
  /** The proxy's own error text. Null on a healthy row and on a stripped one. */
  error: text('error'),
  /** `exception_status` — the upstream status, where the failure carried one. */
  errorStatus: integer('error_status'),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * What `gateway_deployment_health` said, kept — one row per deployment per UTC
 * day, appended by every full sync.
 *
 * Same shape and the same argument as `gateway_budget_history`: the snapshot
 * above is replaced wholesale, so it can say a pool is refusing now and can
 * never say it has been refusing all week. That distinction is the whole
 * difference between a blip and a standing fault, and it is the only thing that
 * turns the nightly reading into evidence.
 *
 * It is a weaker sample than the budget one and the derivation
 * (`summarizeDeploymentHistory` in @dash/shared) is written knowing it: a
 * deployment can fail and recover between two readings and leave no trace,
 * where a budget counter cannot un-spend itself. Hence readings are counted and
 * never converted to hours, and a day with no row is unknown rather than
 * healthy.
 *
 * Keyed on the *day*, so a second sync the same afternoon updates the day's row
 * rather than adding one — the table grows with the gateway and the calendar,
 * not with the scheduler's frequency. Written only when `/health` actually
 * answered: a ranged backfill does not call it at all, and a swallowed failure
 * leaves the day unrecorded rather than filing a reading nobody took.
 *
 * `model` is the alias as resolved *that day*, which is why it is stored rather
 * than joined at read time — a deployment moved to another alias is a change
 * worth seeing, and re-resolving history against today's catalogue would erase it.
 */
export const gatewayDeploymentHealthHistory = pgTable(
  'gateway_deployment_health_history',
  {
    id: varchar('id', { length: 200 }).notNull(),
    /** UTC day the observation belongs to. */
    date: date('date').notNull(),
    backend: varchar('backend', { length: 200 }).notNull(),
    model: varchar('model', { length: 200 }),
    provider: varchar('provider', { length: 60 }),
    healthy: boolean('healthy').notNull(),
    error: text('error'),
    errorStatus: integer('error_status'),
    /** When the reading this row kept was taken. */
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.date] }),
    // The read is always a window over every deployment, so date leads.
    index('gateway_deployment_health_history_date_idx').on(table.date),
  ],
);

/**
 * A closed calendar month, held still — one row per sealed month.
 *
 * `gateway_daily` is a live table: a sync rewrites every day it re-fetches, a
 * backfill repairs a gap, and LiteLLM revises late-landing usage. That is what
 * an analysis wants and the opposite of what a bill wants. This row records the
 * month's totals at the instant it was sealed, so a statement issued in July
 * can still be reproduced in December and match to the cent — and so the two
 * can be *compared*, which is how "June's bill has moved" becomes answerable.
 *
 * Written once per month by the sync, and only for a month that has ended with
 * every one of its days stored (`resolveMonthSeal` in @dash/shared). Re-sealing
 * is a deliberate, explicit act, never a side effect of another sync.
 */
export const gatewayMonth = pgTable(
  'gateway_month',
  {
    /** `YYYY-MM`. */
    month: varchar('month', { length: 7 }).notNull(),
    /**
     * Which statement of that month this row is — `1` for the first seal, one
     * more for each re-seal. A re-seal inserts rather than replaces: the
     * statement that was issued is evidence, and overwriting it would leave a
     * corrected bill with nothing to be corrected *from*.
     */
    revision: integer('revision').notNull().default(1),
    /** Set when a later revision replaced this one; null on the current statement. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    monthStart: date('month_start').notNull(),
    monthEnd: date('month_end').notNull(),
    /** Days sealed — the month's calendar length, since a short month cannot be sealed. */
    days: integer('days').notNull(),
    sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull().defaultNow(),
    /** See GATEWAY_SEAL_ORIGINS in @dash/shared — `scheduler` or `manual`. */
    sealedBy: varchar('sealed_by', { length: 20 }).notNull(),
    /** USD × 1e9. */
    spendNano: bigint('spend_nano', { mode: 'bigint' }).notNull(),
    requests: bigint('requests', { mode: 'number' }).notNull(),
    successfulRequests: bigint('successful_requests', { mode: 'number' }).notNull(),
    failedRequests: bigint('failed_requests', { mode: 'number' }).notNull(),
    promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull(),
    completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull(),
    totalTokens: bigint('total_tokens', { mode: 'number' }).notNull(),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull(),
    cacheCreationTokens: bigint('cache_creation_tokens', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.month, table.revision] }),
    // At most one *current* statement per month, enforced here rather than by a
    // read-then-write: a re-seal that failed to supersede its predecessor would
    // otherwise leave two statements both claiming to be the bill.
    uniqueIndex('gateway_month_current_idx')
      .on(table.month)
      .where(sql`${table.supersededAt} is null`),
  ],
);

/**
 * One payer's line on a sealed month — the statement itself, not a re-slice of
 * the daily breakdowns.
 *
 * Only the payer-shaped dimensions are recorded (`team`, `tag`, `api_key`,
 * `user` — GATEWAY_PAYER_DIMENSIONS in @dash/shared): a seal exists to make a
 * *bill* reproducible, and `model`/`provider` charge nobody while `mcp_server`
 * is a subset rather than a slice. The four are stored side by side and are
 * never summed together — the same overlap rule the daily breakdowns carry.
 */
export const gatewayMonthLine = pgTable(
  'gateway_month_line',
  {
    month: varchar('month', { length: 7 }).notNull(),
    /** The revision of `gateway_month` these lines belong to. */
    revision: integer('revision').notNull().default(1),
    dimension: varchar('dimension', { length: 20 }).notNull(),
    key: varchar('key', { length: 200 }).notNull(),
    label: varchar('label', { length: 200 }),
    spendNano: bigint('spend_nano', { mode: 'bigint' }).notNull(),
    requests: bigint('requests', { mode: 'number' }).notNull(),
    successfulRequests: bigint('successful_requests', { mode: 'number' }).notNull(),
    failedRequests: bigint('failed_requests', { mode: 'number' }).notNull(),
    promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull(),
    completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull(),
    totalTokens: bigint('total_tokens', { mode: 'number' }).notNull(),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull(),
    cacheCreationTokens: bigint('cache_creation_tokens', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.month, table.revision, table.dimension, table.key] })],
);

/** One on-demand sync. Rows are the job queue, the audit log, and the UI's status source. */
export const refreshJobs = pgTable(
  'refresh_jobs',
  {
    id: text('id').primaryKey(),
    kind: refreshKindEnum('kind').notNull().default('copilot'),
    status: refreshStatusEnum('status').notNull().default('pending'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    seatsSynced: integer('seats_synced'),
    error: text('error'),
  },
  // Single-flight is enforced here, not by a check-then-insert race: at most one
  // job per kind may sit in an active status at a time — a Copilot refresh and
  // a JIRA sync may run concurrently, but never two of the same kind. A
  // concurrent insert loses on this partial unique index instead of starting a
  // second, colliding sync.
  (table) => [
    uniqueIndex('refresh_jobs_single_flight_idx')
      .on(table.kind)
      .where(sql`${table.status} in ('pending', 'running')`),
  ],
);

/**
 * One CSV upload run, one row per slot — the Imports page's history list.
 * Append-only like `refresh_jobs`, and written whether the import landed or was
 * rejected: a failed upload is exactly what the history has to explain.
 * `row_count` is what the run upserted, so it stays 0 on a failure.
 */
export const importLogs = pgTable('import_logs', {
  id: text('id').primaryKey(),
  slot: importSlotEnum('slot').notNull(),
  filename: varchar('filename', { length: 255 }).notNull(),
  rowCount: integer('row_count').notNull().default(0),
  status: importLogStatusEnum('status').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Raw OTLP metric datapoints from Claude Code (and any other OTLP client).
 * Append-only. Cumulative sums are normalised to deltas at ingest — see
 * otlp/ingest.ts — so every query is a plain SUM over `value`.
 *
 * Groupable dimensions (user, session, model, type) are lifted into columns;
 * everything else the exporter sent survives in `attributes`. `series_key`
 * identifies one OTLP series (metric + attributes + start time) and is what
 * the delta normalisation keys on.
 */
export const otlpMetricPoints = pgTable(
  'otlp_metric_points',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    metricName: varchar('metric_name', { length: 200 }).notNull(),
    seriesKey: varchar('series_key', { length: 64 }).notNull(),
    value: doublePrecision('value').notNull(),
    /**
     * The exporter's raw cumulative reading, kept so the next ingest can
     * compute its delta against it. Null for delta and gauge points, where
     * `value` is already the raw reading.
     */
    rawValue: doublePrecision('raw_value'),
    time: timestamp('time', { withTimezone: true }).notNull(),
    startTime: timestamp('start_time', { withTimezone: true }),
    userId: varchar('user_id', { length: 120 }),
    userEmail: varchar('user_email', { length: 200 }),
    sessionId: varchar('session_id', { length: 120 }),
    organizationId: varchar('organization_id', { length: 120 }),
    model: varchar('model', { length: 100 }),
    type: varchar('type', { length: 60 }),
    serviceName: varchar('service_name', { length: 120 }),
    attributes: jsonb('attributes')
      .$type<Record<string, string | number | boolean>>()
      .notNull()
      .default({}),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('otlp_metric_points_time_idx').on(table.time, table.metricName),
    index('otlp_metric_points_series_idx').on(table.seriesKey, table.time),
    index('otlp_metric_points_user_idx').on(table.userEmail),
    // The Data sources page polls max(received_at) every minute; without a
    // leading-column index that is a seq scan of an append-only table.
    index('otlp_metric_points_received_idx').on(table.receivedAt),
  ],
);

/**
 * OTLP log records — Claude Code events (`claude_code.api_request`, …).
 * Stored for auditing/drill-down; the dashboard reads metrics only today.
 */
export const otlpLogRecords = pgTable(
  'otlp_log_records',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    time: timestamp('time', { withTimezone: true }).notNull(),
    eventName: varchar('event_name', { length: 200 }),
    severity: varchar('severity', { length: 30 }),
    body: text('body'),
    userId: varchar('user_id', { length: 120 }),
    userEmail: varchar('user_email', { length: 200 }),
    sessionId: varchar('session_id', { length: 120 }),
    serviceName: varchar('service_name', { length: 120 }),
    attributes: jsonb('attributes')
      .$type<Record<string, string | number | boolean>>()
      .notNull()
      .default({}),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('otlp_log_records_time_idx').on(table.time)],
);

export type SeatRow = typeof copilotSeats.$inferSelect;
export type SeatInsert = typeof copilotSeats.$inferInsert;
export type BillingDailyRow = typeof billingDaily.$inferSelect;
export type BillingDailyInsert = typeof billingDaily.$inferInsert;
export type ModelSpendDailyRow = typeof modelSpendDaily.$inferSelect;
export type ModelSpendDailyInsert = typeof modelSpendDaily.$inferInsert;
export type GithubUserRow = typeof githubUsers.$inferSelect;
export type GithubUserInsert = typeof githubUsers.$inferInsert;
export type JiraPersonRow = typeof jiraPeople.$inferSelect;
export type JiraPersonInsert = typeof jiraPeople.$inferInsert;
export type OrgDailyRow = typeof orgDaily.$inferSelect;
export type OrgDailyInsert = typeof orgDaily.$inferInsert;
export type ModelDailyRow = typeof modelDaily.$inferSelect;
export type ModelDailyInsert = typeof modelDaily.$inferInsert;
export type UserDailyRow = typeof userDaily.$inferSelect;
export type UserDailyInsert = typeof userDaily.$inferInsert;
export type UsageBreakdownRow = typeof usageBreakdownDaily.$inferSelect;
export type UsageBreakdownInsert = typeof usageBreakdownDaily.$inferInsert;
export type AdoptionPhaseRow = typeof adoptionPhaseDaily.$inferSelect;
export type AdoptionPhaseInsert = typeof adoptionPhaseDaily.$inferInsert;
export type GatewayDailyRow = typeof gatewayDaily.$inferSelect;
export type GatewayDailyInsert = typeof gatewayDaily.$inferInsert;
export type GatewayBreakdownRow = typeof gatewayBreakdownDaily.$inferSelect;
export type GatewayBreakdownInsert = typeof gatewayBreakdownDaily.$inferInsert;
export type GatewayBudgetRow = typeof gatewayBudget.$inferSelect;
export type GatewayBudgetInsert = typeof gatewayBudget.$inferInsert;
export type GatewayBudgetHistoryRow = typeof gatewayBudgetHistory.$inferSelect;
export type GatewayBudgetHistoryInsert = typeof gatewayBudgetHistory.$inferInsert;
export type GatewayNotificationRow = typeof gatewayNotification.$inferSelect;
export type GatewayNotificationInsert = typeof gatewayNotification.$inferInsert;
export type GatewayModelRow = typeof gatewayModel.$inferSelect;
export type GatewayModelInsert = typeof gatewayModel.$inferInsert;
export type GatewayDeploymentHealthRow = typeof gatewayDeploymentHealth.$inferSelect;
export type GatewayDeploymentHealthInsert = typeof gatewayDeploymentHealth.$inferInsert;
export type GatewayDeploymentHealthHistoryRow = typeof gatewayDeploymentHealthHistory.$inferSelect;
export type GatewayDeploymentHealthHistoryInsert =
  typeof gatewayDeploymentHealthHistory.$inferInsert;
export type GatewayMonthRow = typeof gatewayMonth.$inferSelect;
export type GatewayMonthInsert = typeof gatewayMonth.$inferInsert;
export type GatewayMonthLineRow = typeof gatewayMonthLine.$inferSelect;
export type GatewayMonthLineInsert = typeof gatewayMonthLine.$inferInsert;
export type RefreshJobRow = typeof refreshJobs.$inferSelect;
export type ImportLogRow = typeof importLogs.$inferSelect;
export type ImportLogInsert = typeof importLogs.$inferInsert;
export type OtlpMetricPointInsert = typeof otlpMetricPoints.$inferInsert;
export type OtlpLogRecordInsert = typeof otlpLogRecords.$inferInsert;
