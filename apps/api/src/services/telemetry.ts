import { gte, max, sql } from 'drizzle-orm';
import type { TelemetryFreshness, TelemetryRollupRow } from '@dash/shared';
import { db } from '../db/client.js';
import { otlpMetricPoints } from '../db/schema.js';

/**
 * Telemetry rolled up to (day, user, model, metric, type) — the finest grain
 * the dashboard groups by. Values are stored delta-normalised, so SUM is the
 * whole aggregation story. The web app fetches one range and derives every
 * KPI, chart and filter client-side, like the Copilot page does.
 */
export async function telemetryRollup(days: number): Promise<TelemetryRollupRow[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const day = sql<string>`to_char(${otlpMetricPoints.time} at time zone 'utc', 'YYYY-MM-DD')`;

  return db
    .select({
      date: day,
      userId: otlpMetricPoints.userId,
      userEmail: otlpMetricPoints.userEmail,
      model: otlpMetricPoints.model,
      metric: otlpMetricPoints.metricName,
      type: otlpMetricPoints.type,
      value: sql<number>`sum(${otlpMetricPoints.value})`.mapWith(Number),
    })
    .from(otlpMetricPoints)
    .where(gte(otlpMetricPoints.time, since))
    .groupBy(
      day,
      otlpMetricPoints.userId,
      otlpMetricPoints.userEmail,
      otlpMetricPoints.model,
      otlpMetricPoints.metricName,
      otlpMetricPoints.type,
    )
    .orderBy(day);
}

/**
 * When the last datapoint arrived — the Data sources page derives the Claude
 * Code row's status from it, since telemetry is pushed and has no sync job to
 * read. `received_at`, not `time`: the question is when we last heard from an
 * exporter, not how old the reading it carried was. Null while nothing has
 * ever been ingested (unknown, not "just now").
 */
export async function telemetryFreshness(): Promise<TelemetryFreshness> {
  const [row] = await db
    .select({ latestAt: max(otlpMetricPoints.receivedAt) })
    .from(otlpMetricPoints);
  return { latestAt: row?.latestAt?.toISOString() ?? null };
}
