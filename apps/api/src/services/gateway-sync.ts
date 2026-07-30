import { inArray } from 'drizzle-orm';
import type { RefreshJob } from '@dash/shared';
import { db } from '../db/client.js';
import { gatewayBreakdownDaily, gatewayDaily } from '../db/schema.js';
import type { GatewayBreakdownInsert, GatewayDailyInsert } from '../db/schema.js';
import { createGatewayClient } from '../gateway/index.js';
import type { GatewaySnapshot } from '../gateway/index.js';
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

/**
 * Replace every fetched day in one transaction. Delete-then-insert, not
 * upsert, for the same reason the Copilot breakdowns use it: a re-pulled day's
 * key set can shrink (a model retired, a key rotated) and an upsert would
 * leave the vanished keys standing and double-counting. The delete is scoped
 * to the dates the client says it covered — days outside the window keep their
 * rows, so shrinking WINDOW_DAYS never destroys history.
 */
async function persist(snapshot: GatewaySnapshot): Promise<void> {
  const dailyRows: GatewayDailyInsert[] = snapshot.daily.map((day) => ({ ...day }));
  const breakdownRows: GatewayBreakdownInsert[] = snapshot.breakdowns.map((row) => ({ ...row }));

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
  });

  log.debug(
    {
      dash: {
        days: snapshot.dates.length,
        dailyRows: dailyRows.length,
        breakdownRows: breakdownRows.length,
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
 */
export async function startGatewaySync(): Promise<RefreshJob> {
  const client = createGatewayClient();
  if (client === null) throw new GatewaySyncUnavailableError();

  // Yesterday backwards: today is still accruing, and the proxy's daily
  // aggregates for it would be revised the moment we stored them.
  const to = utcDay(-1);
  const from = utcDay(-WINDOW_DAYS);

  return startJob('gateway', {
    action: 'gateway-sync',
    context: { gatewaySource: client.name, from, to },
    run: async () => {
      const snapshot = await client.fetchUsage(from, to);
      await persist(snapshot);
      return snapshot.dates.length;
    },
  });
}
