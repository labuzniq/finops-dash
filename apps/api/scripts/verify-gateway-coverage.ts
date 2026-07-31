/**
 * Ad-hoc check of the gateway coverage read — what the dashboard has stored, as
 * opposed to what the proxy can still be asked for. Run it by hand:
 *
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-coverage.ts
 *
 * It sits outside apps/api's tsconfig `include` like the other gateway verify
 * scripts, because it imports the web app's chargeback module to prove the one
 * consequence that matters: a floor taken from the stored history offers months
 * a floor taken from the proxy's retention window refuses.
 *
 * Coverage is not a metric, so there is nothing to reconcile here. What there
 * is, is arithmetic that is easy to get subtly wrong and impossible to notice:
 *
 * - the span identity `storedDays + missingDays == spanDays`, which is the only
 *   thing standing between "eleven days missing" and a number nobody can act on;
 * - gaps as *runs* rather than as loose dates, newest first, with the truncation
 *   flag telling the difference between a complete list and a sample;
 * - `daysBeyondRetention` counting only what the proxy has genuinely pruned —
 *   history that exists here and nowhere else, and is therefore the part of the
 *   range no future sync can correct;
 * - the empty table answering with the retention floor rather than with null, so
 *   a fresh install clamps exactly as it did before this route existed;
 * - and the consequence: `chargebackMonths` and the range picker reach further
 *   back on a stored floor than on a retention floor, which is the entire point.
 *
 * The mock client is driven at the end to confirm the ordinary case is silent:
 * a normal 90-day sync writes one row per day with no gaps at all, so a healthy
 * gateway renders no coverage note.
 */
import { GATEWAY_RETENTION_DAYS, summarizeGatewayCoverage } from '@dash/shared';
import { MockGatewayClient } from '../src/gateway/mock.js';
import { chargebackMonths } from '../../web/src/lib/metrics/gatewayChargeback.js';

const MS_PER_DAY = 86_400_000;

/** A fixed "today" — the retention floor moves at midnight and assertions must not. */
const TODAY = '2026-07-31';

function iso(from: string, offsetDays: number): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) + offsetDays * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/** Every day in an inclusive range, ascending — what the table looks like unbroken. */
function span(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = iso(day, 1)) days.push(day);
  return days;
}

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

// --------------------------------------------------------- 1. the empty table

{
  const coverage = summarizeGatewayCoverage([], TODAY);
  check(coverage.firstDay === null, 'an empty table reports a first day');
  check(coverage.lastDay === null, 'an empty table reports a last day');
  check(coverage.storedDays === 0, 'an empty table stores days');
  check(coverage.spanDays === 0, 'an empty table spans days');
  check(coverage.missingDays === 0, 'an empty table is missing days');
  check(coverage.gaps.length === 0, 'an empty table has gaps');
  check(coverage.daysBeyondRetention === 0, 'an empty table holds history');
  // The load-bearing one: a fresh install must clamp exactly as it did before
  // this route existed, or the picker offers a range with nothing behind it.
  check(
    coverage.floor === coverage.retentionFloor,
    `an empty table floors at ${coverage.floor}, not at the retention floor`,
  );
  check(
    coverage.retentionFloor === '2026-05-02',
    `retention floor is ${coverage.retentionFloor}, not the first day the sync pulls`,
  );
  check(
    coverage.retentionDays === GATEWAY_RETENTION_DAYS,
    'retention days does not match the shared constant',
  );
}

// ------------------------------------------------- 2. an unbroken 90-day pull

{
  const days = span('2026-05-02', '2026-07-30');
  const coverage = summarizeGatewayCoverage(days, TODAY);
  check(coverage.storedDays === 90, `stored ${coverage.storedDays} days, expected 90`);
  check(coverage.spanDays === 90, `span of ${coverage.spanDays} days, expected 90`);
  check(coverage.missingDays === 0, `${coverage.missingDays} days missing from an unbroken pull`);
  check(coverage.gaps.length === 0, 'an unbroken pull reports gaps');
  check(coverage.daysBeyondRetention === 0, 'an in-retention pull reports archived history');
  check(coverage.floor === '2026-05-02', `floor is ${coverage.floor}, not the first stored day`);
  check(coverage.firstDay === '2026-05-02' && coverage.lastDay === '2026-07-30', 'wrong bounds');
}

