/**
 * One-shot refresh: pull a live snapshot and persist it, then print counts.
 * Handy for seeding/ops without the HTTP job flow. `tsx src/refresh-once.ts [days]`.
 */
import { sql } from 'drizzle-orm';
import { createCopilotClient } from './copilot/index.js';
import { persistSnapshot } from './services/refresh.js';
import { db } from './db/client.js';
import { copilotSeats, modelDaily, orgDaily, spendDaily } from './db/schema.js';

const days = Number(process.argv[2] ?? 90);
const client = createCopilotClient();

console.log(`refreshing from '${client.name}' (${days}d)…`);
const start = Date.now();
const snapshot = await client.fetchSnapshot(days);
await persistSnapshot(snapshot);
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

const countExpr = { n: sql<number>`count(*)::int` };
const [seatsN] = await db.select(countExpr).from(copilotSeats);
const [spendN] = await db.select(countExpr).from(spendDaily);
const [orgN] = await db.select(countExpr).from(orgDaily);
const [modelN] = await db.select(countExpr).from(modelDaily);

console.log(
  JSON.stringify(
    {
      elapsedSec: elapsed,
      seats: seatsN?.n ?? 0,
      spendDays: spendN?.n ?? 0,
      orgDays: orgN?.n ?? 0,
      modelRows: modelN?.n ?? 0,
    },
    null,
    2,
  ),
);
process.exit(0);
