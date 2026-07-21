/**
 * One-shot refresh: pull a live snapshot and persist it, then log counts.
 * Handy for seeding/ops without the HTTP job flow. `tsx src/refresh-once.ts [days]`.
 */
import { sql } from 'drizzle-orm';
import { createCopilotClient } from './copilot/index.js';
import { eventDuration, moduleLogger } from './log.js';
import { persistSnapshot } from './services/refresh.js';
import { db } from './db/client.js';
import { copilotSeats, modelDaily, orgDaily, spendDaily } from './db/schema.js';

const log = moduleLogger('refresh-once');

const days = Number(process.argv[2] ?? 90);
const client = createCopilotClient();

log.info({ dash: { copilotSource: client.name, historyDays: days } }, 'one-shot refresh starting');
const startedAt = Date.now();
const snapshot = await client.fetchSnapshot(days);
await persistSnapshot(snapshot);

const countExpr = { n: sql<number>`count(*)::int` };
const [seatsN] = await db.select(countExpr).from(copilotSeats);
const [spendN] = await db.select(countExpr).from(spendDaily);
const [orgN] = await db.select(countExpr).from(orgDaily);
const [modelN] = await db.select(countExpr).from(modelDaily);

log.info(
  {
    'event.action': 'copilot-refresh',
    'event.outcome': 'success',
    'event.duration': eventDuration(startedAt),
    dash: {
      seats: seatsN?.n ?? 0,
      spendDays: spendN?.n ?? 0,
      orgDays: orgN?.n ?? 0,
      modelRows: modelN?.n ?? 0,
    },
  },
  'one-shot refresh finished',
);
process.exit(0);
