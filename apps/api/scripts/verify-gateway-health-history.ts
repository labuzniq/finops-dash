/**
 * Ad-hoc check of the gateway *deployment health history* — what `/health`
 * reported on the days it was asked, which is the one deployment fact the proxy
 * does not serve and the dashboard has to keep for itself.
 *
 * Run it by hand (it needs the API's env and a database, like
 * `verify-gateway-budget-history.ts`):
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-health-history.ts
 *
 * Two halves that fail in different ways.
 *
 * **`summarizeDeploymentHistory` is pure**, and it is where every claim about a
 * *sequence* of readings gets made. The interesting assertions are the ones
 * about what it must not invent: a day nobody looked at neither breaks a run nor
 * extends the count of failing readings, a single failing reading is not a
 * standing fault, and nothing anywhere converts readings into hours or into an
 * availability percentage — the sample is nightly and a deployment that failed
 * and recovered between two readings left nothing behind.
 *
 * **The recording is not pure**, and its three rules are asserted against
 * Postgres: a full sync files exactly one reading per deployment per day and it
 * agrees with the snapshot it was taken from, a second sync the same day
 * replaces that day's reading rather than adding one, and a ranged backfill
 * files nothing at all — it never calls `/health`, so it has no reading to keep
 * and must not invent one.
 *
 * The database half is skipped (loudly) when the gateway has never synced
 * locally, and it removes every row it plants.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  FLAPPING_OUTAGES,
  STANDING_OUTAGE_READINGS,
  summarizeDeploymentHistory,
} from '@dash/shared';
import type { GatewayDeploymentHistory, GatewayDeploymentObservation } from '@dash/shared';
import { db } from '../src/db/client.js';
import {
  gatewayDeploymentHealth,
  gatewayDeploymentHealthHistory,
  refreshJobs,
} from '../src/db/schema.js';
import { createGatewayClient } from '../src/gateway/index.js';
import { getGatewayDeploymentHistory, getGatewayHealth } from '../src/services/gateway.js';
import { startGatewaySync } from '../src/services/gateway-sync.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

function shiftIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A constructed reading. Everything not named is the boring default. */
function reading(
  date: string,
  healthy: boolean,
  overrides: Partial<GatewayDeploymentObservation> = {},
): GatewayDeploymentObservation {
  return {
    id: 'dep-1',
    backend: 'azure/gpt-4o-eu2',
    model: 'gpt-4o',
    provider: 'azure',
    date,
    observedAt: `${date}T07:00:00.000Z`,
    healthy,
    error: healthy ? null : 'AuthenticationError: 429 rate limit',
    errorStatus: healthy ? null : 429,
    ...overrides,
  };
}

function history(observations: GatewayDeploymentObservation[]): GatewayDeploymentHistory {
  const dates = observations.map((entry) => entry.date).sort();
  return {
    from: dates[0] ?? '2026-07-01',
    to: dates[dates.length - 1] ?? '2026-07-14',
    recordingSince: dates[0] ?? null,
    observations,
  };
}

const D = (offset: number) => shiftIso('2026-07-20', offset);

// ==================================================================== pure half

// ------------------------------------- 1. a deployment that never faltered
{
  const summary = summarizeDeploymentHistory(
    history([reading(D(0), true), reading(D(1), true), reading(D(2), true)]),
  );
  const row = summary.deployments[0];
  check(summary.deployments.length === 1, 'one deployment, one row');
  check(row?.readings === 3, 'three readings must be counted as three');
  check(row?.failingReadings === 0, 'a healthy deployment has no failing readings');
  check(row?.failingShare === 0, 'a healthy deployment fails at none of its readings');
  check(row?.transitions === 0, 'a deployment that never changed state has no transitions');
  check(row?.outages.length === 0, 'a healthy deployment has no runs');
  check(row?.standing === null && row?.longest === null, 'nothing standing, nothing longest');
  check(row?.lastHealthy === true, 'the newest reading was healthy');
  check(
    row?.newlyFailing === false && row?.recovered === false,
    'a deployment that never changed state neither broke nor recovered',
  );
  check(summary.outages === 0 && summary.standing.length === 0, 'no runs gateway-wide');
}

