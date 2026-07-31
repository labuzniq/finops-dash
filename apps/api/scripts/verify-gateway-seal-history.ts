/**
 * Ad-hoc check of gateway seal *revisions* — the audit trail behind a
 * corrected bill. Run it by hand (it needs the API's env and a database, like
 * `verify-gateway-seal.ts`):
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-seal-history.ts
 *
 * Two halves, again failing in different ways.
 *
 * **`diffSeals` is pure.** Both sides are recorded statements, so the answer
 * cannot move once the two revisions exist — unlike `sealDrift`, which
 * compares a seal against daily rows that any sync may rewrite. The checks
 * here are about what counts as a change: a line matched on its key rather
 * than its label (an alias filled in between two seals is the same payer, not
 * a new one plus a vanished one), a sub-cent settle that is *not* a change,
 * an appearance or a disappearance that always is, and the identity that makes
 * the whole diff readable — the line deltas plus the unattributed remainder
 * equal the month's own movement, per payer dimension.
 *
 * **The revision chain is not pure** and its whole value is that a replaced
 * statement survives. That is asserted against Postgres: seal a complete
 * month, move a day's rows under it, re-seal, and require revision 1 to be
 * exactly what it always was — superseded, still readable, still quotable by
 * number — while revision 2 carries the new figures and the diff names the
 * payer that moved. A re-seal that overwrote would leave a corrected bill with
 * nothing to be corrected *from*.
 *
 * The database section is skipped (loudly) when the gateway has never synced
 * locally, and it restores the day it moves before it finishes.
 */
import { and, eq } from 'drizzle-orm';
import { diffSeals, resolveMonthSeal } from '@dash/shared';
import type { GatewaySealLine, GatewaySealedMonth } from '@dash/shared';
import { db } from '../src/db/client.js';
import { gatewayBreakdownDaily, gatewayDaily, gatewayMonth, refreshJobs } from '../src/db/schema.js';
import { createGatewayClient } from '../src/gateway/index.js';
import {
  GatewaySealError,
  getGatewaySeal,
  getGatewaySealHistory,
  listGatewaySeals,
  sealGatewayMonth,
} from '../src/services/gateway-seal.js';
import { startGatewaySync } from '../src/services/gateway-sync.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

