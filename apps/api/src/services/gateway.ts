import { and, asc, gte, lte } from 'drizzle-orm';
import { GATEWAY_DIMENSIONS } from '@dash/shared';
import type { GatewayBreakdownPoint, GatewayDailyPoint, GatewayUsage } from '@dash/shared';
import { db } from '../db/client.js';
import { gatewayBreakdownDaily, gatewayDaily } from '../db/schema.js';
import type { GatewayBreakdownRow, GatewayDailyRow } from '../db/schema.js';
import { nanoToDollars } from '../lib/nano.js';

/**
 * The gateway read model: everything `GET /api/gateway` returns for an
 * inclusive date range, in one payload. Fetch-once like the rest of the app —
 * every KPI, chart and drill-down table is derived client-side from this.
 *
 * Money leaves its exact bigint nano representation here, via `nanoToDollars`,
 * and nowhere else.
 */

function toDailyPoint(row: GatewayDailyRow): GatewayDailyPoint {
  return {
    date: row.date,
    spend: nanoToDollars(row.spendNano),
    requests: row.requests,
    successfulRequests: row.successfulRequests,
    failedRequests: row.failedRequests,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheCreationTokens,
  };
}

export async function getGatewayUsage(from: string, to: string): Promise<GatewayUsage> {
  const [days, breakdownRows] = await Promise.all([
    db
      .select()
      .from(gatewayDaily)
      .where(and(gte(gatewayDaily.date, from), lte(gatewayDaily.date, to)))
      .orderBy(asc(gatewayDaily.date)),
    db
      .select()
      .from(gatewayBreakdownDaily)
      .where(and(gte(gatewayBreakdownDaily.date, from), lte(gatewayBreakdownDaily.date, to)))
      .orderBy(
        asc(gatewayBreakdownDaily.date),
        asc(gatewayBreakdownDaily.dimension),
        asc(gatewayBreakdownDaily.key),
      ),
  ]);

  const breakdowns: GatewayBreakdownPoint[] = [];
  for (const row of breakdownRows as GatewayBreakdownRow[]) {
    // The sync only ever writes known dimensions, so an unknown value cannot
    // exist; the narrow keeps the varchar column honest against the union.
    const dimension = GATEWAY_DIMENSIONS.find((candidate) => candidate === row.dimension);
    if (dimension === undefined) continue;
    breakdowns.push({
      date: row.date,
      dimension,
      key: row.key,
      label: row.label,
      spend: nanoToDollars(row.spendNano),
      requests: row.requests,
      successfulRequests: row.successfulRequests,
      failedRequests: row.failedRequests,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.totalTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheCreationTokens: row.cacheCreationTokens,
    });
  }

  return { daily: days.map(toDailyPoint), breakdowns };
}