// ------------------------------- 2. one closed episode, and what it implies
{
  const summary = summarizeDeploymentHistory(
    history([
      reading(D(0), true),
      reading(D(1), false),
      reading(D(2), false),
      reading(D(3), true),
      reading(D(4), true),
    ]),
  );
  const row = summary.deployments[0];
  const outage = row?.outages[0];
  check(row?.outages.length === 1, 'two consecutive failing readings are one run');
  check(outage?.readings === 2, 'the run holds two failing readings');
  check(outage?.from === D(1) && outage?.to === D(2), 'the run is bounded by the days it was seen');
  check(outage?.unobservedDays === 0, 'a contiguous run has no unobserved days inside it');
  check(outage?.open === false, 'an observed recovery closes the run');
  check(row?.transitions === 2, 'broke once and recovered once is two transitions');
  check(row?.standing === null, 'a run that closed is not standing');
  check(row?.longest?.readings === 2, 'the only run is the longest one');
  check(row?.failingReadings === 2 && row?.readings === 5, '2 of 5 readings failed');
  check(
    Math.abs((row?.failingShare ?? 0) - 0.4) < 1e-9,
    'the share is over readings: 2 of 5 is 0.4',
  );
  check(
    row?.recovered === false,
    'recovered describes the newest reading, not any recovery in the window',
  );
  check(summary.standing.length === 0, 'a closed episode is nobody current problem');
}

// ----------------------------------- 3. recovered, at the newest reading only
{
  const summary = summarizeDeploymentHistory(
    history([reading(D(0), false), reading(D(1), false), reading(D(2), true)]),
  );
  const row = summary.deployments[0];
  check(row?.recovered === true, 'failing at the previous reading and healthy at the newest');
  check(row?.newlyFailing === false, 'a recovery is not a break');
  check(row?.standing === null, 'nothing is open once the newest reading is healthy');
}

// -------------------------------------------- 4. a standing fault, and its gate
{
  const failing = [D(0), D(1), D(2), D(3)].map((date) => reading(date, false));
  const summary = summarizeDeploymentHistory(history(failing));
  const row = summary.deployments[0];
  check(row?.standing?.open === true, 'the newest reading is failing, so the run is open');
  check(row?.standing?.readings === 4, 'four consecutive failing readings');
  check(
    summary.standing.length === 1,
    `four readings clears the ${STANDING_OUTAGE_READINGS}-reading standing gate`,
  );
  check(row?.transitions === 0, 'a deployment failing throughout never changed state');
  check(row?.newlyFailing === false, 'it was already failing at the previous reading');
}

// ------------------------- 5. one failing reading is a finding, not a fault
{
  const summary = summarizeDeploymentHistory(
    history([reading(D(0), true), reading(D(1), true), reading(D(2), false)]),
  );
  const row = summary.deployments[0];
  check(row?.standing?.readings === 1, 'the open run holds the single failing reading');
  check(
    summary.standing.length === 0,
    'one failing reading must not be reported as a standing fault',
  );
  check(row?.newlyFailing === true, 'healthy at the previous reading, failing at the newest');
}

// ------------------------------- 6. a gap inside a run neither splits nor fills it
{
  const summary = summarizeDeploymentHistory(
    history([reading(D(0), false), reading(D(2), false), reading(D(3), false)]),
  );
  const row = summary.deployments[0];
  const outage = row?.outages[0];
  check(row?.outages.length === 1, 'a day nobody observed must not split one run into two');
  check(outage?.readings === 3, 'the run counts the readings it has, not the days it spans');
  check(outage?.unobservedDays === 1, 'the unobserved day is reported inside the run');
  check(row?.readings === 3, 'a missing day is not a reading');
  check(
    summary.observedDays.length === 3 && !summary.observedDays.includes(D(1)),
    'an unobserved day must not appear among the observed ones',
  );
}

