/**
 * Ad-hoc check of the web app's month-end spend forecast against a real
 * mock-source payload. Not a test suite (the repo has none) — run it by hand:
 *
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-forecast.ts
 *
 * The interesting part is a **backtest**: a full past calendar month is pulled
 * once, then replayed day by day as if the month were still running, and each
 * day's projection is scored against the month total that actually happened.
 * That is the only way to claim the weekday-aware projection beats a flat run
 * rate rather than merely to assert it.
 *
 * One pull, sliced — never two. The mock's Lehmer stream is consumed from the
 * window start, so the same calendar date carries different numbers in a 30-day
 * pull and a 59-day one; comparing a forecast from one window against an
 * "actual" from another would be measuring the generator, not the maths.
 *
 * It sits outside apps/api's tsconfig `include` on purpose: it imports the web
 * app's metrics modules, which do not belong in the API's build.
 */
import { MockGatewayClient } from '../src/gateway/mock.js';
import { nanoToDollars } from '../src/lib/nano.js';
import type { GatewayDailyPoint } from '@dash/shared';
import {
  deriveSpendForecast,
  forecastRange,
  weekdayOf,
} from '../../web/src/lib/metrics/gatewayForecast.js';
import type { ForecastRange } from '../../web/src/lib/metrics/gatewayForecast.js';

const MS_PER_DAY = 86_400_000;
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function iso(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
}

const client = new MockGatewayClient();

async function pullDaily(from: string, to: string): Promise<GatewayDailyPoint[]> {
  const snapshot = await client.fetchUsage(from, to);
  return snapshot.daily.map(
    (row): GatewayDailyPoint => ({ ...row, spend: nanoToDollars(row.spendNano) }),
  );
}

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

// ---------------------------------------------------------------- range maths

const today = iso(0);
const current = forecastRange(today);
check(current.monthStart === `${today.slice(0, 7)}-01`, `month start ${current.monthStart}`);
check(current.to === today, 'range must end today');
check(current.from < current.monthStart, 'range must reach back before the month start');
check(
  Math.round((Date.parse(current.monthStart) - Date.parse(current.from)) / MS_PER_DAY) === 28,
  'profile window is not 28 days deep',
);

// Month ends come from Date.UTC(year, month, 0), so February is the real test.
check(forecastRange('2026-02-14').monthEnd === '2026-02-28', 'non-leap February must end on the 28th');
check(forecastRange('2024-02-14').monthEnd === '2024-02-29', 'leap February must end on the 29th');
check(forecastRange('2026-12-31').monthEnd === '2026-12-31', 'December must end on the 31st');
check(forecastRange('2026-04-01').monthEnd === '2026-04-30', 'April must end on the 30th');

// ------------------------------------------------------------------ backtest