// ------------------------------------------------------------------ 3. gaps

{
  // Three runs of different lengths, so ordering and length are both testable:
  // 2026-05-10 (one day), 2026-06-01…06-07 (seven), 2026-07-20…07-21 (two).
  const days = [
    ...span('2026-05-02', '2026-05-09'),
    ...span('2026-05-11', '2026-05-31'),
    ...span('2026-06-08', '2026-07-19'),
    ...span('2026-07-22', '2026-07-30'),
  ];
  const coverage = summarizeGatewayCoverage(days, TODAY);

  check(coverage.spanDays === 90, `span of ${coverage.spanDays} days, expected 90`);
  check(coverage.missingDays === 10, `${coverage.missingDays} days missing, expected 10`);
  // The identity that makes the number quotable at all.
  check(
    coverage.storedDays + coverage.missingDays === coverage.spanDays,
    `${coverage.storedDays} + ${coverage.missingDays} !== ${coverage.spanDays}`,
  );
  check(
    coverage.gaps.reduce((sum, gap) => sum + gap.days, 0) === coverage.missingDays,
    'the gap runs do not account for every missing day',
  );

  check(coverage.gaps.length === 3, `${coverage.gaps.length} gap runs, expected 3`);
  // Newest first, matching every other ranked list on the page.
  check(
    coverage.gaps.map((gap) => gap.from).join(',') === '2026-07-20,2026-06-01,2026-05-10',
    `gap runs out of order: ${coverage.gaps.map((gap) => gap.from).join(',')}`,
  );
  check(
    coverage.gaps.map((gap) => gap.days).join(',') === '2,7,1',
    `gap lengths ${coverage.gaps.map((gap) => gap.days).join(',')}, expected 2,7,1`,
  );
  // A one-day run must still carry from === to, or the label reads as a range.
  const single = coverage.gaps[2];
  check(
    single !== undefined && single.from === single.to && single.from === '2026-05-10',
    'the one-day gap is not a single date',
  );
  check(!coverage.gapsTruncated, 'three gaps were reported as truncated');
}

// ---------------------------------------------------- 4. the truncation flag

{
  // Alternate stored/missing so every other day is a gap of its own: 20 runs
  // against a cap of 12. The count must stay complete while the list is a sample.
  const days: string[] = [];
  for (let index = 0; index <= 40; index += 2) days.push(iso('2026-06-01', index));
  const coverage = summarizeGatewayCoverage(days, TODAY);

  check(coverage.storedDays === 21, `stored ${coverage.storedDays}, expected 21`);
  check(coverage.missingDays === 20, `${coverage.missingDays} missing, expected 20`);
  check(coverage.gaps.length === 12, `${coverage.gaps.length} gaps listed, expected the cap of 12`);
  check(coverage.gapsTruncated, 'a truncated gap list did not say so');
  check(
    coverage.storedDays + coverage.missingDays === coverage.spanDays,
    'the span identity breaks once the gap list is truncated',
  );
}

// ------------------------------------------------------ 5. history past retention

