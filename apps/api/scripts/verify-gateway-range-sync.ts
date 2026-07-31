/**
 * Ad-hoc check of the ranged gateway sync — the backfill the coverage note's
 * gaps are repaired with. Run it by hand (it needs the API's env and a
 * database, like `verify-gateway-budgets.ts`):
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-range-sync.ts
 *
 * Two things are being checked, and they fail in completely different ways.
 *
 * **The window arithmetic** is pure and is where the off-by-ones live: a sync
 * covers `WINDOW_DAYS` ending *yesterday*, so "today" is never fetched and the
 * earliest day is `today − 90` rather than `today − 89` — the same boundary
 * `summarizeGatewayCoverage` had to be corrected to. Bounds outside that are
 * clamped rather than refused, because a caller asking for more than the proxy
 * holds should get what the proxy holds; but a window entirely outside it is an
 * error, because a sync that succeeds while filling nothing is the wrong answer
 * to "fill this gap", and the button that asked would go quiet and green.
 *
 * **The blast radius** is not pure and cannot be reasoned about: the whole
 * premise of a backfill is that it writes the days it fetched and nothing else.
 * That is asserted against Postgres by deleting a run of days, backfilling
 * exactly that run, and requiring every other day's stored spend to be
 * byte-identical afterwards — plus a sentinel row in `gateway_budget`, which a
 * full sync replaces wholesale and a ranged one must leave standing.
 *
 * The database section is skipped (loudly) when the gateway has never synced
 * locally, since there is nothing to damage and nothing to prove.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { GATEWAY_RETENTION_DAYS } from '@dash/shared';
import { db } from '../src/db/client.js';
import { gatewayBreakdownDaily, gatewayBudget, gatewayDaily, refreshJobs } from '../src/db/schema.js';
import { createGatewayClient } from '../src/gateway/index.js';
import {
  GatewaySyncRangeError,
  resolveGatewaySyncWindow,
  startGatewaySync,
} from '../src/services/gateway-sync.js';

const MS_PER_DAY = 86_400_000;

/** A fixed "today" — the window moves at midnight and assertions must not. */
const TODAY = '2026-07-31';
const YESTERDAY = '2026-07-30';
const EARLIEST = '2026-05-02'; // 2026-07-31 − 90 days

function iso(from: string, offsetDays: number): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) + offsetDays * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

/** The message of the range error a call raised, or null when it did not raise one. */
function refusal(requested: { from?: string; to?: string }): string | null {
  try {
    resolveGatewaySyncWindow(requested, TODAY);
    return null;
  } catch (error) {
    if (error instanceof GatewaySyncRangeError) return error.message;
    throw error;
  }
}

// ------------------------------------------------- 1. the default is unchanged

{
  const window = resolveGatewaySyncWindow(undefined, TODAY);
  check(window.to === YESTERDAY, `default window ends ${window.to}, expected ${YESTERDAY}`);
  check(window.from === EARLIEST, `default window starts ${window.from}, expected ${EARLIEST}`);
  // 90 days ending yesterday, inclusive — the same span the retention floor is
  // measured over, which is what keeps the coverage note's "anything newer a
  // sync will fill" true rather than off by one at the far end.
  const days = (Date.parse(`${window.to}T00:00:00Z`) - Date.parse(`${window.from}T00:00:00Z`)) / MS_PER_DAY + 1;
  check(days === GATEWAY_RETENTION_DAYS, `default window covers ${days} days, expected 90`);

  const empty = resolveGatewaySyncWindow({}, TODAY);
  check(
    empty.from === window.from && empty.to === window.to,
    'an empty request resolved to something other than the nightly window',
  );
}

// ------------------------------------------------ 2. each bound is independent

