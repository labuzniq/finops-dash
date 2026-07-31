/**
 * Ad-hoc check of the web app's *deployment health history* view — the card
 * that reads the nightly `/health` readings as a sequence. Not a test suite (the
 * repo has none) — run it by hand, with the API's env loaded for the Postgres
 * section:
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-health-history-view.ts
 *
 * `verify-gateway-health-history.ts` already covers the recording and the shared
 * `summarizeDeploymentHistory` rule — that a run is broken by an observed
 * recovery and by nothing else, that a single failing reading is not a standing
 * fault, that a backfill files nothing. This script covers only what the *view*
 * adds on top, which is four things and no rule about the gateway at all:
 *
 *  - **the spine**, clamped forward to `recordingSince`. There is no backfill for
 *    this table, so a 60-day window on a four-day recording is drawn as four
 *    days rather than as 56 nights nobody looked.
 *  - **three states per cell.** A day with no reading is a hole. This is the one
 *    place the distinction would be invisible to a reader, because a green cell
 *    and an unread night look equally reassuring in a strip.
 *  - **`tooShort`.** Below `STANDING_OUTAGE_READINGS` recorded days, "nothing is
 *    standing" is a statement about how long this dashboard has been watching.
 *    Asserted on both sides of its boundary, like the staleness flag in
 *    `verify-gateway-health-view.ts`.
 *  - **the verdict**, which is display ordering over the shared derivation and
 *    must never disagree with it: a row is `standing` exactly when the shared
 *    summary lists it as standing, and the row order is the shared order.
 *
 * The Postgres half runs the same derivation over what a sync actually stored,
 * which is what proves the cells line up with the spine on real rows and that
 * today's history agrees with today's snapshot — two tables, one reading.
 */
import { STANDING_OUTAGE_READINGS, summarizeDeploymentHistory } from '@dash/shared';
import type { GatewayDeploymentHistory, GatewayDeploymentObservation } from '@dash/shared';
import { getGatewayDeploymentHistory, getGatewayHealth } from '../src/services/gateway.js';
import {
  deriveHealthHistory,
  hasHealthHistory,
  HEALTH_HISTORY_DAYS,
} from '../../web/src/lib/metrics/gatewayHealthHistory.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};

function shiftIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const D = (offset: number) => shiftIso('2026-07-20', offset);

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
    error: healthy ? null : 'litellm.APIError: 429 rate limit on PTU pool',
    errorStatus: healthy ? null : 429,
    ...overrides,
  };
}

/** A window that exactly spans the readings, recording since the first of them. */
function history(
  observations: GatewayDeploymentObservation[],
  overrides: Partial<GatewayDeploymentHistory> = {},
): GatewayDeploymentHistory {
  const dates = observations.map((entry) => entry.date).sort();
  return {
    from: dates[0] ?? D(0),
    to: dates[dates.length - 1] ?? D(0),
    recordingSince: dates[0] ?? null,
    observations,
    ...overrides,
  };
}

// ==================================================================== pure half

console.log('\nsilence, and the two ways of having nothing to show');
{
  const unanswered = deriveHealthHistory(null);
  check(!unanswered.answered, 'a query in flight has not answered');
  check(!unanswered.isEmpty, 'a query in flight is not an empty recording');
  check(!unanswered.tooShort, 'a query in flight makes no claim about the window length');
  check(unanswered.rows.length === 0 && unanswered.dates.length === 0, 'nothing to draw yet');
  check(!hasHealthHistory(unanswered), 'the page stands the card down until the query answers');

  const empty = deriveHealthHistory({
    from: D(0),
    to: D(5),
    recordingSince: null,
    observations: [],
  });
  check(empty.answered && empty.isEmpty, 'an answered empty recording is a different state');
  check(
    empty.tooShort,
    'no reading at all is too short to tell — never a gateway with nothing wrong',
  );
  check(empty.standing === 0 && empty.rows.length === 0, 'an empty recording finds nothing');
  check(!hasHealthHistory(empty), 'the page stands the card down on an empty recording');
}

