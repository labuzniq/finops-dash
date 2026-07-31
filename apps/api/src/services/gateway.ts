import { and, asc, eq, gte, lte } from 'drizzle-orm';
import {
  GATEWAY_BUDGET_SCOPES,
  GATEWAY_DIMENSIONS,
  classifyGatewayException,
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
  GatewayDeploymentHistory,
  GatewayDeploymentObservation,
  GatewayExceptions,
  GatewayHealth,
  GatewayLatency,
  GatewayLatencyHistory,
  GatewayLatencyObservation,
  GatewayModelPrice,
  GatewayModels,
  GatewayProbe,
  GatewayProbeRoute,
  GatewayExceptionHistory,
  GatewaySlowResponseHistory,
  GatewaySlowResponseObservation,
  GatewaySlowResponses,
  GatewaySpendLog,
  GatewaySpendLogs,
  GatewayUsage,
} from '@dash/shared';
import type { GatewaySpendLogRecord } from '../gateway/types.js';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { createGatewayClient } from '../gateway/index.js';
import {
  gatewayBreakdownDaily,
  gatewayBudget,
  gatewayBudgetHistory,
  gatewayDaily,
  gatewayDeploymentHealth,
  gatewayDeploymentHealthHistory,
  gatewayModel,
  gatewayExceptionDaily,
  gatewayExceptionSweep,
  gatewayLatencyDaily,
  gatewaySlowResponseDaily,
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
    // Ordered off the shared const rather than by name: with four scopes a
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
 * What `/health` reported on each of the last `days` days — the history
 * `getGatewayHealth` deliberately does not have.
 *
 * The same shape as the budget history above and the same rule: one row per
 * deployment per day the sync read `/health`, and nothing filled in for a day it
 * did not. A day with no row is a day nobody looked, which for health is a
 * stronger caveat than for a budget — a deployment can fail and recover between
 * two nightly readings and leave nothing at all behind. That is why every figure
 * `summarizeDeploymentHistory` derives is counted in readings.
 *
 * `recordingSince` is answered outside the window for the same reason it is
 * there: "this deployment has never failed in the last 30 days" and "we started
 * recording yesterday" are different answers and only one is a finding.
 */
export async function getGatewayDeploymentHistory(days: number): Promise<GatewayDeploymentHistory> {
  const to = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(`${to}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
  const from = fromDate.toISOString().slice(0, 10);

  const [rows, earliest] = await Promise.all([
    db
      .select()
      .from(gatewayDeploymentHealthHistory)
      .where(
        and(
          gte(gatewayDeploymentHealthHistory.date, from),
          lte(gatewayDeploymentHealthHistory.date, to),
        ),
      )
      .orderBy(asc(gatewayDeploymentHealthHistory.date), asc(gatewayDeploymentHealthHistory.id)),
    db
      .select({ date: gatewayDeploymentHealthHistory.date })
      .from(gatewayDeploymentHealthHistory)
      .orderBy(asc(gatewayDeploymentHealthHistory.date))
      .limit(1),
  ]);

  const observations: GatewayDeploymentObservation[] = rows.map((row) => ({
    id: row.id,
    backend: row.backend,
    model: row.model,
    provider: row.provider,
    date: row.date,
    observedAt: row.observedAt.toISOString(),
    healthy: row.healthy,
    error: row.error,
    errorStatus: row.errorStatus,
  }));

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

/**
 * Request-level logs for a bounded window, fetched live and stored nowhere.
 *
 * The one gateway read that is neither a table nor a snapshot. Every other
 * route here answers from what a sync wrote; this one asks the proxy while the
 * caller waits, because the rows it returns are the largest table LiteLLM has,
 * are pruned on a retention schedule of the proxy's own, and may be switched
 * off entirely. Storing them would mean owning a copy of a log this dashboard
 * has no business being the system of record for — and the aggregates the rest
 * of the page reads are already the ledger.
 *
 * What it is *for* is joins. The daily aggregates report each dimension
 * independently, so "which models did this team spend its money on" cannot be
 * asked of them at all; a log row carries every dimension at once, plus the
 * deployment that served it and how long it took.
 *
 * `available: false` is a result rather than a failure: a proxy run with
 * `disable_spend_logs` bills correctly and logs nothing.
 */
export async function getGatewaySpendLogs(
  from: string,
  to: string,
  limit: number,
): Promise<GatewaySpendLogs> {
  const fetchedAt = new Date().toISOString();
  const client = createGatewayClient();
  if (client === null) {
    throw new GatewayLogsUnavailableError(
      'GATEWAY_SOURCE is off — request logs come from the proxy directly and there is nothing to read.',
    );
  }

  const page = await client.fetchSpendLogs(from, to, limit);
  return {
    from,
    to,
    rows: page.rows.map(toSpendLog),
    available: page.available,
    truncated: page.truncated,
    fetchedAt,
  };
}

/**
 * How many aliases one exception sweep will ask about.
 *
 * The proxy's query filters on `model_group` and offers no wildcard, so a sweep
 * is one HTTP round trip per alias and the only bound available is how many are
 * worth asking about. Twelve covers a corporate gateway's real traffic several
 * times over; the aliases left out are reported rather than dropped, because a
 * capped per-model read that says nothing about the cap reads as a clean
 * gateway.
 */
export const EXCEPTION_MODEL_CAP = 12;

/**
 * Why the failed calls failed, per deployment, for a window — fetched live and
 * stored nowhere.
 *
 * The second read here that talks to the proxy while the caller waits, and for
 * a different reason than `/spend/logs`: this one is not too big to store, it
 * is too *thin* to be worth a table. `LiteLLM_ErrorLogs` is switchable
 * upstream, pruned on its own schedule, and carries no denominator — so the
 * value is entirely in reading it beside a failure count somebody is already
 * looking at, and a stored copy would only add a second thing to age.
 *
 * The aliases are chosen here rather than by the caller, and taken from the
 * window's own usage: `gateway_breakdown_daily`'s `model` dimension ranked by
 * spend. That keeps the sweep bounded, keeps it about traffic that exists, and
 * makes the skipped list a fact about the gateway rather than about a
 * hard-coded list.
 */
export async function getGatewayExceptions(from: string, to: string): Promise<GatewayExceptions> {
  const fetchedAt = new Date().toISOString();
  const client = createGatewayClient();
  if (client === null) {
    throw new GatewayLogsUnavailableError(
      'GATEWAY_SOURCE is off — exception logs come from the proxy directly and there is nothing to read.',
    );
  }

  const ranked = await rankModelsBySpend(from, to);
  const models = ranked.slice(0, EXCEPTION_MODEL_CAP);
  const skippedModels = ranked.slice(EXCEPTION_MODEL_CAP);

  const page = await client.fetchModelExceptions(from, to, models);

  return {
    from,
    to,
    models,
    skippedModels,
    deployments: page.rows.map((row) => ({
      deployment: row.deployment,
      model: row.model,
      exceptions: row.exceptions.map((entry) => ({
        type: entry.type,
        class: classifyGatewayException(entry.type),
        count: entry.count,
      })),
      // Our sum, never the proxy's `total_exceptions` — that field counts
      // distinct classes upstream, and is carried alongside so the disagreement
      // stays visible rather than being silently corrected.
      total: row.exceptions.reduce((sum, entry) => sum + entry.count, 0),
      reportedTotal: row.reportedTotal,
    })),
    available: page.available,
    fetchedAt,
  };
}

/**
 * How many aliases one latency sweep will ask about.
 *
 * The same number as the exception sweep and for the same reason — the proxy's
 * query filters on `model_group` with no wildcard, so the only bound available
 * is how many aliases are worth a round trip. Named separately because the two
 * routes are separately capped: one reads the error table and the other scans
 * the request log, so the day one of them has to be narrowed is not the day
 * both do.
 */
export const LATENCY_MODEL_CAP = 12;

/**
 * How slowly each deployment answered over a window — fetched live and stored
 * nowhere.
 *
 * The third read here that talks to the proxy while the caller waits, and the
 * complement of the exception sweep: that one reads the error table and says
 * why the failed calls failed, this one aggregates the request log and says how
 * the successful ones performed. Both are keyed below the alias, which is the
 * resolution at which a reserved pool that is refusing and slow can be told
 * apart from the sibling covering for it.
 *
 * It is not stored for the same reason `/spend/logs` is not: the numbers are
 * the proxy's own aggregation over a table it prunes on its own schedule, and a
 * copy here would be a second thing to age. The aliases are chosen the same way
 * too — from the window's own `model` usage ranked by spend, capped, with the
 * ones left out reported rather than dropped.
 */
export async function getGatewayLatency(from: string, to: string): Promise<GatewayLatency> {
  const fetchedAt = new Date().toISOString();
  const client = createGatewayClient();
  if (client === null) {
    throw new GatewayLogsUnavailableError(
      'GATEWAY_SOURCE is off — latency is aggregated by the proxy and there is nothing to read.',
    );
  }

  const ranked = await rankModelsBySpend(from, to);
  const models = ranked.slice(0, LATENCY_MODEL_CAP);
  const skippedModels = ranked.slice(LATENCY_MODEL_CAP);

  const page = await client.fetchModelLatency(from, to, models);

  // One series per (alias, key) pair. The pair is the identity because the row
  // itself carries only the key: LiteLLM reports a deployment under its
  // api_base, and two aliases served from one Azure endpoint are one key with
  // two different readings.
  const series = new Map<string, { model: string; key: string; points: { date: string; secondsPerToken: number }[] }>();
  for (const row of page.rows) {
    const id = `${row.model}\u0000${row.key}`;
    const existing = series.get(id);
    if (existing === undefined) {
      series.set(id, {
        model: row.model,
        key: row.key,
        points: [{ date: row.date, secondsPerToken: row.secondsPerToken }],
      });
    } else {
      existing.points.push({ date: row.date, secondsPerToken: row.secondsPerToken });
    }
  }

  return {
    from,
    to,
    models,
    skippedModels,
    series: [...series.values()],
    apiBases: page.apiBases,
    available: page.available,
    fetchedAt,
  };
}

/**
 * How many aliases one slow-response sweep will ask about.
 *
 * The third separately-named cap over the same number, and named separately for
 * the same reason as the other two: the routes are capped independently because
 * they cost different things. This one scans the request log like the latency
 * sweep, but does strictly less with each row — no per-day grouping — so if any
 * of the three is widened first it is this one.
 */
export const SLOW_RESPONSE_MODEL_CAP = 12;

/**
 * How many calls hung, per endpoint, over a window — fetched live and stored
 * nowhere.
 *
 * The fourth read here that talks to the proxy while the caller waits, and the
 * one that closes the loop the other three leave open. `failed_requests` counts
 * the calls that failed; `/model/metrics/exceptions` says why they failed;
 * `/model/metrics` says how many seconds per completion token the rest averaged.
 * None of them can see a call that answered correctly after four minutes — a
 * long answer at an ordinary per-token rate is exactly that, and it is the
 * request a user is actually waiting on.
 *
 * Two things are the route's rather than this function's, and both leave here
 * unrepaired. The threshold that decides what "slow" means is the proxy's own
 * `alerting_threshold` and is not in the response, so nothing downstream may
 * attach a number of seconds to the count. And the grouping key is the
 * `api_base` alone, so every deployment without a URL is one bucket — reported
 * under `UNKEYED_DEPLOYMENT` rather than as a blank row.
 *
 * Aliases are chosen the same way the other two sweeps choose them: the window's
 * own `model` usage ranked by spend, capped, with the ones left out reported.
 */
export async function getGatewaySlowResponses(
  from: string,
  to: string,
): Promise<GatewaySlowResponses> {
  const fetchedAt = new Date().toISOString();
  const client = createGatewayClient();
  if (client === null) {
    throw new GatewayLogsUnavailableError(
      'GATEWAY_SOURCE is off — hanging requests are counted by the proxy and there is nothing to read.',
    );
  }

  const ranked = await rankModelsBySpend(from, to);
  const models = ranked.slice(0, SLOW_RESPONSE_MODEL_CAP);
  const skippedModels = ranked.slice(SLOW_RESPONSE_MODEL_CAP);

  const page = await client.fetchModelSlowResponses(from, to, models);

  return {
    from,
    to,
    models,
    skippedModels,
    rows: page.rows.map((row) => ({
      model: row.model,
      key: row.key,
      total: row.total,
      slow: row.slow,
    })),
    available: page.available,
    fetchedAt,
  };
}

/**
 * What the nightly sweep counted on each of the last `days` days.
 *
 * The stored twin of the live read above, and the only one of the four live
 * reads that has one. The live route answers "how many hung in the window on
 * screen"; a hang that has been happening since Tuesday and one that started
 * this morning are the same number there, and only the first is a fault
 * somebody owns.
 *
 * Same shape and the same rule as the two other history routes: one row per
 * deployment key per alias per day the sync swept, and nothing filled in for a
 * day it did not. The rows are ours rather than the proxy's, so the window cap
 * is a payload argument rather than a retention one — keys × aliases × days, and
 * a large router is a few hundred rows a night.
 *
 * `recordingSince` is answered outside the window for the third time and for the
 * third identical reason: an empty list means "nothing hung" or "we started
 * recording on Tuesday", and the two are different answers.
 */
export async function getGatewaySlowResponseHistory(
  days: number,
): Promise<GatewaySlowResponseHistory> {
  // Ends yesterday, unlike the two other history routes, and for a reason that
  // is about what is *stored* rather than about the clock: the sweep covers the
  // day usage has settled for, so today can never carry a reading. Ending the
  // window today would report a gap on the newest night on every visit forever.
  const toDate = new Date();
  toDate.setUTCDate(toDate.getUTCDate() - 1);
  const to = toDate.toISOString().slice(0, 10);
  const fromDate = new Date(`${to}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
  const from = fromDate.toISOString().slice(0, 10);

  const [rows, earliest] = await Promise.all([
    db
      .select()
      .from(gatewaySlowResponseDaily)
      .where(
        and(gte(gatewaySlowResponseDaily.date, from), lte(gatewaySlowResponseDaily.date, to)),
      )
      .orderBy(
        asc(gatewaySlowResponseDaily.date),
        asc(gatewaySlowResponseDaily.deploymentKey),
        asc(gatewaySlowResponseDaily.model),
      ),
    db
      .select({ date: gatewaySlowResponseDaily.date })
      .from(gatewaySlowResponseDaily)
      .orderBy(asc(gatewaySlowResponseDaily.date))
      .limit(1),
  ]);

  const observations: GatewaySlowResponseObservation[] = rows.map((row) => ({
    date: row.date,
    model: row.model,
    key: row.deploymentKey,
    total: row.totalCount,
    slow: row.slowCount,
    observedAt: row.observedAt.toISOString(),
  }));

  return { from, to, recordingSince: earliest[0]?.date ?? null, observations };
}

/**
 * What the nightly exception sweep recorded on each of the last `days` days.
 *
 * The stored twin of `getGatewayExceptions`, and the second of the four live
 * reads to have one. The licence is the hang table's — these are counts of
 * disjoint error-log rows, so they add across a sweep and across nights — and the
 * limit is this route's own: there is no denominator anywhere in it, so what the
 * stored rows answer is what has been breaking and whether the *mix* moved, never
 * a rate.
 *
 * Two tables rather than one, and the second is the point: the sweep is filed
 * separately from what it found, because this route answers rows only where
 * something failed. A night with a receipt and no rows is a clean gateway; a night
 * with neither is one nobody read, and merging them would let a refused sweep
 * report a quiet week.
 */
export async function getGatewayExceptionHistory(days: number): Promise<GatewayExceptionHistory> {
  // Ends yesterday, like the hang history and for the same reason: the sweep
  // covers the day usage has settled for, so today can never carry a reading and
  // a window ending on it would report a gap on the newest night forever.
  const toDate = new Date();
  toDate.setUTCDate(toDate.getUTCDate() - 1);
  const to = toDate.toISOString().slice(0, 10);
  const fromDate = new Date(`${to}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
  const from = fromDate.toISOString().slice(0, 10);

  const [rows, sweeps, earliest] = await Promise.all([
    db
      .select()
      .from(gatewayExceptionDaily)
      .where(and(gte(gatewayExceptionDaily.date, from), lte(gatewayExceptionDaily.date, to)))
      .orderBy(
        asc(gatewayExceptionDaily.date),
        asc(gatewayExceptionDaily.deployment),
        asc(gatewayExceptionDaily.exceptionType),
      ),
    db
      .select()
      .from(gatewayExceptionSweep)
      .where(and(gte(gatewayExceptionSweep.date, from), lte(gatewayExceptionSweep.date, to)))
      .orderBy(asc(gatewayExceptionSweep.date)),
    // `recordingSince` comes from the *receipts* rather than the rows: the first
    // night we looked is the honest start of the recording, and it may well be a
    // night on which nothing failed.
    db
      .select({ date: gatewayExceptionSweep.date })
      .from(gatewayExceptionSweep)
      .orderBy(asc(gatewayExceptionSweep.date))
      .limit(1),
  ]);

  return {
    from,
    to,
    recordingSince: earliest[0]?.date ?? null,
    observations: rows.map((row) => ({
      date: row.date,
      model: row.model,
      deployment: row.deployment,
      type: row.exceptionType,
      count: row.count,
      observedAt: row.observedAt.toISOString(),
    })),
    sweeps: sweeps.map((row) => ({
      date: row.date,
      models: row.models,
      deployments: row.deployments,
      exceptions: row.exceptions,
      observedAt: row.observedAt.toISOString(),
    })),
  };
}

/**
 * What the nightly latency sweep read on each of the last `days` nights.
 *
 * The stored twin of `getGatewayLatency`, and the third of the four live reads
 * to have one — on a licence that is neither of the other two's. The hang and
 * exception histories are stored because their counts add; these readings do
 * not add, and cannot be made to, because the proxy averaged the request counts
 * away before answering. What makes them worth keeping is the same thing that
 * makes `gateway_deployment_health_history` worth keeping beside a snapshot that
 * is equally un-aggregatable: a live route answers one window and has no memory,
 * so "has this endpoint been reading slow all week" is a question only a stored
 * sequence can be asked.
 *
 * Every window figure the summariser takes off these rows is therefore a
 * *median* of nightly readings, never a total or a weighted mean, and nothing is
 * filled in for a night the sweep did not run.
 *
 * `recordingSince` is answered outside the window for the fourth time and the
 * fourth identical reason: an empty list means "nothing was slow" or "we started
 * recording on Tuesday", and only one of those is a finding.
 */
export async function getGatewayLatencyHistory(days: number): Promise<GatewayLatencyHistory> {
  // Ends yesterday, like the hang and exception histories and unlike the two
  // governance ones: the sweep covers the day usage has settled for, so today
  // can never carry a reading and a window ending on it would report a gap on
  // the newest night forever.
  const toDate = new Date();
  toDate.setUTCDate(toDate.getUTCDate() - 1);
  const to = toDate.toISOString().slice(0, 10);
  const fromDate = new Date(`${to}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
  const from = fromDate.toISOString().slice(0, 10);

  const [rows, earliest] = await Promise.all([
    db
      .select()
      .from(gatewayLatencyDaily)
      .where(and(gte(gatewayLatencyDaily.date, from), lte(gatewayLatencyDaily.date, to)))
      .orderBy(
        asc(gatewayLatencyDaily.date),
        asc(gatewayLatencyDaily.model),
        asc(gatewayLatencyDaily.deploymentKey),
      ),
    db
      .select({ date: gatewayLatencyDaily.date })
      .from(gatewayLatencyDaily)
      .orderBy(asc(gatewayLatencyDaily.date))
      .limit(1),
  ]);

  const observations: GatewayLatencyObservation[] = rows.map((row) => ({
    date: row.date,
    model: row.model,
    key: row.deploymentKey,
    // The one place the stored rate leaves its exact integer form, exactly as
    // `nanoToDollars` is the one place money does.
    secondsPerToken: Number(row.secondsPerTokenNano) / 1e9,
    observedAt: row.observedAt.toISOString(),
  }));

  return { from, to, recordingSince: earliest[0]?.date ?? null, observations };
}

/**
 * The window's model aliases, ranked by what they spent.
 *
 * Both per-model sweeps (`/model/metrics/exceptions` and `/model/metrics`) need
 * the same list for the same reason: the proxy has no wildcard, so somebody has
 * to decide which aliases are worth a round trip, and taking them from the
 * window's own usage keeps the decision about traffic that exists rather than
 * about a hard-coded list.
 */
async function rankModelsBySpend(from: string, to: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(gatewayBreakdownDaily)
    .where(
      and(
        eq(gatewayBreakdownDaily.dimension, 'model'),
        gte(gatewayBreakdownDaily.date, from),
        lte(gatewayBreakdownDaily.date, to),
      ),
    );

  const spendByModel = new Map<string, bigint>();
  for (const row of rows) {
    spendByModel.set(row.key, (spendByModel.get(row.key) ?? 0n) + row.spendNano);
  }
  return [...spendByModel.entries()]
    .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] > a[1] ? 1 : -1))
    .map(([key]) => key);
}

/** The one place a log row's money becomes dollars. */
function toSpendLog(row: GatewaySpendLogRecord): GatewaySpendLog {
  const { spendNano, ...rest } = row;
  return { ...rest, spend: nanoToDollars(spendNano) };
}

/** Raised when the gateway integration is off — the route maps it to 503. */
export class GatewayLogsUnavailableError extends Error {}

/** `https://litellm.corp:4000/v1` → `litellm.corp:4000`, and never a password. */
function hostOf(baseUrl: string | undefined): string | null {
  if (baseUrl === undefined) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}
