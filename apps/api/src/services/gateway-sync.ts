import { inArray, sql } from 'drizzle-orm';
import { resolveDeploymentModel } from '@dash/shared';
import type { RefreshJob } from '@dash/shared';
import { SLOW_RESPONSE_MODEL_CAP } from './gateway.js';
import { db } from '../db/client.js';
import {
  gatewayBreakdownDaily,
  gatewayBudget,
  gatewayBudgetHistory,
  gatewayDaily,
  gatewayDeploymentHealth,
  gatewayDeploymentHealthHistory,
  gatewayModel,
  gatewaySlowResponseDaily,
} from '../db/schema.js';
import type {
  GatewayBreakdownInsert,
  GatewayBudgetHistoryInsert,
  GatewayBudgetInsert,
  GatewayDailyInsert,
  GatewayDeploymentHealthHistoryInsert,
  GatewayDeploymentHealthInsert,
  GatewayModelInsert,
  GatewaySlowResponseDailyInsert,
} from '../db/schema.js';
import { createGatewayClient } from '../gateway/index.js';
import type {
  GatewayBudgetSnapshot,
  GatewayHealthSnapshot,
  GatewayModelSnapshot,
  GatewaySlowResponseRecord,
  GatewaySnapshot,
} from '../gateway/index.js';
import { moduleLogger } from '../log.js';
import { sealClosedMonths } from './gateway-seal.js';
import { notifyGatewayFindings } from './gateway-notify.js';
import { startJob } from './refresh.js';

const log = moduleLogger('services.gateway-sync');

/**
 * LLM-gateway sync (refresh_jobs kind `gateway`) — pulls the LiteLLM proxy's
 * pre-aggregated daily usage into `gateway_daily` and
 * `gateway_breakdown_daily`.
 *
 * Unlike the enterprise billing sync, this is a full re-pull of the whole
 * window on every run rather than a trailing top-up: the proxy answers a
 * 90-day range in a handful of paginated requests (it reads its own daily
 * aggregate tables, not the raw spend logs), and a re-pull is the only way
 * late-landing rows and retroactive price corrections ever reach us. The
 * window doubles as the history bootstrap — there is no CSV import path here.
 */

/** How much history a sync pulls — the widest range the dashboard offers. */
const WINDOW_DAYS = 90;

/** Rows per insert; 14 columns each, comfortably under the 65,535-parameter cap. */
const CHUNK_SIZE = 2_000;

