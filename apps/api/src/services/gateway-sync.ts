import { inArray } from 'drizzle-orm';
import type { RefreshJob } from '@dash/shared';
import { db } from '../db/client.js';
import { gatewayBreakdownDaily, gatewayBudget, gatewayDaily } from '../db/schema.js';
import type {
  GatewayBreakdownInsert,
  GatewayBudgetInsert,
  GatewayDailyInsert,
} from '../db/schema.js';
import { createGatewayClient } from '../gateway/index.js';
import type { GatewayBudgetSnapshot, GatewaySnapshot } from '../gateway/index.js';
import { moduleLogger } from '../log.js';
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
 * ones.
 */
async function persist(
  snapshot: GatewaySnapshot,
  budgets: GatewayBudgetSnapshot[] | null,
): Promise<void> {
  const dailyRows: GatewayDailyInsert[] = snapshot.daily.map((day) => ({ ...day }));
  const breakdownRows: GatewayBreakdownInsert[] = snapshot.breakdowns.map((row) => ({ ...row }));
  const budgetRows: GatewayBudgetInsert[] = (budgets ?? []).map((budget) => ({ ...budget }));

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
    if (budgets !== null) {
      await tx.delete(gatewayBudget);
      for (const rows of chunk(budgetRows, CHUNK_SIZE)) {
        await tx.insert(gatewayBudget).values(rows);
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
      },
    },
    'gateway usage persisted',
  );
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
      await persist(snapshot, budgets);
      return snapshot.dates.length;
    },
  });
}