{
  // Six months of stored days against a 90-day proxy window: everything before
  // the floor exists here and nowhere else.
  const days = span('2026-02-01', '2026-07-30');
  const coverage = summarizeGatewayCoverage(days, TODAY);

  const beyond = days.filter((day) => day < coverage.retentionFloor).length;
  check(
    coverage.daysBeyondRetention === beyond,
    `${coverage.daysBeyondRetention} days beyond retention, expected ${beyond}`,
  );
  check(
    coverage.daysBeyondRetention === 90,
    `expected 90 archived days, got ${coverage.daysBeyondRetention}`,
  );
  check(
    coverage.floor === '2026-02-01',
    `floor is ${coverage.floor}; stored history must widen it past the retention window`,
  );
  check(coverage.floor < coverage.retentionFloor, 'the stored floor did not outreach retention');

  // The consequence, and the reason the route exists: the statement can bill
  // months the proxy has already forgotten, because the table still holds them.
  const stored = chargebackMonths(TODAY, coverage.floor);
  const retained = chargebackMonths(TODAY, coverage.retentionFloor);
  check(
    stored.length > retained.length,
    `stored floor offers ${stored.length} months, retention floor ${retained.length}`,
  );
  check(
    stored.join(',') === '2026-07,2026-06,2026-05,2026-04,2026-03,2026-02',
    `months offered on the stored floor: ${stored.join(',')}`,
  );
  check(
    retained.join(',') === '2026-07,2026-06',
    `months offered on the retention floor: ${retained.join(',')}`,
  );
  // Never past the first stored day, though — a month whose first day has no
  // row would bill short and look complete.
  check(
    stored.every((month) => `${month}-01` >= coverage.floor),
    'a month starting before the first stored day was offered',
  );
}

// ------------------------------------------------------- 6. degenerate spans

{
  const one = summarizeGatewayCoverage(['2026-07-30'], TODAY);
  check(one.spanDays === 1 && one.storedDays === 1, 'a single stored day does not span one day');
  check(one.missingDays === 0 && one.gaps.length === 0, 'a single stored day reports gaps');
  check(one.floor === '2026-07-30', 'a single stored day floors elsewhere');

  // A month-crossing gap, where a naive day count would be off by the month length.
  const crossing = summarizeGatewayCoverage(['2026-01-31', '2026-03-01'], TODAY);
  check(crossing.missingDays === 28, `${crossing.missingDays} days missing across February 2026`);
  const gap = crossing.gaps[0];
  check(
    gap !== undefined && gap.from === '2026-02-01' && gap.to === '2026-02-28',
    'the February gap has the wrong bounds',
  );

  // Everything stored is older than the window: the whole table is archive.
  const archived = summarizeGatewayCoverage(span('2026-01-01', '2026-01-10'), TODAY);
  check(archived.daysBeyondRetention === 10, 'a wholly pruned range is not wholly archived');
}

// -------------------------------------------- 7. the ordinary case is silent

{
  // What a healthy nightly sync actually writes: the client is asked for the
  // same 90-day window the sync uses, and the dates it answers with are the
  // dates that land in the table.
  const client = new MockGatewayClient();
  const to = iso(TODAY, -1);
  const from = iso(TODAY, -GATEWAY_RETENTION_DAYS);
  const snapshot = await client.fetchUsage(from, to);
  const days = [...new Set(snapshot.daily.map((row) => row.date))].sort();

  const coverage = summarizeGatewayCoverage(days, TODAY);
  check(coverage.missingDays === 0, `a fresh 90-day sync left ${coverage.missingDays} days missing`);
  check(coverage.gaps.length === 0, 'a fresh 90-day sync produced gaps');
  check(coverage.firstDay === from, `first stored day ${coverage.firstDay}, expected ${from}`);
  check(coverage.lastDay === to, `last stored day ${coverage.lastDay}, expected ${to}`);
  // A gateway synced once holds exactly the proxy's window and nothing older,
  // so the note stays silent and the floor lands on the retention floor — the
  // state the page must behave in identically to before this route existed.
  check(
    coverage.daysBeyondRetention === 0,
    `a fresh 90-day sync reports ${coverage.daysBeyondRetention} archived days, expected none`,
  );
  check(
    coverage.floor === from && coverage.floor === coverage.retentionFloor,
    `stored floor ${coverage.floor} does not match the sync window ${from}`,
  );
}

// ------------------------------------------------------------------- verdict

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('\nall gateway coverage checks passed');
