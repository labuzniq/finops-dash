import { gte, sql } from 'drizzle-orm';
import type { TelemetryRollupRow } from '@dash/shared';
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