// The last full calendar month, so there is a real total to be wrong about.
const lastMonthEnd = new Date(Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`) - MS_PER_DAY)
  .toISOString()
  .slice(0, 10);
const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;
const backtest: ForecastRange = {
  ...forecastRange(lastMonthEnd),
  to: lastMonthEnd,
};

const rows = await pullDaily(backtest.from, lastMonthEnd);
const actual = rows
  .filter((row) => row.date >= lastMonthStart)
  .reduce((total, row) => total + row.spend, 0);
const daysInMonth = Number(lastMonthEnd.slice(8, 10));

console.log(
  `backtest ${lastMonthStart}..${lastMonthEnd} (${daysInMonth}d) actual $${actual.toFixed(2)} · profile from ${backtest.from}`,
);

interface Cut {
  day: number;
  weekdayError: number;
  flatError: number;
  remainingWeekend: number;
}

const cuts: Cut[] = [];

// Replay from the 4th — before that the month to date is noise either way, and
// the card itself says so.
for (let day = 4; day < daysInMonth; day += 1) {
  const cutDate = `${lastMonthStart.slice(0, 8)}${String(day).padStart(2, '0')}`;
  const seen = rows.filter((row) => row.date <= cutDate);
  const forecast = deriveSpendForecast(seen, { ...backtest, to: cutDate });

  if (forecast === null) {
    check(false, `no forecast on day ${day} of a month with data`);
    continue;
  }

  const monthToDate = rows
    .filter((row) => row.date >= lastMonthStart && row.date <= cutDate)
    .reduce((total, row) => total + row.spend, 0);

  check(forecast.through === cutDate, `day ${day}: forecast ran through ${forecast.through}`);
  check(forecast.reportedDays === day, `day ${day}: ${forecast.reportedDays} reported days`);
  check(
    forecast.remainingDays === daysInMonth - day,
    `day ${day}: ${forecast.remainingDays} remaining, expected ${daysInMonth - day}`,
  );
  check(
    Math.abs(forecast.monthToDate - monthToDate) < 1e-9,
    `day ${day}: month to date ${forecast.monthToDate} != ${monthToDate}`,
  );
  check(
    Math.abs(forecast.projected - (forecast.monthToDate + forecast.remaining)) < 1e-9,
    `day ${day}: projection is not month-to-date plus the remainder`,
  );
  check(forecast.projected >= forecast.monthToDate, `day ${day}: projection below month to date`);
  check(forecast.weekdays.length === 7, `day ${day}: weekday profile is not seven entries`);
  check(
    forecast.weekdays.every((entry) => entry.days > 0),
    `day ${day}: a weekday went unobserved in a 28-day profile`,
  );
  check(
    forecast.profileDays === 28,
    `day ${day}: profile is ${forecast.profileDays} days, expected 28`,
  );

  // Every remaining weekday must be marked as pending, and no other.
  const pendingWeekdays = new Set(
    Array.from({ length: forecast.remainingDays }, (_, index) =>
      weekdayOf(
        new Date(Date.parse(`${cutDate}T00:00:00Z`) + (index + 1) * MS_PER_DAY)
          .toISOString()
          .slice(0, 10),
      ),
    ),
  );
  check(
    forecast.weekdays.every((entry) => entry.remaining === pendingWeekdays.has(entry.weekday)),
    `day ${day}: pending-weekday flags disagree with the remaining days`,
  );

  cuts.push({
    day,
    weekdayError: Math.abs(forecast.projected - actual),
    flatError: Math.abs(forecast.flatProjected - actual),
    remainingWeekend: [...pendingWeekdays].filter((weekday) => weekday === 0 || weekday === 6).length,
  });
}

const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
const weekdayMeanError = mean(cuts.map((cut) => cut.weekdayError));
const flatMeanError = mean(cuts.map((cut) => cut.flatError));
const wins = cuts.filter((cut) => cut.weekdayError < cut.flatError).length;

console.log(
  `  ${cuts.length} replayed cut days · weekday-aware mean error $${weekdayMeanError.toFixed(2)} (${((weekdayMeanError / actual) * 100).toFixed(1)}%) · flat $${flatMeanError.toFixed(2)} (${((flatMeanError / actual) * 100).toFixed(1)}%) · weekday wins ${wins}/${cuts.length}`,
);

check(
  weekdayMeanError <= flatMeanError,
  `weekday-aware projection is not more accurate on average ($${weekdayMeanError.toFixed(2)} vs $${flatMeanError.toFixed(2)})`,
);
check(
  weekdayMeanError / actual < 0.15,
  `weekday-aware projection is off by ${((weekdayMeanError / actual) * 100).toFixed(1)}% of the month`,
);

// Averaged over a whole month the two barely differ, and they should not: over
// 20-odd remaining days the weekday mix converges on the profile's own mix, and
// what is left of the error is the mock's compound growth, which neither method
// extrapolates. The weekday profile earns its keep in the last week, where the
// remaining days are three Tuesdays or two weekend days and a flat rate prices
// them identically. That is where the comparison is scored.
const lastWeek = cuts.filter((cut) => cut.day > daysInMonth - 7);
const lastWeekWeekday = mean(lastWeek.map((cut) => cut.weekdayError));
const lastWeekFlat = mean(lastWeek.map((cut) => cut.flatError));
const lastWeekWins = lastWeek.filter((cut) => cut.weekdayError < cut.flatError).length;

console.log(
  `  final week only: weekday-aware $${lastWeekWeekday.toFixed(2)} · flat $${lastWeekFlat.toFixed(2)} · weekday wins ${lastWeekWins}/${lastWeek.length}`,
);

check(
  lastWeekWeekday < lastWeekFlat,
  `in the final week the weekday-aware projection is not more accurate ($${lastWeekWeekday.toFixed(2)} vs $${lastWeekFlat.toFixed(2)})`,
);
check(
  lastWeekWins > lastWeek.length / 2,
  `in the final week the weekday-aware projection wins only ${lastWeekWins} of ${lastWeek.length} cut days`,
);

// The case the whole weekday profile exists for: a Friday cut whose remainder is
// nothing but weekend. A flat run rate prices those two days as working days.
const fridayBeforeLastWeekend = (() => {
  for (let day = daysInMonth - 2; day >= 4; day -= 1) {
    const date = `${lastMonthStart.slice(0, 8)}${String(day).padStart(2, '0')}`;
    const rest = Array.from({ length: daysInMonth - day }, (_, index) =>
      weekdayOf(
        new Date(Date.parse(`${date}T00:00:00Z`) + (index + 1) * MS_PER_DAY)
          .toISOString()
          .slice(0, 10),
      ),
    );
    if (rest.length > 0 && rest.every((weekday) => weekday === 0 || weekday === 6)) return date;
  }
  return null;
})();

if (fridayBeforeLastWeekend !== null) {
  const forecast = deriveSpendForecast(
    rows.filter((row) => row.date <= fridayBeforeLastWeekend),
    { ...backtest, to: fridayBeforeLastWeekend },
  );
  check(forecast !== null, 'no forecast for the weekend-remainder cut');
  if (forecast !== null) {
    check(
      forecast.projected < forecast.flatProjected,
      `a weekend-only remainder must project below the flat run rate ($${forecast.projected.toFixed(2)} vs $${forecast.flatProjected.toFixed(2)})`,
    );
    console.log(
      `  weekend remainder from ${fridayBeforeLastWeekend}: weekday-aware $${forecast.projected.toFixed(2)}, flat $${forecast.flatProjected.toFixed(2)}, actual $${actual.toFixed(2)}`,
    );
  }
}

// ------------------------------------------------------------- edge behaviour

// A completed month projects itself: nothing left to guess at.
const complete = deriveSpendForecast(rows, { ...backtest, to: lastMonthEnd });
check(complete !== null, 'a completed month produced no forecast');
check(complete?.remainingDays === 0, 'a completed month still has days remaining');
check(
  complete !== null && Math.abs(complete.projected - actual) < 1e-9,
  'a completed month must project exactly what it spent',
);
check(complete?.remaining === 0, 'a completed month expects further spend');

// The month's first days, before the sync has reached them: nothing to project.
const beforeMonth = rows.filter((row) => row.date < lastMonthStart);
check(
  deriveSpendForecast(beforeMonth, { ...backtest, to: `${lastMonthStart.slice(0, 8)}01` }) === null,
  'a month with no reported day produced a forecast anyway',
);
check(deriveSpendForecast([], backtest) === null, 'an empty payload produced a forecast');

// The unsynced tail must not be booked as a zero day: asking through tomorrow
// has to give the same answer as asking through the last reported day.
const midMonth = `${lastMonthStart.slice(0, 8)}15`;
const seenToMid = rows.filter((row) => row.date <= midMonth);
const asked = deriveSpendForecast(seenToMid, { ...backtest, to: midMonth });
const askedAhead = deriveSpendForecast(seenToMid, {
  ...backtest,
  to: `${lastMonthStart.slice(0, 8)}17`,
});
check(
  asked !== null &&
    askedAhead !== null &&
    Math.abs(asked.projected - askedAhead.projected) < 1e-9 &&
    asked.through === askedAhead.through,
  'an unsynced tail changed the projection',
);

// The weekday profile has to reproduce the mock's own shape — weekends cheapest.
if (asked !== null) {
  const rates = asked.weekdays.map((entry) => entry.mean ?? 0);
  const weekend = Math.max(rates[0] ?? 0, rates[6] ?? 0);
  const weekdayFloor = Math.min(...[1, 2, 3, 4, 5].map((index) => rates[index] ?? 0));
  check(weekend < weekdayFloor, 'the weekday profile does not separate weekends from working days');
  console.log(
    `  weekday profile: ${rates.map((rate, index) => `${WEEKDAY_NAMES[index]} $${Math.round(rate)}`).join(' · ')}`,
  );
}

// ------------------------------------------------------------- current month

const live = deriveSpendForecast(await pullDaily(current.from, iso(-1)), current);
if (live !== null) {
  console.log(
    `current month through ${live.through}: $${live.monthToDate.toFixed(2)} spent, ${live.remainingDays}d left, projected $${live.projected.toFixed(2)} (flat $${live.flatProjected.toFixed(2)}, run rate $${live.runRate.toFixed(2)}/day)`,
  );
  check(live.projected > 0, 'the current month projects nothing');
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log('\nall forecast invariants hold');