console.log('\nthe spine is clamped forward to recordingSince, never padded backwards');
{
  const view = deriveHealthHistory(
    history([reading(D(0), true), reading(D(1), true), reading(D(2), true)], {
      from: shiftIso(D(0), -50),
      to: D(2),
      recordingSince: D(0),
    }),
  );
  check(view.from === shiftIso(D(0), -50), 'the window asked for is reported as asked for');
  check(view.spineFrom === D(0), 'the drawn spine starts at the first reading ever filed');
  check(view.dates.length === 3, 'a 53-day window on a 3-day recording draws three days');
  check(view.dates[0] === D(0) && view.dates[2] === D(2), 'the spine is ascending and inclusive');
  check(view.daysMissed === 0, 'a fully-recorded spine has missed no night');

  const older = deriveHealthHistory(
    history([reading(D(0), true), reading(D(1), true)], {
      from: D(0),
      to: D(1),
      recordingSince: shiftIso(D(0), -90),
    }),
  );
  check(
    older.spineFrom === D(0),
    'a recording older than the window does not stretch the spine backwards',
  );
}

console.log('\nthree states per cell: an unread night is a hole, never a healthy day');
{
  const view = deriveHealthHistory(
    history([reading(D(0), true), reading(D(2), false)], { from: D(0), to: D(2) }),
  );
  const row = view.rows[0];
  check(row?.cells.length === 3, 'one cell per day of the drawn spine');
  check(row?.cells[0]?.state === 'healthy', 'a reading that answered is healthy');
  check(row?.cells[1]?.state === 'unobserved', 'a day with no reading is unobserved');
  check(row?.cells[2]?.state === 'failing', 'a reading that refused is failing');
  check(row?.cells[1]?.error === null, 'an unread night carries no error text');
  check(
    row?.cells[2]?.error === 'litellm.APIError: 429 rate limit on PTU pool',
    "a failing cell carries the proxy's own text",
  );
  check(
    row?.cells.filter((cell) => cell.state !== 'unobserved').length === row?.readings,
    'the drawn cells that are not holes are exactly the readings counted',
  );
  check(view.daysRecorded === 2 && view.daysMissed === 1, 'the missed night is counted as missed');
  check(
    view.days[1]?.observed === false && view.days[1]?.deployments === 0,
    'the gateway-wide strip has the same hole rather than a zero-failure night',
  );
}

console.log('\ntooShort is a fact about the recording, not about the gateway');
{
  const two = deriveHealthHistory(history([reading(D(0), true), reading(D(1), true)]));
  check(two.daysRecorded === 2 && two.tooShort, `${STANDING_OUTAGE_READINGS - 1} days is too short`);
  const three = deriveHealthHistory(
    history([reading(D(0), true), reading(D(1), true), reading(D(2), true)]),
  );
  check(
    three.daysRecorded === STANDING_OUTAGE_READINGS && !three.tooShort,
    `${STANDING_OUTAGE_READINGS} days is the first window that can hold a standing run`,
  );
  check(
    three.standing === 0 && three.rows[0]?.verdict === 'clear',
    'and only then does "none standing" mean the gateway is clean',
  );
}

