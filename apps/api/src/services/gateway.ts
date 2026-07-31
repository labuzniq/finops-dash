import { and, asc, gte, lte } from 'drizzle-orm';
import {
  GATEWAY_BUDGET_SCOPES,
  GATEWAY_DIMENSIONS,
  summarizeGatewayCoverage,
  summarizeGatewayProbe,
} from '@dash/shared';
import type {
  GatewayBreakdownPoint,
  GatewayBudget,
  GatewayBudgetHistory,
  GatewayBudgetObservation,
  GatewayBudgets,
  GatewayCoverage,
  GatewayDailyPoint,
  GatewayProbe,
  GatewayProbeRoute,
  GatewayUsage,
} from '@dash/shared';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { createGatewayClient } from '../gateway/index.js';
import {
  gatewayBreakdownDaily,
  gatewayBudget,
  gatewayBudgetHistory,
  gatewayDaily,
} from '../db/schema.js';
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
 * What `gateway_daily` actually holds — the one gateway read that answers a
 * question about the *table* rather than about the gateway.
 *
 * The sync deletes only the dates it re-fetched, so the table is not a rolling
 * 90-day window: it accumulates every day the scheduler ever pulled, and a
 * dashboard that has been running six months holds three months the proxy has
 * already pruned. Without this route the UI has no way to know that, and it
 * clamps every picker to `today − 89` — refusing to show data it is sitting on.
 *
 * The same read answers the opposite question, which only becomes askable once
 * the clamp is lifted: a stretch when nobody synced is a hole no future sync
 * will fill, and every derivation on the page zero-fills interior days on the
 * assumption that a zero is a quiet day. The gaps have to be named, because
 * from inside a usage payload they are indistinguishable from an idle week.
 *
 * Only the date column is read. The table has one row per day keyed on it, so
 * this is an index-order scan of a few hundred rows however long the gateway
 * has been running.
 */
export async function getGatewayCoverage(): Promise<GatewayCoverage> {
  const rows = await db
    .select({ date: gatewayDaily.date })
    .from(gatewayDaily)
    .orderBy(asc(gatewayDaily.date));

  const today = new Date().toISOString().slice(0, 10);
  return summarizeGatewayCoverage(
    rows.map((row) => row.date),
    today,
  );
}

/**
 * Current budgets and rate limits, grouped in `GATEWAY_BUDGET_SCOPES` order and
 * each scope ranked by how much of its cap it has consumed — the uncapped rows
 * sort last, since "no budget" is not a small budget.
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
    // Ordered off the shared const rather than by name: with three scopes a
    // two-way `a.scope === 'api_key' ? -1 : 1` is not even a consistent
    // comparator, since it answers "after" for both team-vs-tag and tag-vs-team.
    if (a.scope !== b.scope) {
      return GATEWAY_BUDGET_SCOPES.indexOf(a.scope) - GATEWAY_BUDGET_SCOPES.indexOf(b.scope);
    }
    const difference = consumed(b) - consumed(a);
    if (difference !== 0) return difference;
    return (a.label ?? a.key).localeCompare(b.label ?? b.key);
  });

  return { budgets };
}

/**
 * What the budgets looked like on each of the last `days` days — the history
 * `getGatewayBudgets` deliberately does not have.
 *
 * One row per governed object per UTC day the sync ran, and nothing is filled
 * in for a day it did not: a missing day is a day nobody observed, which is a
 * different fact from "unchanged" and must reach the browser as a hole. The
 * derivation on the other end is what turns consecutive observations into
 * resets, cap changes and breaches.
 *
 * `recordingSince` is answered outside the window on purpose. Without it, "this
 * key was never over its cap in the last 30 days" is indistinguishable from
 * "recording started yesterday", and the first is a finding while the second is
 * an absence of one.
 */
export async function getGatewayBudgetHistory(days: number): Promise<GatewayBudgetHistory> {
  const to = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(`${to}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
  const from = fromDate.toISOString().slice(0, 10);

  const [rows, earliest] = await Promise.all([
    db
      .select()
      .from(gatewayBudgetHistory)
      .where(and(gte(gatewayBudgetHistory.date, from), lte(gatewayBudgetHistory.date, to)))
      .orderBy(
        asc(gatewayBudgetHistory.date),
        asc(gatewayBudgetHistory.scope),
        asc(gatewayBudgetHistory.key),
      ),
    db
      .select({ date: gatewayBudgetHistory.date })
      .from(gatewayBudgetHistory)
      .orderBy(asc(gatewayBudgetHistory.date))
      .limit(1),
  ]);

  const observations: GatewayBudgetObservation[] = [];
  for (const row of rows) {
    const scope = GATEWAY_BUDGET_SCOPES.find((candidate) => candidate === row.scope);
    if (scope === undefined) continue;
    observations.push({
      scope,
      key: row.key,
      label: row.label,
      date: row.date,
      observedAt: row.observedAt.toISOString(),
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

  return { from, to, recordingSince: earliest[0]?.date ?? null, observations };
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