/** GATEWAY_SOURCE is `off` — the route answers 503 and the scheduler skips. */
export class GatewaySyncUnavailableError extends Error {
  constructor() {
    super('LLM gateway sync is not configured — set GATEWAY_SOURCE (mock or litellm)');
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** UTC day `offset` days from now, as YYYY-MM-DD. */
function utcDay(offset: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/** `2026-07-31`, `-1` → `2026-07-30`. UTC, so DST never shifts a date. */
function shiftIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A ranged sync asked for something the proxy cannot answer. */
export class GatewaySyncRangeError extends Error {}

/** The inclusive UTC window a sync run covers. */
export interface GatewaySyncWindow {
  from: string;
  to: string;
}

/**
 * What a caller may ask for: either bound, both, or neither. Written out rather
 * than `Partial<GatewaySyncWindow>` because `exactOptionalPropertyTypes` makes
 * the two different types, and a query parser hands over explicit `undefined`.
 */
export interface GatewaySyncRequest {
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * The window a sync will actually pull, from what the caller asked for.
 *
 * The default — no bounds at all — is the nightly run: `WINDOW_DAYS` ending
 * yesterday. Today is deliberately excluded, because it is still accruing and
 * the proxy's aggregate for it would be revised the moment we stored it.
 *
 * A ranged request exists for one job: repairing the gaps
 * `GET /api/gateway/coverage` reports, without re-pulling a quarter to do it.
 * Each bound defaults independently, and both are *clamped* rather than
 * rejected — a caller asking for more than the proxy holds gets what the proxy
 * holds, which is the same answer the default sync would give. The two genuine
 * errors are a window that is inverted (a typo, not a clamp) and one that lies
 * entirely outside the proxy's retention: those days are pruned upstream, so a
 * sync would succeed while filling nothing, and reporting that as a success is
 * worse than refusing it.
 */
export function resolveGatewaySyncWindow(
  requested: GatewaySyncRequest | undefined,
  today: string,
): GatewaySyncWindow {
  const latest = shiftIso(today, -1);
  const earliest = shiftIso(today, -WINDOW_DAYS);

  const from = requested?.from ?? earliest;
  const to = requested?.to ?? latest;

  if (from > to) {
    throw new GatewaySyncRangeError(`from (${from}) must not be after to (${to})`);
  }
  if (to < earliest) {
    throw new GatewaySyncRangeError(
      `${from} – ${to} is older than the proxy's ${WINDOW_DAYS}-day window (it keeps nothing before ${earliest}), so a sync cannot fill it`,
    );
  }
  if (from > latest) {
    throw new GatewaySyncRangeError(
      `${from} – ${to} is not settled yet — a sync covers days up to ${latest}`,
    );
  }

  return {
    from: from < earliest ? earliest : from,
    to: to > latest ? latest : to,
  };
}

/**
 * Replace every fetched day in one transaction. Delete-then-insert, not
 * upsert, for the same reason the Copilot breakdowns use it: a re-pulled day's
 * key set can shrink (a model retired, a key rotated) and an upsert would
 * leave the vanished keys standing and double-counting. The delete is scoped
 * to the dates the client says it covered — days outside the window keep their
 * rows, so shrinking WINDOW_DAYS never destroys history.
 *
 * `budgets` is `null` for a ranged sync: governance is a snapshot of the whole
 * proxy, not of a date range, so a backfill of six days in May has no business
 * replacing it. Leaving the table alone is what makes "a ranged sync writes
 * only the days it fetched" true of every table rather than only of the usage
 * ones — and it is why a backfill appends no governance *observation* either.
 * `observedOn`/`observedAt` are passed in rather than read from the clock here
 * so the day a run is recorded under is decided once, alongside the window.
 */
async function persist(
  snapshot: GatewaySnapshot,
  budgets: GatewayBudgetSnapshot[] | null,
  models: GatewayModelSnapshot[] | null,
  health: GatewayHealthSnapshot[] | null,
  slowResponses: GatewaySlowResponseDailyInsert[] | null,
  observedOn: string,
  observedAt: Date,
): Promise<void> {
  const dailyRows: GatewayDailyInsert[] = snapshot.daily.map((day) => ({ ...day }));
  const breakdownRows: GatewayBreakdownInsert[] = snapshot.breakdowns.map((row) => ({ ...row }));
  const budgetRows: GatewayBudgetInsert[] = (budgets ?? []).map((budget) => ({ ...budget }));
  const modelRows: GatewayModelInsert[] = (models ?? []).map((model) => ({ ...model }));
  // The alias join happens here rather than in the client because this is the
  // one place both snapshots exist: `/health` reports routing strings and
  // `/model/info` reports aliases, and the two are only guaranteed to describe
  // the same proxy when they came from the same run. Resolving against a stored
  // catalogue instead would join today's deployments to yesterday's price list.
  const healthRows: GatewayDeploymentHealthInsert[] = (health ?? []).map((deployment) => ({
    ...deployment,
    model: resolveDeploymentModel(models ?? [], deployment.backend),
    checkedAt: observedAt,
  }));
  // The alias is stored as resolved *today* rather than joined at read time,
  // for the same reason it is resolved here at all: re-resolving an old
  // observation against a newer catalogue would quietly re-file a deployment
  // that has since moved to another alias, erasing the move.
  const healthHistoryRows: GatewayDeploymentHealthHistoryInsert[] = healthRows.map((row) => ({
    id: row.id,
    date: observedOn,
    backend: row.backend,
    model: row.model ?? null,
    provider: row.provider ?? null,
    healthy: row.healthy,
    error: row.error ?? null,
    errorStatus: row.errorStatus ?? null,
    observedAt,
  }));
  const historyRows: GatewayBudgetHistoryInsert[] = (budgets ?? []).map((budget) => ({
    ...budget,
    date: observedOn,
    observedAt,
  }));

  await db.transaction(async (tx) => {
    if (snapshot.dates.length > 0) {
      await tx.delete(gatewayDaily).where(inArray(gatewayDaily.date, snapshot.dates));
      await tx
        .delete(gatewayBreakdownDaily)
        .where(inArray(gatewayBreakdownDaily.date, snapshot.dates));
    }
    for (const rows of chunk(dailyRows, CHUNK_SIZE)) {
      await tx.insert(gatewayDaily).values(rows);
    }
    for (const rows of chunk(breakdownRows, CHUNK_SIZE)) {
      await tx.insert(gatewayBreakdownDaily).values(rows);
    }
    // Budgets are current state, not history: the whole table is the snapshot,
    // so it is replaced entire. A key that was rotated away or a team that was
    // deleted has no row to keep, and leaving one standing would show an owner
    // a cap that nothing enforces any more. Emptied deliberately when the
    // proxy offers no management routes — the UI reads "no budgets visible",
    // which is true, rather than an ever-staler copy of the last ones seen.
    // The price list is the same kind of write as the budget snapshot and is
    // scoped by the same rule: a full sync replaces it entire, a ranged one
    // leaves it alone. A catalogue is current configuration, so a model the
    // router no longer offers must lose its row rather than keep pricing
    // traffic that can no longer happen — and a repair of six days in May has
    // nothing to say about what the proxy charges today.
    if (models !== null) {
      await tx.delete(gatewayModel);
      for (const rows of chunk(modelRows, CHUNK_SIZE)) {
        await tx.insert(gatewayModel).values(rows);
      }
    }
    // Deployment health is the third current-state table and takes the same
    // rule for a third time: a full sync replaces it entire, a ranged one does
    // not touch it. A deployment the router no longer offers must lose its row
    // rather than sit on the page as a permanent outage nobody can clear, and a
    // repair of six days in May says nothing about which endpoint is up now.
    if (health !== null) {
      await tx.delete(gatewayDeploymentHealth);
      for (const rows of chunk(healthRows, CHUNK_SIZE)) {
        await tx.insert(gatewayDeploymentHealth).values(rows);
      }
      // ...and appended, exactly as the budget snapshot is: keyed on the
      // observation day, so a second sync the same afternoon replaces the day's
      // reading rather than adding one. Only a reading that actually happened is
      // filed — `health === null` covers both a backfill (which never calls
      // `/health`) and a swallowed failure, and neither may leave a row behind
      // saying what the deployments were doing.
      for (const rows of chunk(healthHistoryRows, CHUNK_SIZE)) {
        await tx
          .insert(gatewayDeploymentHealthHistory)
          .values(rows)
          .onConflictDoUpdate({
            target: [gatewayDeploymentHealthHistory.id, gatewayDeploymentHealthHistory.date],
            set: {
              backend: sql`excluded.backend`,
              model: sql`excluded.model`,
              provider: sql`excluded.provider`,
              healthy: sql`excluded.healthy`,
              error: sql`excluded.error`,
              errorStatus: sql`excluded.error_status`,
              observedAt: sql`excluded.observed_at`,
            },
          });
      }
    }
    // The hang counter is the one *live* read that is kept, and it is written
    // like the two history tables rather than like the three snapshots: keyed on
    // the day it covers, upserted, so a second run this afternoon replaces that
    // day's reading instead of doubling counts that are meant to be added. Null
    // covers a backfill, a refusal, a proxy with `disable_spend_logs` and a
    // swallowed failure alike — all four are nights nobody read, and none of
    // them may leave a row saying nothing hung.
    if (slowResponses !== null && slowResponses.length > 0) {
      const slowRows = slowResponses.map((row) => ({ ...row, observedAt }));
      for (const rows of chunk(slowRows, CHUNK_SIZE)) {
        await tx
          .insert(gatewaySlowResponseDaily)
          .values(rows)
          .onConflictDoUpdate({
            target: [
              gatewaySlowResponseDaily.date,
              gatewaySlowResponseDaily.model,
              gatewaySlowResponseDaily.deploymentKey,
            ],
            set: {
              totalCount: sql`excluded.total_count`,
              slowCount: sql`excluded.slow_count`,
              observedAt: sql`excluded.observed_at`,
            },
          });
      }
    }
    if (budgets !== null) {
      await tx.delete(gatewayBudget);
      for (const rows of chunk(budgetRows, CHUNK_SIZE)) {
        await tx.insert(gatewayBudget).values(rows);
      }
      // ...and appended to history, which is the opposite kind of write: keyed
      // on the observation *day* rather than replaced, so a second sync the
      // same afternoon updates today's row instead of adding one. That is what
      // keeps the table growing with the gateway and the calendar rather than
      // with the scheduler's frequency. A governance object the proxy no longer
      // reports simply stops appearing — its past observations stay, because
      // "this key was capped at $3,000 in June" does not stop being true when
      // the key is rotated away.
      for (const rows of chunk(historyRows, CHUNK_SIZE)) {
        await tx
          .insert(gatewayBudgetHistory)
          .values(rows)
          .onConflictDoUpdate({
            target: [
              gatewayBudgetHistory.scope,
              gatewayBudgetHistory.key,
              gatewayBudgetHistory.date,
            ],
            set: {
              label: sql`excluded.label`,
              spendNano: sql`excluded.spend_nano`,
              maxBudgetNano: sql`excluded.max_budget_nano`,
              softBudgetNano: sql`excluded.soft_budget_nano`,
              budgetDuration: sql`excluded.budget_duration`,
              resetAt: sql`excluded.reset_at`,
              tpmLimit: sql`excluded.tpm_limit`,
              rpmLimit: sql`excluded.rpm_limit`,
              blocked: sql`excluded.blocked`,
              observedAt: sql`excluded.observed_at`,
            },
          });
      }
    }
  });

  log.debug(
    {
      dash: {
        days: snapshot.dates.length,
        dailyRows: dailyRows.length,
        breakdownRows: breakdownRows.length,
        budgetRows: budgetRows.length,
        modelRows: modelRows.length,
        healthRows: healthRows.length,
        unhealthy: healthRows.filter((row) => !row.healthy).length,
        slowResponseRows: slowResponses?.length ?? 0,
        observedOn,
      },
    },
    'gateway usage persisted',
  );
}

/**
 * Sweep `/model/metrics/slow_responses` for one day, and never let it fail the
 * sync.
 *
 * The first *live* read to be stored, and the only one of the three per-alias
 * sweeps whose payload survives being kept: it answers counts of disjoint
 * request-log rows beside the number of rows it counted them out of, and counts
 * add. The exception sweep carries no denominator and `/model/metrics` answers
 * an average with its counts already discarded, so neither can be accumulated
 * into anything a reader could act on.
 *
 * The day swept is the *last day of the window* rather than today: today is
 * still accruing, exactly as it is for usage, and filing a partial day would
 * make every trend read as a collapse on its newest bar. That also makes the
 * counts line up with the `gateway_daily` row written in the same run.
 *
 * The alias list comes from the snapshot already in memory rather than from a
 * second query, ranked by that day's own spend and capped like the live route:
 * the proxy's SQL filters on one `model_group` at a time with no wildcard, so a
 * sweep is a round trip per alias over the largest table LiteLLM has.
 *
 * Failures are swallowed for the same reason `/health`'s are, and the argument
 * is stronger here: this reads `LiteLLM_SpendLogs`, which can be switched off
 * entirely (`disable_spend_logs`), pruned on its own schedule, or simply slow
 * enough on a busy proxy to time out. None of that is a reason to fail a job
 * that has already fetched ninety days of usage. A day nobody read stays
 * unrecorded rather than being filed as a night on which nothing hung.
 *
 * A ranged sync records nothing at all, and unlike `/health` the reason is not
 * cost but truth: a backfill repairs *aggregate* days, and the request log
 * behind this route has its own retention — asking it about six days in May
 * would answer with whatever survived pruning and file it as the reading for
 * those days.
 */
async function readSlowResponses(
  client: {
    fetchModelSlowResponses: (
      from: string,
      to: string,
      models: readonly string[],
    ) => Promise<{ rows: GatewaySlowResponseRecord[]; available: boolean }>;
  },
  ranged: boolean,
  snapshot: GatewaySnapshot,
  day: string,
): Promise<GatewaySlowResponseDailyInsert[] | null> {
  if (ranged) return null;

  const spendByModel = new Map<string, bigint>();
  for (const row of snapshot.breakdowns) {
    if (row.dimension !== 'model' || row.date !== day) continue;
    spendByModel.set(row.key, (spendByModel.get(row.key) ?? 0n) + row.spendNano);
  }
  const models = [...spendByModel.entries()]
    .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] > a[1] ? 1 : -1))
    .map(([model]) => model)
    .slice(0, SLOW_RESPONSE_MODEL_CAP);
  if (models.length === 0) return null;

  try {
    const page = await client.fetchModelSlowResponses(day, day, models);
    // `available: false` is a refusal or a proxy with the request log switched
    // off, and it must not land as a day of zero hangs — the whole point of the
    // table is that an unread night stays unread.
    if (!page.available) return null;
    return page.rows
      .filter((row) => Number.isFinite(row.total) && row.total > 0)
      .map((row) => ({
        date: day,
        model: row.model,
        deploymentKey: row.key,
        totalCount: row.total,
        slowCount: row.slow,
      }));
  } catch (error) {
    log.error({ err: error }, 'sweeping gateway slow responses failed — usage sync unaffected');
    return null;
  }
}

/**
 * Read `/health`, and never let it fail the sync.
 *
 * Health rides along with usage like governance and the price list, and is the
 * one read with a cost attached: on a proxy without `background_health_checks`
 * configured, `/health` issues a live test call to every deployment while
 * answering. Once a night is a price worth paying for the only view of the
 * deployments *behind* an alias; once per backfill would be paying it to learn
 * nothing new, which is why a ranged sync skips it exactly as it skips
 * governance.
 *
 * It is also the only ride-along whose failure is swallowed rather than
 * propagated, and the asymmetry is deliberate. A budget or catalogue read is two
 * fast table lookups, so a failure there says something is wrong with the proxy
 * and failing the job is the honest answer. A health check is a fan-out of live
 * calls against every backend the corporation uses: it can legitimately take
 * minutes and time out on a gateway that is otherwise perfectly well. Failing a
 * usage sync that has already fetched ninety days because an operational garnish
 * was slow would be the wrong trade.
 *
 * `null` — from a backfill or from a failure — leaves the table untouched, so
 * the last successful reading stands with its own `checkedAt` on it rather than
 * being blanked into "no deployments".
 */
async function readDeploymentHealth(
  client: { fetchHealth: () => Promise<GatewayHealthSnapshot[]> },
  ranged: boolean,
): Promise<GatewayHealthSnapshot[] | null> {
  if (ranged) return null;
  try {
    return await client.fetchHealth();
  } catch (error) {
    log.error({ err: error }, 'reading gateway deployment health failed — usage sync unaffected');
    return null;
  }
}

/**
 * Take a seal on any closed month the sync has just completed.
 *
 * This is the moment the answer can change: the run that stores a month's last
 * day is the run that makes it sealable. It rides along with the sync rather
 * than sitting on its own timer for the same reason governance does — one
 * fewer schedule to reason about — but unlike governance it *is* skipped by a
 * backfill, and for the opposite reason. A backfill repairs days inside a month
 * that may already be sealed; sealing it here would be taking the first seal of
 * a month whose gap has only just been filled, which is correct, but it would
 * also mean a repair silently issues a statement. That decision belongs to
 * whoever ran the repair, via `POST /api/gateway/months/:month/seal`.
 *
 * Never fails the sync. The usage has already landed by this point, and a
 * bookkeeping step that could not run today runs tomorrow.
 */
async function sealNewlyClosedMonths(ranged: boolean): Promise<void> {
  if (ranged) return;
  try {
    const { sealed, skipped } = await sealClosedMonths('scheduler');
    if (sealed.length > 0) {
      log.info({ dash: { sealed, skipped } }, 'closed gateway months sealed');
    }
  } catch (error) {
    log.error({ err: error }, 'sealing closed gateway months failed — usage sync unaffected');
  }
}

/**
 * Assess the snapshots that have just landed — budgets and the `/health`
 * reading — and send what is new.
 *
 * Skipped by a backfill for the same reason those two fetches are: a ranged
 * sync reads neither, so the snapshots it would be evaluating are whatever the
 * last full run left, and re-evaluating them would only risk closing and
 * reopening episodes on a schedule nobody chose.
 *
 * Never fails the sync. The usage has landed; an alert that could not be sent
 * tonight is still pending tomorrow, which is exactly the retry policy. A full
 * sync whose `/health` call failed is the one case worth naming here: the
 * reading is not refreshed, so the notifier does not assess it, and every open
 * deployment episode stays open rather than reading as a gateway that recovered.
 */
async function notifyFindings(ranged: boolean): Promise<void> {
  if (ranged) return;
  try {
    const result = await notifyGatewayFindings();
    if (result.opened > 0 || result.cleared > 0 || result.delivered > 0) {
      log.info({ dash: { ...result, assessed: result.assessed.join(',') } }, 'gateway findings evaluated');
    }
  } catch (error) {
    log.error({ err: error }, 'evaluating gateway findings failed — usage sync unaffected');
  }
}

/**
 * Starts a gateway sync and returns the job to poll — single-flight per kind,
 * concurrent with every other sync. The whole window is fetched before
 * anything is written, so a mid-fetch failure fails the job and leaves the
 * previously synced usage untouched. `seats_synced` carries the number of days
 * covered (the column is the generic "how much did this job move" counter).
 *
 * With no `requested` window this is the nightly full re-pull. With one it is a
 * *backfill*: the coverage route names days that carry no rows, and this is how
 * they are repaired without re-pulling a quarter. Single-flight is per kind, so
 * a backfill asked for while the nightly sync is running gets that job back
 * instead — which is benign, since the full window is a superset of any range
 * it would have covered, but it does mean the returned job's range may be wider
 * than the one requested.
 */
export async function startGatewaySync(
  requested?: GatewaySyncRequest,
): Promise<RefreshJob> {
  const client = createGatewayClient();
  if (client === null) throw new GatewaySyncUnavailableError();

  const ranged = requested?.from !== undefined || requested?.to !== undefined;
  const { from, to } = resolveGatewaySyncWindow(requested, utcDay(0));

  return startJob('gateway', {
    action: 'gateway-sync',
    context: { gatewaySource: client.name, from, to, ranged },
    run: async () => {
      const snapshot = await client.fetchUsage(from, to);
      // Governance rides along with usage rather than on its own schedule: it
      // is two small requests, and a budget read hours apart from the spend it
      // is shown next to would be a worse lie than a slightly stale one. A
      // backfill skips it: current state has nothing to do with a repaired day
      // in May, and re-reading it there would only widen what a repair can
      // break.
      const budgets = ranged ? null : await client.fetchBudgets();
      // The price list rides along for the same reason and under the same rule:
      // two requests, current state, and a backfill has no business touching it.
      const models = ranged ? null : await client.fetchModels();
      const health = await readDeploymentHealth(client, ranged);
      // Swept for the window's last day — the day usage has just settled for,
      // never today, which is still accruing.
      const slowResponses = await readSlowResponses(client, ranged, snapshot, to);
      // The observation is stamped with the day the *reading* was taken, which
      // is today — not with the last day of the usage window. A budget counter
      // describes the period in flight right now, and filing it under yesterday
      // would make the history disagree with the snapshot it came from.
      await persist(snapshot, budgets, models, health, slowResponses, utcDay(0), new Date());
      await sealNewlyClosedMonths(ranged);
      await notifyFindings(ranged);
      return snapshot.dates.length;
    },
  });
}