console.log('\nverdicts follow the shared derivation and never re-decide it');
{
  const standing = deriveHealthHistory(
    history([
      reading(D(0), true),
      reading(D(1), false),
      reading(D(2), false),
      reading(D(3), false),
    ]),
  );
  const standingRow = standing.rows[0];
  check(standingRow?.verdict === 'standing', 'three failing readings running is a standing fault');
  check(standingRow?.isStanding === true, 'and the row says so on its own');
  check(
    standing.standing === 1 && standing.summary.standing.length === 1,
    'the view repeats the shared count rather than computing a second one',
  );
  check(standingRow?.standing?.readings === 3, 'the open run is measured in readings');

  const short = deriveHealthHistory(
    history([reading(D(0), true), reading(D(1), true), reading(D(2), false), reading(D(3), false)]),
  );
  check(
    short.rows[0]?.verdict === 'failing' && short.rows[0]?.isStanding === false,
    'two failing readings is failing now, not yet a standing fault',
  );
  check(short.standing === 0, 'and it is not counted as one');
  check(short.newlyFailing === 0, 'newly-failing means the previous reading was healthy');

  const newly = deriveHealthHistory(
    history([reading(D(0), true), reading(D(1), true), reading(D(2), false)]),
  );
  check(newly.newlyFailing === 1, 'healthy at the previous reading and failing at the newest');

  const flapping = deriveHealthHistory(
    history([
      reading(D(0), false),
      reading(D(1), true),
      reading(D(2), false),
      reading(D(3), true),
    ]),
  );
  check(flapping.rows[0]?.verdict === 'flapping', 'two distinct episodes is intermittent');
  check(flapping.flapping === 1 && flapping.outages === 2, 'both episodes are counted as episodes');
  check(
    // Four readings make three consecutive pairs, and this deployment changed
    // state at every one of them.
    flapping.rows[0]?.transitions === 3,
    'every state change between consecutive readings is a transition',
  );

  const recovered = deriveHealthHistory(
    history([reading(D(0), true), reading(D(1), false), reading(D(2), true)]),
  );
  check(recovered.rows[0]?.verdict === 'recovered', 'failing then answering is a recovery');
  check(recovered.recovered === 1, 'and it is counted');

  const past = deriveHealthHistory(
    history([reading(D(0), false), reading(D(1), true), reading(D(2), true)]),
  );
  check(
    past.rows[0]?.verdict === 'past',
    'an episode further back with no recovery at the newest reading is history',
  );
  check(past.recovered === 0, 'a recovery two readings ago is not a recovery now');
}

console.log('\nnothing is a duration: an unread night inside a run is reported, never counted');
{
  // Failing on the 20th and the 24th with nothing in between. Five calendar
  // days, two readings — the run must say two.
  const view = deriveHealthHistory(
    history([reading(D(0), false), reading(D(4), false)], { from: D(0), to: D(4) }),
  );
  const row = view.rows[0];
  check(row?.standing?.readings === 2, 'a five-day span with two readings is two readings');
  check(row?.standing?.unobservedDays === 3, 'the three unread nights are reported inside the run');
  check(row?.standing?.open === true, 'the run reaches the newest reading, so it is open');
  check(
    row?.outages.length === 1,
    'the unread nights did not split one run into two — that would assert a recovery nobody saw',
  );
  check(row?.readings === 2 && row?.failingReadings === 2, 'both readings said failing');
  check(
    row?.failingShare === row!.failingReadings / row!.readings,
    'the share is failing readings over readings, never a share of time',
  );
  check(row?.unobservedDays === 3, "the row counts the unread nights inside its own span");
  check(
    row?.cells.filter((cell) => cell.state === 'unobserved').length === 3,
    'and the strip draws them as three holes',
  );
}

console.log('\ntwo deployments: rollups, ordering and a span that starts late');
{
  const other = (date: string, healthy: boolean): GatewayDeploymentObservation =>
    reading(date, healthy, {
      id: 'dep-2',
      backend: 'bedrock/amazon.nova-pro-v1:0',
      model: 'nova-pro',
      provider: 'bedrock',
    });

  const view = deriveHealthHistory(
    history([
      reading(D(0), true),
      reading(D(1), false),
      reading(D(2), false),
      reading(D(3), false),
      // Only appeared on the router two days into the window.
      other(D(2), true),
      other(D(3), true),
    ]),
  );

  check(view.rows.length === 2, 'one row per deployment seen in the window');
  check(view.rows[0]?.id === 'dep-1', 'the standing fault is first whatever the window');
  check(
    view.rows.map((row) => row.id).join(',') ===
      view.summary.deployments.map((row) => row.id).join(','),
    'the view keeps the shared ordering rather than re-sorting',
  );
  check(
    view.days[3]?.deployments === 2 && view.days[3]?.unhealthy === 1,
    'the gateway-wide day rolls up both deployments and counts one failing',
  );
  check(view.days[0]?.deployments === 1, 'a day before the second deployment existed counts one');

  const late = view.rows.find((row) => row.id === 'dep-2');
  check(late?.readings === 2, 'the late deployment carries its own two readings');
  check(
    late?.unobservedDays === 0,
    'a deployment the router only gained on day three has no missing readings before it existed',
  );
  check(
    late?.cells[0]?.state === 'unobserved' && late?.cells[2]?.state === 'healthy',
    'its cells still span the shared spine, so the rows stack',
  );
  check(hasHealthHistory(view), 'the card draws once there is a row');
}

