import {
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
  varchar,
} from 'drizzle-orm/pg-core';
import { PLANS, REFRESH_STATUSES } from '@dash/shared';

export const planEnum = pgEnum('plan', PLANS);
export const refreshStatusEnum = pgEnum('refresh_status', REFRESH_STATUSES);

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
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

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
 * Daily org spend. Money is stored in integer cents — Postgres `numeric`
 * round-trips as a string and floats drift; cents do neither.
 */
export const spendDaily = pgTable('spend_daily', {
  date: date('date').primaryKey(),
  licenseCents: integer('license_cents').notNull(),
  premiumOverageCents: integer('premium_overage_cents').notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One on-demand sync. Rows are the job queue, the audit log, and the UI's status source. */
export const refreshJobs = pgTable('refresh_jobs', {
  id: text('id').primaryKey(),
  status: refreshStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  seatsSynced: integer('seats_synced'),
  error: text('error'),
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
export type SpendRow = typeof spendDaily.$inferSelect;
export type SpendInsert = typeof spendDaily.$inferInsert;
export type OrgDailyRow = typeof orgDaily.$inferSelect;
export type OrgDailyInsert = typeof orgDaily.$inferInsert;
export type ModelDailyRow = typeof modelDaily.$inferSelect;
export type ModelDailyInsert = typeof modelDaily.$inferInsert;
export type RefreshJobRow = typeof refreshJobs.$inferSelect;
export type OtlpMetricPointInsert = typeof otlpMetricPoints.$inferInsert;
export type OtlpLogRecordInsert = typeof otlpLogRecords.$inferInsert;