{
  const fromOnly = resolveGatewaySyncWindow({ from: '2026-07-01' }, TODAY);
  check(
    fromOnly.from === '2026-07-01' && fromOnly.to === YESTERDAY,
    `from-only resolved to ${fromOnly.from} – ${fromOnly.to}`,
  );

  const toOnly = resolveGatewaySyncWindow({ to: '2026-07-01' }, TODAY);
  check(
    toOnly.from === EARLIEST && toOnly.to === '2026-07-01',
    `to-only resolved to ${toOnly.from} – ${toOnly.to}`,
  );

  const both = resolveGatewaySyncWindow({ from: '2026-06-04', to: '2026-06-09' }, TODAY);
  check(
    both.from === '2026-06-04' && both.to === '2026-06-09',
    `a six-day gap resolved to ${both.from} – ${both.to}`,
  );

  const single = resolveGatewaySyncWindow({ from: '2026-06-04', to: '2026-06-04' }, TODAY);
  check(
    single.from === '2026-06-04' && single.to === '2026-06-04',
    'a one-day gap did not resolve to itself',
  );
}

// -------------------------------------------------------------- 3. the clamps

{
  // Older than the proxy holds at one end only: take what is still there rather
  // than refusing the half that exists. This is the gap-straddling-the-floor
  // case the note draws a Fill button for.
  const straddling = resolveGatewaySyncWindow({ from: '2026-04-20', to: '2026-05-06' }, TODAY);
  check(
    straddling.from === EARLIEST && straddling.to === '2026-05-06',
    `a straddling window resolved to ${straddling.from} – ${straddling.to}`,
  );

  // Today is still accruing and would be revised the moment it was stored, so
  // a request running through it stops at yesterday rather than being refused.
  const throughToday = resolveGatewaySyncWindow({ from: '2026-07-20', to: '2026-08-05' }, TODAY);
  check(
    throughToday.from === '2026-07-20' && throughToday.to === YESTERDAY,
    `a window through today resolved to ${throughToday.from} – ${throughToday.to}`,
  );

  const boundaries = resolveGatewaySyncWindow({ from: EARLIEST, to: YESTERDAY }, TODAY);
  check(
    boundaries.from === EARLIEST && boundaries.to === YESTERDAY,
    'the exact window boundaries were clamped when they should have passed through',
  );
}

// ------------------------------------------------------------- 4. the refusals

{
  check(refusal({ from: '2026-07-10', to: '2026-07-01' }) !== null, 'an inverted window was accepted');

  // Entirely pruned upstream. The distinction that matters: a sync of these
  // days would succeed, write nothing, and leave the gap exactly where it was.
  const pruned = refusal({ from: '2026-01-01', to: '2026-03-01' });
  check(pruned !== null, 'a window older than retention was accepted');
  check(
    pruned?.includes(EARLIEST) === true,
    `the refusal does not name the earliest fetchable day: ${pruned}`,
  );
  // One day past the floor is the boundary case of the same rule.
  check(
    refusal({ from: iso(EARLIEST, -3), to: iso(EARLIEST, -1) }) !== null,
    'a window ending the day before the floor was accepted',
  );
  check(
    refusal({ from: iso(EARLIEST, -3), to: EARLIEST }) === null,
    'a window ending exactly on the floor was refused',
  );

  // Nothing is settled yet: today and later carry no aggregate the proxy would
  // stand behind, so there is nothing to fetch and clamping would silently
  // widen the request backwards.
  check(refusal({ from: TODAY, to: '2026-08-04' }) !== null, 'a window starting today was accepted');
  check(
    refusal({ from: YESTERDAY, to: '2026-08-04' }) === null,
    'a window starting yesterday was refused',
  );
}

// ------------------------------------------- 5. blast radius, against Postgres