// ------------------- 7. an observed recovery *does* split it — the negative case
{
  const summary = summarizeDeploymentHistory(
    history([
      reading(D(0), false),
      reading(D(1), true),
      reading(D(2), false),
      reading(D(3), false),
    ]),
  );
  const row = summary.deployments[0];
  check(row?.outages.length === 2, 'an observed healthy reading between two failures is two runs');
  check(row?.transitions === 2, 'fail, recover, fail is two state changes');
  check(row?.longest?.readings === 2, 'the longest run is the later two-reading one');
  check(
    summary.flapping.length === 1,
    `${FLAPPING_OUTAGES} distinct episodes make a deployment intermittent`,
  );
  check(row?.standing?.from === D(2), 'the open run starts at the second break');
}

// --------------------------------------- 8. errors are deduplicated per run
{
  const summary = summarizeDeploymentHistory(
    history([
      reading(D(0), false, { error: 'Timeout' }),
      reading(D(1), false, { error: 'Timeout' }),
      reading(D(2), false, { error: 'ConnectionError' }),
      reading(D(3), false, { error: null }),
      reading(D(4), false, { error: '' }),
    ]),
  );
  const outage = summary.deployments[0]?.outages[0];
  check(
    outage?.errors.length === 2 && outage.errors[0] === 'Timeout',
    'the same message three nights running is one fault, and a blank one is not a message',
  );
  check(outage?.readings === 5, 'a reading with no error text is still a failing reading');
}

// ------------------------------------------- 9. an alias change is recorded
{
  const summary = summarizeDeploymentHistory(
    history([
      reading(D(0), true, { model: 'gpt-4o' }),
      reading(D(1), true, { model: 'gpt-4o-latest' }),
    ]),
  );
  const row = summary.deployments[0];
  check(row?.renamed === true, 'the alias this deployment served changed inside the window');
  check(row?.model === 'gpt-4o-latest', 'the row carries the alias as of the newest reading');
}

// -------------------------------- 10. the gateway-wide day rollup and ordering
{
  const summary = summarizeDeploymentHistory(
    history([
      // A pool of three: one failing throughout, one that broke last night, one fine.
      ...[D(0), D(1), D(2), D(3)].map((date) =>
        reading(date, false, { id: 'dep-standing', backend: 'azure/gpt-4o-ptu' }),
      ),
      ...[D(0), D(1), D(2)].map((date) =>
        reading(date, true, { id: 'dep-broke', backend: 'bedrock/nova' }),
      ),
      reading(D(3), false, { id: 'dep-broke', backend: 'bedrock/nova' }),
      ...[D(0), D(1), D(2), D(3)].map((date) =>
        reading(date, true, { id: 'dep-fine', backend: 'azure/gpt-4o-paygo' }),
      ),
    ]),
  );

  check(summary.days.length === 4, 'four observed days');
  check(
    summary.days.every((day) => day.deployments === 3),
    'every observed day saw all three deployments',
  );
  check(
    summary.days[0]?.unhealthy === 1 && summary.days[3]?.unhealthy === 2,
    'the day rollup counts the failing deployments of that day',
  );
  check(
    summary.days.map((day) => day.date).join(',') === [D(0), D(1), D(2), D(3)].join(','),
    'days ascend',
  );
  check(
    summary.deployments[0]?.id === 'dep-standing',
    'a standing fault sorts above a deployment that merely broke last night',
  );
  check(
    summary.deployments[1]?.id === 'dep-broke' && summary.deployments[2]?.id === 'dep-fine',
    'below the standing rows, more failing readings sorts higher',
  );
  check(summary.outages === 2, 'two runs across the pool');
  check(summary.standing.length === 1, 'only the four-reading run is standing');
  check(summary.flapping.length === 0, 'one episode each is not flapping');
}

// -------------------------------------------------- 11. the empty window
{
  const summary = summarizeDeploymentHistory({
    from: D(0),
    to: D(3),
    recordingSince: null,
    observations: [],
  });
  check(
    summary.deployments.length === 0 && summary.days.length === 0 && summary.outages === 0,
    'a window with no readings derives nothing rather than an all-healthy gateway',
  );
  check(summary.recordingSince === null, 'nothing recorded means no recording start');
}

