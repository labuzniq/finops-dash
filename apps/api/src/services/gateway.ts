import { and, asc, gte, lte } from 'drizzle-orm';
import { GATEWAY_BUDGET_SCOPES, GATEWAY_DIMENSIONS } from '@dash/shared';
import type {
  GatewayBreakdownPoint,
  GatewayBudget,
  GatewayBudgets,
  GatewayDailyPoint,
  GatewayUsage,
} from '@dash/shared';
import { db } from '../db/client.js';
import { gatewayBreakdownDaily, gatewayBudget, gatewayDaily } from '../db/schema.js';
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

/**
 * Current budgets and rate limits, key rows first and then teams, each ranked
 * by how much of its cap it has consumed — the uncapped rows sort last, since
 * "no budget" is not a small budget.
 *
 * Null limits survive the read unchanged. `nanoToDollars` is applied only to
 * the columns that hold a number, so an uncapped key stays `null` rather than
 * becoming `$0.00`, which would read as the strictest budget on the gateway.
 */
export async function getGatewayBudgets(): Promise<GatewayBudgets> {
  const rows = await db.select().from(gatewayBudget);

  const budgets: GatewayBudget[] = [];
  for (const row of rows) {
    const scope = GATEWAY_BUDGET_SCOPES.find((candidate) => candidate === row.scope);
    if (scope === undefined) continue;
    budgets.push({
      scope,
      key: row.key,
      label: row.label,
      spend: nanoToDollars(row.spendNano),
      maxBudget: row.maxBudgetNano === null ? null : nanoToDollars(row.maxBudgetNano),
      softBudget: row.softBudgetNano === null ? null : nanoToDollars(row.softBudgetNano),
      budgetDuration: row.budgetDuration,
      resetAt: row.resetAt === null ? null : row.resetAt.toISOString(),
      tpmLimit: row.tpmLimit,
      rpmLimit: row.rpmLimit,
      blocked: row.blocked,
    });
  }

  const consumed = (budget: GatewayBudget): number =>
    budget.maxBudget === null || budget.maxBudget <= 0 ? -1 : budget.spend / budget.maxBudget;

  budgets.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'api_key' ? -1 : 1;
    const difference = consumed(b) - consumed(a);
    if (difference !== 0) return difference;
    return (a.label ?? a.key).localeCompare(b.label ?? b.key);
  });

  return { budgets };
}