console.log('\na re-aliased deployment reads as the change it was');
{
  const view = deriveHealthHistory(
    history([
      reading(D(0), true, { model: 'gpt-4o' }),
      reading(D(1), true, { model: 'gpt-4o-mini' }),
      reading(D(2), true, { model: 'gpt-4o-mini' }),
    ]),
  );
  check(view.renamed === 1, 'the alias changed inside the window');
  check(view.rows[0]?.model === 'gpt-4o-mini', 'the row is labelled with the newest alias');
  check(view.rows[0]?.verdict === 'clear', 'a rename is not a fault');
}

// =============================================================== postgres half

console.log('\nover what a sync actually stored');
{
  const stored = await getGatewayDeploymentHistory(HEALTH_HISTORY_DAYS);
  if (stored.observations.length === 0) {
    console.log(
      '  SKIP  no deployment health history stored locally — run a full gateway sync first',
    );
  } else {
    const view = deriveHealthHistory(stored);
    const shared = summarizeDeploymentHistory(stored);

    check(view.answered && !view.isEmpty, 'a stored recording answers and is not empty');
    check(
      view.rows.length === shared.deployments.length &&
        view.standing === shared.standing.length &&
        view.flapping === shared.flapping.length &&
        view.outages === shared.outages,
      'every gateway claim on the card is the shared derivation verbatim',
    );
    check(
      view.dates.length > 0 && view.dates[view.dates.length - 1] === stored.to,
      'the spine ends on the day the route was asked about',
    );
    check(
      stored.recordingSince === null || view.spineFrom >= stored.recordingSince,
      'the spine never starts before the first reading ever filed',
    );
    check(
      view.rows.every((row) => row.cells.length === view.dates.length),
      'every row is drawn against the same spine',
    );
    check(
      view.rows.every(
        (row) => row.cells.filter((cell) => cell.state !== 'unobserved').length === row.readings,
      ),
      'and every drawn cell that is not a hole is a reading that was actually filed',
    );
    check(
      view.daysRecorded + view.daysMissed === view.dates.length,
      'every day of the spine is either recorded or missed, and never both',
    );
    check(
      view.rows.every((row) => row.failingReadings <= row.readings),
      'a deployment cannot fail more readings than it has',
    );

    // Two tables, one reading: the snapshot the sync replaced and the row it
    // appended on the same day have to agree about who was failing.
    const snapshot = await getGatewayHealth();
    const snapshotDay = snapshot.checkedAt === null ? null : snapshot.checkedAt.slice(0, 10);
    const newestDay = view.dates.filter((date) => view.days.find((day) => day.date === date)?.observed).pop() ?? null;
    if (snapshotDay === null || snapshotDay !== newestDay) {
      console.log(
        `  SKIP  the snapshot (${snapshotDay ?? 'never'}) and the newest reading (${newestDay ?? 'none'}) are different days`,
      );
    } else {
      const snapshotFailing = snapshot.deployments
        .filter((deployment) => !deployment.healthy)
        .map((deployment) => deployment.id)
        .sort();
      const historyFailing = view.rows
        .filter((row) => row.cells.find((cell) => cell.date === snapshotDay)?.state === 'failing')
        .map((row) => row.id)
        .sort();
      check(
        snapshotFailing.join(',') === historyFailing.join(','),
        "today's stored snapshot and today's appended readings name the same failing deployments",
      );
      const day = view.days.find((entry) => entry.date === snapshotDay);
      check(
        day?.deployments === snapshot.deployments.length,
        'and the day rollup counts every deployment the snapshot holds',
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nall gateway health history view checks passed');
process.exit(0);