// ------------------------------ 12. a deployment absent from the window
{
  const summary = summarizeDeploymentHistory(
    history([
      reading(D(0), true, { id: 'dep-a' }),
      reading(D(1), true, { id: 'dep-a' }),
      reading(D(0), false, { id: 'dep-retired' }),
    ]),
  );
  const retired = summary.deployments.find((entry) => entry.id === 'dep-retired');
  check(retired?.readings === 1, 'a deployment the router dropped keeps the readings it had');
  check(
    retired?.lastSeen === D(0),
    'and its last reading stays where it was rather than following the window',
  );
  check(
    summary.days[1]?.deployments === 1,
    'the day after it vanished saw one deployment, not two — nothing is carried forward',
  );
}

console.log(`pure derivation: ${failures.length === 0 ? 'ok' : `${failures.length} failure(s)`}`);

// ============================================================== Postgres half

const client = createGatewayClient();
const [anyDeployment] = await db.select().from(gatewayDeploymentHealth).limit(1);

if (client === null) {
  console.log('\nGATEWAY_SOURCE is off — skipping the database half.');
} else if (anyDeployment === undefined) {
  console.log('\nNo deployment health stored — run a gateway sync first; skipping the database half.');
} else {
  const today = new Date().toISOString().slice(0, 10);

  // --------------------------------- 13. a full sync files exactly one day
  {
    const job = await startGatewaySync();
    const settled = await waitForJob(job.id);
    check(settled?.status === 'succeeded', `the gateway sync did not succeed: ${settled?.status}`);

    const snapshot = await getGatewayHealth();
    const todayRows = await db
      .select()
      .from(gatewayDeploymentHealthHistory)
      .where(eq(gatewayDeploymentHealthHistory.date, today));

    check(
      todayRows.length === snapshot.deployments.length,
      `today's record holds ${todayRows.length} rows against ${snapshot.deployments.length} deployments`,
    );

    // Both came out of the same fetch, so they must agree exactly — including
    // the resolved alias, which is stored rather than joined precisely so that
    // a later re-alias cannot rewrite what was seen.
    const recorded = new Map(todayRows.map((row) => [row.id, row]));
    for (const deployment of snapshot.deployments) {
      const row = recorded.get(deployment.id);
      if (row === undefined) {
        check(false, `${deployment.id} is in the snapshot but not in today's record`);
        continue;
      }
      check(row.healthy === deployment.healthy, `${deployment.id}: recorded state disagrees`);
      check(row.model === deployment.model, `${deployment.id}: recorded alias disagrees`);
      check(row.backend === deployment.backend, `${deployment.id}: recorded backend disagrees`);
      check(
        (row.error === null) === (deployment.error === null),
        `${deployment.id}: an error text must not appear or vanish in the record`,
      );
    }
    check(
      todayRows.some((row) => !row.healthy),
      'the mock plants a failing deployment — the record must have kept it',
    );

    // A second sync the same day updates the day's reading rather than adding
    // one: the table grows with the calendar, not with the scheduler.
    const before = todayRows.length;
    const second = await startGatewaySync();
    await waitForJob(second.id);
    const after = await db
      .select()
      .from(gatewayDeploymentHealthHistory)
      .where(eq(gatewayDeploymentHealthHistory.date, today));
    check(
      after.length === before,
      `a second sync the same day added rows (${before} → ${after.length}) — the day key is not doing its job`,
    );
  }

  // ------------------------- 14. a ranged backfill files no reading at all
  {
    const before = await db.select().from(gatewayDeploymentHealthHistory);
    const job = await startGatewaySync({ from: shiftIso(today, -4), to: shiftIso(today, -3) });
    const settled = await waitForJob(job.id);
    check(settled?.status === 'succeeded', `the backfill did not succeed: ${settled?.status}`);
    const after = await db.select().from(gatewayDeploymentHealthHistory);
    check(
      after.length === before.length,
      `a ranged backfill filed ${after.length - before.length} health readings — it never calls /health and must record none`,
    );
  }

  // ------------- 15. the read route and the derivation over real stored rows
  {
    // Deliberately a deployment that is healthy *today*: the run planted below
    // then has today's real reading after it, so what closes it is a fact from
    // the database rather than a constructed one.
    const stored = await db.select().from(gatewayDeploymentHealth);
    const target = stored.find((row) => row.healthy);
    if (target === undefined) {
      console.log('No healthy deployment stored — skipping the planted-history section.');
    } else {
      // Five days a sync run on those days would have written: a healthy
      // stretch, a break that is still open at the newest planted day, and one
      // day nobody looked. Today's real row (written above) sits after them.
      const planted: { date: string; healthy: boolean }[] = [
        { date: shiftIso(today, -8), healthy: true },
        { date: shiftIso(today, -7), healthy: true },
        // -6 deliberately absent: the scheduler did not run.
        { date: shiftIso(today, -5), healthy: false },
        { date: shiftIso(today, -4), healthy: false },
        { date: shiftIso(today, -3), healthy: false },
      ];
      const dates = planted.map((entry) => entry.date);

      // Refusing rather than checking afterwards: a post-hoc comparison cannot
      // undo a real reading this script has already deleted.
      const occupied = await db
        .select()
        .from(gatewayDeploymentHealthHistory)
        .where(
          and(
            eq(gatewayDeploymentHealthHistory.id, target.id),
            inArray(gatewayDeploymentHealthHistory.date, dates),
          ),
        );
      if (occupied.length > 0) {
        console.log(
          `${occupied.length} real reading(s) already occupy the planted days — skipping the planted-history section.`,
        );
      } else {
        await db.insert(gatewayDeploymentHealthHistory).values(
          planted.map((entry) => ({
            id: target.id,
            date: entry.date,
            backend: target.backend,
            model: target.model,
            provider: target.provider,
            healthy: entry.healthy,
            error: entry.healthy ? null : 'ServiceUnavailableError: 503',
            errorStatus: entry.healthy ? null : 503,
            observedAt: new Date(`${entry.date}T07:00:00.000Z`),
          })),
        );

        try {
          const read = await getGatewayDeploymentHistory(30);
          check(read.from <= dates[0]!, 'a 30-day window must reach the planted days');
          check(read.recordingSince !== null, 'recording has started, so the route must say when');
          check(
            read.observations.every((entry) => entry.date >= read.from && entry.date <= read.to),
            'the route must not answer outside its own window',
          );

          const summary = summarizeDeploymentHistory(read);
          const row = summary.deployments.find((entry) => entry.id === target.id);
          check(row !== undefined, 'the planted deployment must appear in the derivation');
          // Five planted readings plus today's real one, which the sync above
          // wrote from the live snapshot.
          check(
            (row?.readings ?? 0) >= planted.length,
            `the planted readings survived the round trip (${row?.readings} read)`,
          );
          const plantedRun = row?.outages.find((outage) => outage.from === dates[2]);
          check(plantedRun?.readings === 3, 'the three planted failing readings are one run');
          check(
            plantedRun?.unobservedDays === 0,
            'the planted failures are contiguous — the gap sits before them, not inside',
          );
          check(
            row?.outages.every((outage) => outage.from !== dates[1]) === true,
            'the unobserved day must not start a run of its own',
          );
          // What closes the run is today's real reading, not a constructed one —
          // which is what makes this a round trip rather than a repeat of the
          // pure half.
          check(row?.lastHealthy === true, 'the chosen deployment is healthy at its newest reading');
          check(plantedRun?.open === false, "today's real healthy reading closed the planted run");
          check(
            row?.recovered === true,
            'failing at the previous reading and healthy at the newest is a recovery',
          );
          check(
            read.observations.some(
              (entry) => entry.id === target.id && entry.errorStatus === 503,
            ),
            'the planted upstream status survived the round trip',
          );
        } finally {
          await db
            .delete(gatewayDeploymentHealthHistory)
            .where(
              and(
                eq(gatewayDeploymentHealthHistory.id, target.id),
                inArray(gatewayDeploymentHealthHistory.date, dates),
              ),
            );
        }

        const leftovers = await db
          .select()
          .from(gatewayDeploymentHealthHistory)
          .where(
            and(
              eq(gatewayDeploymentHealthHistory.id, target.id),
              inArray(gatewayDeploymentHealthHistory.date, dates),
            ),
          );
        check(leftovers.length === 0, 'the planted rows were not cleaned up');
      }
    }
  }
}

/** Poll a job row until it settles — `startJob` runs the work in the background. */
async function waitForJob(id: string) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
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
console.log('\nall gateway deployment health history checks passed');
process.exit(0);