const client = createGatewayClient();
if (client === null) {
  console.warn('\nGATEWAY_SOURCE is off — skipping the database section');
} else {
  const stored = await db
    .select({ date: gatewayDaily.date, spendNano: gatewayDaily.spendNano })
    .from(gatewayDaily)
    .orderBy(gatewayDaily.date);

  if (stored.length < 20) {
    console.warn(
      `\ngateway_daily holds ${stored.length} days — run POST /api/refresh/gateway first; skipping the database section`,
    );
  } else {
    const before = new Map(stored.map((row) => [row.date, row.spendNano]));
    // A run near the recent end: comfortably inside the proxy's retention (the
    // oldest stored days may be archive the proxy has pruned, which a backfill
    // legitimately cannot restore), and not the last day, which the nightly
    // sync is closest to touching.
    const targets = stored.slice(-15, -10).map((row) => row.date);
    const from = targets[0]!;
    const to = targets[targets.length - 1]!;

    // A row no sync would ever produce. A full sync empties this table before
    // rewriting it, so its survival is the assertion that a ranged one did not.
    const SENTINEL = 'verify-range-sync-sentinel';
    await db.delete(gatewayBudget).where(eq(gatewayBudget.key, SENTINEL));
    await db.insert(gatewayBudget).values({
      scope: 'api_key',
      key: SENTINEL,
      label: 'sentinel',
      spendNano: 0n,
      maxBudgetNano: null,
      softBudgetNano: null,
      budgetDuration: null,
      resetAt: null,
      tpmLimit: null,
      rpmLimit: null,
      blocked: false,
    });

    await db.delete(gatewayDaily).where(inArray(gatewayDaily.date, targets));
    await db.delete(gatewayBreakdownDaily).where(inArray(gatewayBreakdownDaily.date, targets));

    const job = await startGatewaySync({ from, to });
    const settled = await waitForJob(job.id);

    check(settled?.status === 'succeeded', `backfill job ${settled?.status}: ${settled?.error}`);
    check(
      settled?.seatsSynced === targets.length,
      `backfill covered ${settled?.seatsSynced} days, expected ${targets.length}`,
    );

    const after = new Map(
      (
        await db
          .select({ date: gatewayDaily.date, spendNano: gatewayDaily.spendNano })
          .from(gatewayDaily)
          .orderBy(gatewayDaily.date)
      ).map((row) => [row.date, row.spendNano]),
    );

    check(after.size === before.size, `${before.size} stored days became ${after.size}`);
    // Restored and carrying money — deliberately not "restored to the same
    // cent". The mock generator consumes its Lehmer stream from the start of
    // the requested window, so a five-day pull and a ninety-day pull disagree
    // about the same calendar date (iteration 7's finding). Asserting equality
    // here would be asserting a property of the generator, not of the sync.
    for (const date of targets) {
      check(after.has(date), `backfilled day ${date} is still missing`);
      check((after.get(date) ?? 0n) > 0n, `backfilled ${date} came back empty`);
    }
    // The whole point: everything the request did not name is untouched, so a
    // repair of five days in May cannot rewrite July while nobody is looking.
    for (const [date, spend] of before) {
      if (targets.includes(date)) continue;
      check(after.get(date) === spend, `untouched ${date} moved from ${spend} to ${after.get(date)}`);
    }

    const [sentinel] = await db
      .select()
      .from(gatewayBudget)
      .where(and(eq(gatewayBudget.scope, 'api_key'), eq(gatewayBudget.key, SENTINEL)));
    check(sentinel !== undefined, 'a ranged sync wiped the budget snapshot');
    await db.delete(gatewayBudget).where(eq(gatewayBudget.key, SENTINEL));

    // Breakdown rows are deleted and re-inserted per date like the daily ones;
    // a backfilled day with no breakdown at all would leave every card on the
    // page short by that day without moving the totals.
    const breakdowns = await db
      .select({ date: gatewayBreakdownDaily.date })
      .from(gatewayBreakdownDaily)
      .where(inArray(gatewayBreakdownDaily.date, targets));
    check(
      new Set(breakdowns.map((row) => row.date)).size === targets.length,
      'a backfilled day came back with no breakdown rows',
    );
  }
}

/** Poll a job row until it settles — `startJob` runs the work in the background. */
async function waitForJob(id: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const [row] = await db.select().from(refreshJobs).where(eq(refreshJobs.id, id));
    if (row && (row.status === 'succeeded' || row.status === 'failed')) return row;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

// ------------------------------------------------------------------- verdict

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('\nall gateway range-sync checks passed');
process.exit(0);
