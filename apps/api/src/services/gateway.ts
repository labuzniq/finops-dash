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
  GatewayDeployment,
  GatewayHealth,
  GatewayModelPrice,
  GatewayModels,
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
  gatewayDeploymentHealth,
  gatewayModel,
} from '../db/schema.js';
import type { GatewayBreakdownRow, GatewayBudgetRow, GatewayDailyRow } from '../db/schema.js';
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
/**
 * One stored governance row as the shared contract sees it, or null when the
 * scope is one this build does not know (a row written by a newer version).
 *
 * Exported because the notifier assesses the same rows the read route serves,
 * and a second copy of this mapping is a second chance for a null limit to
 * become `$0.00` in one of the two.
 */
export function toGatewayBudget(row: GatewayBudgetRow): GatewayBudget | null {
  const scope = GATEWAY_BUDGET_SCOPES.find((candidate) => candidate === row.scope);
  if (scope === undefined) return null;
  return {
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
  };
}

export async function getGatewayBudgets(): Promise<GatewayBudgets> {
  const rows = await db.select().from(gatewayBudget);

  const budgets: GatewayBudget[] = [];
  for (const row of rows) {
    const budget = toGatewayBudget(row);
    if (budget !== null) budgets.push(budget);
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
 * The proxy's configured price list, as of the last full sync.
 *
 * Current state like the budget snapshot, so no query parameters and no range —
 * and an empty list is a legitimate answer three ways over: the gateway has
 * never synced, the credential is not allowed to list models, or the proxy is
 * old enough not to offer `/model/info` at all.
 *
 * Ordered cheapest input first among the priced rows, with the unpriced ones
 * last: a price list is read to compare rates, and a model the proxy cannot
 * price has no place in that comparison — but it still has to be *visible*,
 * because it is the reason a coverage figure is short.
 */
export async function getGatewayModels(): Promise<GatewayModels> {
  const rows = await db.select().from(gatewayModel);

  const models: GatewayModelPrice[] = rows.map((row) => ({
    model: row.model,
    backend: row.backend,
    provider: row.provider,
    mode: row.mode,
    inputPerMillion:
      row.inputPerMillionNano === null ? null : nanoToDollars(row.inputPerMillionNano),
    outputPerMillion:
      row.outputPerMillionNano === null ? null : nanoToDollars(row.outputPerMillionNano),
    cacheReadPerMillion:
      row.cacheReadPerMillionNano === null ? null : nanoToDollars(row.cacheReadPerMillionNano),
    cacheWritePerMillion:
      row.cacheWritePerMillionNano === null ? null : nanoToDollars(row.cacheWritePerMillionNano),
    maxInputTokens: row.maxInputTokens,
    maxOutputTokens: row.maxOutputTokens,
    deployments: row.deployments,
    priceVaries: row.priceVaries,
  }));

  models.sort((a, b) => {
    // Compared, not subtracted: an unpriced row sorts below every priced one,
    // and `Infinity - Infinity` is NaN, which Array.sort reads as "equal" and
    // silently scatters the rows through the middle of the table.
    const left = a.inputPerMillion ?? Number.POSITIVE_INFINITY;
    const right = b.inputPerMillion ?? Number.POSITIVE_INFINITY;
    if (left !== right) return left < right ? -1 : 1;
    return a.model.localeCompare(b.model);
  });

  return { models };
}

/**
 * Every deployment as the last full sync found it.
 *
 * No query parameters, like the budget snapshot and the catalogue: this is
 * current state, not a range. `checkedAt` is lifted out of the rows because the
 * whole table is written in one transaction and therefore shares one reading —
 * and because it has to survive an empty table, where "the router offers no
 * deployments" and "`/health` has never answered" are different answers and only
 * the timestamp separates them.
 *
 * Ordered unhealthy-first and then by name, so the rows a reader is looking for
 * are the rows at the top. The alias-level up/degraded/down reading is
 * `summarizeDeploymentHealth` in `@dash/shared` and is deliberately not
 * pre-computed here: it is pure, the browser derives every other gateway card
 * the same way, and a server-side copy would be a second answer to the same
 * question.
 */
export async function getGatewayHealth(): Promise<GatewayHealth> {
  const rows = await db.select().from(gatewayDeploymentHealth);

  const deployments: GatewayDeployment[] = rows.map((row) => ({
    id: row.id,
    backend: row.backend,
    model: row.model,
    provider: row.provider,
    apiBase: row.apiBase,
    healthy: row.healthy,
    error: row.error,
    errorStatus: row.errorStatus,
    checkedAt: row.checkedAt.toISOString(),
  }));

  deployments.sort((a, b) => {
    if (a.healthy !== b.healthy) return a.healthy ? 1 : -1;
    return (
      (a.model ?? a.backend).localeCompare(b.model ?? b.backend) ||
      a.backend.localeCompare(b.backend)
    );
  });

  // The newest reading in the table. They are all written together, so this is
  // one value rather than a maximum in any interesting sense — but reading it
  // off the rows keeps it true if a future partial write ever changes that.
  const checkedAt = deployments.reduce<string | null>(
    (latest, row) => (latest === null || row.checkedAt > latest ? row.checkedAt : latest),
    null,
  );

  return { deployments, checkedAt };
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
