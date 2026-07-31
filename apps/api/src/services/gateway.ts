import { and, asc, gte, lte } from 'drizzle-orm';
import { GATEWAY_BUDGET_SCOPES, GATEWAY_DIMENSIONS, summarizeGatewayProbe } from '@dash/shared';
import type {
  GatewayBreakdownPoint,
  GatewayBudget,
  GatewayBudgets,
  GatewayDailyPoint,
  GatewayProbe,
  GatewayProbeRoute,
  GatewayUsage,
} from '@dash/shared';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { createGatewayClient } from '../gateway/index.js';
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

/**
 * A live connection check against the configured proxy — the one gateway read
 * that touches no table.
 *
 * Everything else here answers "what did the last sync store"; this answers
 * "can this credential sync at all, and what will be missing if it does". The
 * whole integration is a draft written against LiteLLM's published contract, so
 * the day a real proxy and a real key exist, the first question is whether the
 * key is scoped to the whole gateway or to one team — and the second is whether
 * the management routes an analytics key is routinely refused are refused here.
 * Both are answerable in one round trip and neither is worth discovering by
 * starting a 90-day sync and reading the job's error string.
 *
 * Never throws: a probe of a dead proxy is a successful probe with a dead
 * proxy in it.
 */
export async function probeGateway(): Promise<GatewayProbe> {
  const checkedAt = new Date().toISOString();
  const client = createGatewayClient();

  if (client === null) {
    return {
      source: env.GATEWAY_SOURCE,
      configured: false,
      target: null,
      checkedAt,
      probedDay: null,
      routes: [],
      usable: false,
      warnings: ['GATEWAY_SOURCE is off — set it to `mock` or `litellm` and restart the API.'],
    };
  }

  // The same day the sync's window ends on. Today is still accumulating and a
  // proxy reporting nothing for it would read as an outage.
  const probedDay = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  // The base URL is shown host-only and the API key never appears at all: this
  // response goes to a browser, and a LiteLLM base URL with credentials in it
  // is a perfectly ordinary thing to be handed.
  const target = client.name === 'litellm' ? hostOf(env.LITELLM_BASE_URL) : 'in-process generator';

  let routes: GatewayProbeRoute[];
  try {
    routes = await client.probe(probedDay);
  } catch (error) {
    // The client is written not to throw here, so this is a bug rather than a
    // proxy fault — reported as one instead of as a 500 with no context.
    return {
      source: env.GATEWAY_SOURCE,
      configured: true,
      target,
      checkedAt,
      probedDay,
      routes: [],
      usable: false,
      warnings: [`The probe itself failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const { usable, warnings } = summarizeGatewayProbe(routes);
  return {
    source: env.GATEWAY_SOURCE,
    configured: true,
    target,
    checkedAt,
    probedDay,
    routes,
    usable,
    warnings,
  };
}

/** `https://litellm.corp:4000/v1` → `litellm.corp:4000`, and never a password. */
function hostOf(baseUrl: string | undefined): string | null {
  if (baseUrl === undefined) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}