const ZERO = {
  requests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function line(key: string, spend: number, label: string | null = null): GatewaySealLine {
  return { dimension: 'team', key, label, spend, ...ZERO };
}

function seal(revision: number, spend: number, lines: GatewaySealLine[]): GatewaySealedMonth {
  return {
    month: '2026-04',
    monthStart: '2026-04-01',
    monthEnd: '2026-04-30',
    days: 30,
    sealedAt: `2026-05-0${revision}T02:00:00.000Z`,
    sealedBy: 'scheduler',
    revision,
    supersededAt: null,
    total: { spend, ...ZERO },
    lines,
  };
}

// ------------------------------------------------------- 1. the pure diff
{
  const before = seal(1, 1_000, [line('platform', 600), line('risk', 300, 'Risk')]);
  const after = seal(2, 1_100, [
    // platform settles by a fraction of a cent — not a revision anybody can act on
    line('platform', 600.001),
    // risk moves, and its alias was resolved between the two seals
    line('risk', 340, 'Risk & Compliance'),
    line('research', 60),
  ]);
  const diff = diffSeals(before, after);
  const teams = diff.dimensions.find((entry) => entry.dimension === 'team');
  const changes = teams?.lines ?? [];

  check(diff.revision === 2 && diff.previousRevision === 1, 'the diff names the wrong revisions');
  check(Math.abs(diff.spendDelta - 100) < 1e-9, `the month moved ${diff.spendDelta}, not 100`);
  check(diff.daysDelta === 0, 'a month of the same length reported a day delta');
  check(
    diff.dimensions.length === 4,
    `the diff covers ${diff.dimensions.length} payer dimensions, not 4`,
  );

  check(teams?.movedLines === 2, `${teams?.movedLines ?? 0} team lines moved, expected 2`);
  check(
    changes[0]?.key === 'research' && changes[1]?.key === 'risk',
    'the lines are not ordered by the size of the move',
  );
  check(
    changes.some((entry) => entry.key === 'research' && entry.change === 'added'),
    'a payer new to the revision is not reported as added',
  );
  check(
    !changes.some((entry) => entry.key === 'platform'),
    'a sub-cent settle was reported as a revision to a line',
  );
  // The label is the newer seal's when it has one — a payer whose alias was
  // resolved between two seals is the same payer, matched on its key.
  check(
    changes.find((entry) => entry.key === 'risk')?.label === 'Risk & Compliance',
    'the diff kept the stale alias',
  );
  // The identity the module guarantees: every line's movement — including the
  // sub-cent settles the list deliberately does not show — plus what nobody
  // was billed for is the month's own movement. Asserted against the
  // constructed inputs rather than against the rendered rows, because the two
  // differ by exactly the noise the threshold suppresses: 0.001 here.
  const trueAttributed = 0.001 + 40 + 60;
  check(
    Math.abs((teams?.unattributedDelta ?? 0) - (diff.spendDelta - trueAttributed)) < 1e-9,
    `unattributed movement is ${teams?.unattributedDelta}, expected ${diff.spendDelta - trueAttributed}`,
  );
  // …and the suppressed line is the only thing the shown rows are short by, so
  // a reader adding the visible column lands within a cent of the movement.
  const shown = changes.reduce((sum, entry) => sum + entry.spendDelta, 0);
  check(
    Math.abs(shown + (teams?.unattributedDelta ?? 0) - diff.spendDelta) < 0.005,
    'the shown lines plus the remainder are more than a cent from the movement',
  );
}

// ---------------------------------- 2. vanishing, and an unattributed shift
{
  const before = seal(1, 1_000, [line('platform', 600), line('sandbox', 5)]);
  // The gateway costs the same, platform's line is unchanged, and sandbox is
  // gone from the statement: the $5 it used to carry is now attributed to
  // nobody, so it lands on the unallocated line rather than on somebody's.
  const after = seal(2, 1_000, [line('platform', 600)]);
  const teams = diffSeals(before, after).dimensions.find((entry) => entry.dimension === 'team');
  const removed = teams?.lines.find((entry) => entry.key === 'sandbox');

  check(removed?.change === 'removed', 'a payer that left the statement is not reported');
  check(
    removed?.spend === 0 && removed?.previousSpend === 5 && removed.spendDelta === -5,
    'a removed line does not read as a fall to zero',
  );
  check(
    Math.abs((teams?.unattributedDelta ?? 0) - 5) < 1e-9,
    `the freed $5 reads as ${teams?.unattributedDelta} unattributed, expected 5`,
  );
}

// --------------------------------------- 3. the sample cap keeps the count
{
  const before = seal(1, 0, []);
  const after = seal(
    2,
    100,
    Array.from({ length: 20 }, (_, index) => line(`team-${index}`, index + 1)),
  );
  const teams = diffSeals(before, after).dimensions.find((entry) => entry.dimension === 'team');
  check(teams?.movedLines === 20, `the count reports ${teams?.movedLines}, not 20`);
  check(teams?.lines.length === 12, `the sample carries ${teams?.lines.length} lines, not 12`);
  check(teams?.linesTruncated === true, 'a truncated sample is not flagged');
  check(teams?.lines[0]?.key === 'team-19', 'the sample is not the biggest movers');
}

// ------------------------------------------------ 4. a month sealed once
{
  const only = seal(1, 1_000, [line('platform', 600)]);
  const diff = diffSeals(only, only);
  check(diff.spendDelta === 0, 'a seal compared with itself moved');
  check(
    diff.dimensions.every((entry) => entry.movedLines === 0),
    'a seal compared with itself reports moved lines',
  );
}

console.log(`pure checks done (${failures.length} failure(s) so far)`);

// ------------------------------------------------ 5. the chain in Postgres
const client = createGatewayClient();

if (client === null) {
  console.warn('\nGATEWAY_SOURCE is off — skipping the database section');
} else {
  const stored = (
    await db.select({ date: gatewayDaily.date }).from(gatewayDaily).orderBy(gatewayDaily.date)
  ).map((row) => row.date);
  const today = new Date().toISOString().slice(0, 10);
  const candidate = [...new Set(stored.map((day) => day.slice(0, 7)))]
    .reverse()
    .find((month) => resolveMonthSeal(month, stored, today).sealable);

  if (candidate === undefined) {
    console.warn(
      `\nno closed month is fully stored (${stored.length} days) — run POST /api/refresh/gateway first; skipping the database section`,
    );
  } else {
    const month = candidate;
    console.log(`\nre-sealing ${month} (the newest complete closed month stored)`);

    const first = await sealGatewayMonth(month, { force: true, sealedBy: 'manual' });
    const firstRevision = first.revision;
    check(first.supersededAt === null, 'a freshly taken seal is already superseded');

    // Move one day's rows under the seal: the same shape as LiteLLM revising a
    // late-landing day, but deterministic. One api_key's breakdown row and the
    // day's total go up by the same amount, so the month stays internally
    // consistent and exactly one payer moved.
    const victim = stored.filter((day) => day.startsWith(month))[10];
    const [payer] = await db
      .select()
      .from(gatewayBreakdownDaily)
      .where(
        and(
          eq(gatewayBreakdownDaily.date, victim ?? ''),
          eq(gatewayBreakdownDaily.dimension, 'api_key'),
        ),
      )
      .limit(1);

    if (victim === undefined || payer === undefined) {
      check(false, `no api_key row to move on ${victim ?? 'no day'}`);
    } else {
      const bump = 12_000_000_000n; // $12
      const [dayRow] = await db.select().from(gatewayDaily).where(eq(gatewayDaily.date, victim));
      await db
        .update(gatewayDaily)
        .set({ spendNano: (dayRow?.spendNano ?? 0n) + bump })
        .where(eq(gatewayDaily.date, victim));
      await db
        .update(gatewayBreakdownDaily)
        .set({ spendNano: payer.spendNano + bump })
        .where(
          and(
            eq(gatewayBreakdownDaily.date, victim),
            eq(gatewayBreakdownDaily.dimension, 'api_key'),
            eq(gatewayBreakdownDaily.key, payer.key),
          ),
        );

      // 5a. a re-seal still has to be asked for explicitly
      let refusal: GatewaySealError | null = null;
      try {
        await sealGatewayMonth(month);
      } catch (error) {
        refusal = error instanceof GatewaySealError ? error : null;
        if (refusal === null) throw error;
      }
      check(refusal?.code === 'sealed', `re-sealing without force gave ${refusal?.code}`);

      const second = await sealGatewayMonth(month, { force: true, sealedBy: 'manual' });
      check(
        second.revision === firstRevision + 1,
        `the re-seal is revision ${second.revision}, expected ${firstRevision + 1}`,
      );
      check(second.supersededAt === null, 'the current revision is marked superseded');
      check(
        Math.abs(second.total.spend - first.total.spend - 12) < 0.005,
        `the re-seal moved by ${(second.total.spend - first.total.spend).toFixed(2)}, expected 12`,
      );

      // 5b. the statement that was issued survives, byte for byte
      const kept = await getGatewaySeal(month, firstRevision);
      check(kept !== null, `revision ${firstRevision} is gone after the re-seal`);
      check(
        kept !== null && Math.abs(kept.total.spend - first.total.spend) < 0.005,
        'the superseded revision moved',
      );
      check(kept?.supersededAt !== null, 'the replaced revision is not stamped as superseded');
      check(
        kept !== null && kept.lines.length === first.lines.length,
        `the superseded revision kept ${kept?.lines.length} lines, issued ${first.lines.length}`,
      );

      // 5c. exactly one current statement, and it is the new one
      const current = await getGatewaySeal(month);
      check(current?.revision === second.revision, 'the current statement is not the newest');
      const seals = await listGatewaySeals();
      check(
        seals.filter((entry) => entry.month === month).length === 1,
        'the seal list carries more than one revision of the month',
      );
      check(
        seals.find((entry) => entry.month === month)?.revision === second.revision,
        'the seal list is not showing the current revision',
      );
      const rows = await db
        .select({ revision: gatewayMonth.revision, supersededAt: gatewayMonth.supersededAt })
        .from(gatewayMonth)
        .where(eq(gatewayMonth.month, month));
      check(
        rows.filter((row) => row.supersededAt === null).length === 1,
        `${rows.filter((row) => row.supersededAt === null).length} revisions claim to be current`,
      );
      check(rows.length >= 2, 'the replaced revision was not kept');

      // 5d. the history, and the diff that names who moved
      const history = await getGatewaySealHistory(month);
      check(history !== null, 'the month has no history');
      check(
        history?.revisions[0]?.revision === second.revision,
        'the history is not newest-first',
      );
      check(
        history?.diffs.length === (history?.revisions.length ?? 0) - 1,
        `${history?.diffs.length} diffs for ${history?.revisions.length} revisions`,
      );
      const latest = history?.diffs[0];
      check(
        latest !== undefined && Math.abs(latest.spendDelta - 12) < 0.005,
        `the latest diff reports ${latest?.spendDelta.toFixed(2)}, expected 12`,
      );
      check(latest?.daysDelta === 0, 'a re-seal of the same days moved the day count');

      const keys = latest?.dimensions.find((entry) => entry.dimension === 'api_key');
      const moved = keys?.lines.find((entry) => entry.key === payer.key);
      check(
        moved !== undefined && Math.abs(moved.spendDelta - 12) < 0.005,
        `${payer.key} moved by ${moved?.spendDelta.toFixed(2) ?? 'nothing'}, expected 12`,
      );
      check(keys?.movedLines === 1, `${keys?.movedLines} api_key lines moved, expected 1`);
      check(
        Math.abs(keys?.unattributedDelta ?? 1) < 0.005,
        `the api_key dimension left ${keys?.unattributedDelta?.toFixed(2)} unattributed`,
      );
      // Every payer dimension has to reconcile, including the ones whose rows
      // did not move: a dimension that does not attribute the day's payer
      // reports the whole $12 as unattributed rather than a short sum.
      for (const entry of latest?.dimensions ?? []) {
        const attributed = entry.lines.reduce((sum, row) => sum + row.spendDelta, 0);
        check(
          !entry.linesTruncated &&
            Math.abs(attributed + entry.unattributedDelta - (latest?.spendDelta ?? 0)) < 0.005,
          `${entry.dimension} does not reconcile to the month's movement`,
        );
      }

      // 5e. put the day back the way the coverage note's Fill button would
      const job = await startGatewaySync({ from: victim, to: victim });
      const settled = await waitForJob(job.id);
      check(settled?.status === 'succeeded', `restoring ${victim} ${settled?.status}`);
      // Restoring does not re-seal — the statement stays where it was, which is
      // the same rule the scheduler follows.
      const afterRestore = await getGatewaySeal(month);
      check(
        afterRestore?.revision === second.revision,
        'restoring a day changed the current revision',
      );
    }
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

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nall gateway seal-history checks passed');
process.exit(0);
