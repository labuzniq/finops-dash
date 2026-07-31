import { inArray, sql } from 'drizzle-orm';
import { resolveDeploymentModel } from '@dash/shared';
import type { RefreshJob } from '@dash/shared';
import { db } from '../db/client.js';
import {
  gatewayBreakdownDaily,
  gatewayBudget,
  gatewayBudgetHistory,
  gatewayDaily,
  gatewayDeploymentHealth,
  gatewayDeploymentHealthHistory,
  gatewayModel,
} from '../db/schema.js';
import type {
  GatewayBreakdownInsert,
  GatewayBudgetHistoryInsert,
  GatewayBudgetInsert,
  GatewayDailyInsert,
  GatewayDeploymentHealthHistoryInsert,
  GatewayDeploymentHealthInsert,
  GatewayModelInsert,
} from '../db/schema.js';
import { createGatewayClient } from '../gateway/index.js';
import type {
  GatewayBudgetSnapshot,
  GatewayHealthSnapshot,
  GatewayModelSnapshot,
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
        observedOn,
      },
    },
    'gateway usage persisted',
  );
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
 * Assess the governance snapshot that has just landed and send what is new.
 *
 * Skipped by a backfill for the same reason the budget fetch is: a ranged sync
 * does not read governance at all, so the snapshot it would be evaluating is
 * whatever the last full run left, and re-evaluating it would only risk closing
 * and reopening episodes on a schedule nobody chose.
 *
 * Never fails the sync. The usage has landed; an alert that could not be sent
 * tonight is still pending tomorrow, which is exactly the retry policy.
 */
async function notifyGovernanceFindings(ranged: boolean): Promise<void> {
  if (ranged) return;
  try {
    const result = await notifyGatewayFindings();
    if (result.opened > 0 || result.cleared > 0 || result.delivered > 0) {
      log.info({ dash: result }, 'gateway governance findings evaluated');
    }
  } catch (error) {
    log.error({ err: error }, 'evaluating gateway governance failed — usage sync unaffected');
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
      // The observation is stamped with the day the *reading* was taken, which
      // is today — not with the last day of the usage window. A budget counter
      // describes the period in flight right now, and filing it under yesterday
      // would make the history disagree with the snapshot it came from.
      await persist(snapshot, budgets, models, health, utcDay(0), new Date());
      await sealNewlyClosedMonths(ranged);
      await notifyGovernanceFindings(ranged);
      return snapshot.dates.length;
    },
  });
}
