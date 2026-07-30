import type { GatewayDailyPoint } from '@dash/shared';
import { shiftIso, zeroFillDaily } from './gateway.js';

/**
 * Where this calendar month's gateway spend lands.
 *
 * Every other card on the page answers a question about the past. A budget
 * conversation is about the invoice that has not arrived yet, and the only
 * number that starts it is "at this rate, what does the month cost". This
 * module derives that, purely, from the daily spine.
 *
 * The projection is **weekday-aware, not a flat run-rate**, and that is the
 * whole point of the module. Gateway traffic is workload-shaped: a corporate
 * proxy's weekend is a fraction of its Tuesday. Multiplying a mixed daily mean
 * by the days left over-projects a month ending on a weekend and under-projects
 * one ending midweek, and it does so by a margin larger than anything else on
 * the card. Each remaining day is instead priced at what that weekday has
 * actually been costing. `flatProjected` keeps the naive answer alongside, so
 * the correction is visible rather than asserted.
 *
 * Two deliberate limits, both consequences of what the proxy hands back:
 *
 * - The window is the *calendar month*, independent of the page's range picker.
 *   A forecast against "the last 7 days" would be a forecast of nothing — the
 *   budget it is compared against is monthly.
 * - Growth is not extrapolated. The trailing weekday means already carry
 *   whatever trend is in the recent data; fitting a curve on top of 90 days of
 *   daily aggregates would dress a guess up as a model.
 */

/** Trailing days the weekday profile is built from — four of each weekday. */
const PROFILE_DAYS = 28;

const DAYS_IN_WEEK = 7;

export interface ForecastRange {
  /** First day to fetch: the month start, backed off far enough to profile weekdays. */
  from: string;
  /** Today. The unsynced tail is trimmed on derivation, not here. */
  to: string;
  monthStart: string;
  monthEnd: string;
}

/**
 * The window the forecast card fetches, from today's ISO date.
 *
 * It reaches back before the month start on purpose: on the 2nd of the month
 * there is one reported day, which is no basis for a weekday mean. Pulling the
 * preceding four weeks means the profile is the same size on the 2nd as on the
 * 28th, and the extra days cost one request that is cached for the day.
 *
 * At most 30 + 28 = 58 days, so it is always inside the proxy's 90-day
 * retention and never needs the guard the comparison window does.
 */
export function forecastRange(todayIso: string): ForecastRange {
  const year = Number(todayIso.slice(0, 4));
  const month = Number(todayIso.slice(5, 7));
  const monthStart = `${todayIso.slice(0, 7)}-01`;
  // Day 0 of the next month is the last day of this one — leap years included.
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

  return { from: shiftIso(monthStart, -PROFILE_DAYS), to: todayIso, monthStart, monthEnd };
}

/** UTC weekday of an ISO date, 0 = Sunday — the same basis the spine walks on. */
export function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

export interface WeekdayRate {
  /** 0 = Sunday. */
  weekday: number;
  /** Mean spend on that weekday over the profile window; null when unobserved. */
  mean: number | null;
  /** How many days the mean is over — a one-day mean is a number, not a rate. */
  days: number;
  /** Whether any day left in the month falls on this weekday. */
  remaining: boolean;
}

export interface SpendForecast {
  monthStart: string;
  monthEnd: string;
  /** Last day of the month the proxy actually reported — the projection starts after it. */
  through: string;
  /** Reported days of the month so far. */
  reportedDays: number;
  /** Days of the month still to come, including any the sync has not caught up on. */
  remainingDays: number;
  monthToDate: number;
  /** Expected spend over the remaining days, priced weekday by weekday. */
  remaining: number;
  /** `monthToDate + remaining` — the number the card leads with. */
  projected: number;
  /** What a flat trailing run-rate would project. Kept for contrast, never shown alone. */
  flatProjected: number;
  /** Mean daily spend over the profile window, all weekdays mixed. */
  runRate: number;
  /** Days the profile is built from — fewer than 28 only at the start of retention. */
  profileDays: number;
  /** Index 0..6, Sunday first. Always seven entries, unobserved weekdays included. */
  weekdays: WeekdayRate[];
}

/**
 * Every ISO day after `through` up to and including `monthEnd`.
 *
 * Note that this starts at the last *reported* day, not at today: the sync ends
 * at yesterday UTC, so today is a day nobody has been asked about yet. Counting
 * it as already-spent would book a zero into the month to date and drag the
 * projection down by a day's traffic, every day.
 */
function remainingDates(through: string, monthEnd: string): string[] {
  const dates: string[] = [];
  for (let day = shiftIso(through, 1); day <= monthEnd; day = shiftIso(day, 1)) {
    dates.push(day);
  }
  return dates;
}

function weekdayRates(
  profile: readonly GatewayDailyPoint[],
  remaining: readonly string[],
): WeekdayRate[] {
  const totals = Array.from({ length: DAYS_IN_WEEK }, () => ({ spend: 0, days: 0 }));
  for (const point of profile) {
    const bucket = totals[weekdayOf(point.date)];
    if (bucket === undefined) continue;
    bucket.spend += point.spend;
    bucket.days += 1;
  }

  const pending = new Set(remaining.map(weekdayOf));

  return totals.map((bucket, weekday) => ({
    weekday,
    mean: bucket.days > 0 ? bucket.spend / bucket.days : null,
    days: bucket.days,
    remaining: pending.has(weekday),
  }));
}

/**
 * The month's forecast from one `GET /api/gateway` payload covering
 * `forecastRange`.
 *
 * Null when the month has no reported day yet — on the 1st, and on the 2nd
 * before the sync has run. There is no month to date to project from, and a
 * projection built purely out of last month's weekdays would be a forecast the
 * page has no evidence for.
 */
export function deriveSpendForecast(
  daily: readonly GatewayDailyPoint[],
  range: ForecastRange,
): SpendForecast | null {
  // No rows at all is "never synced", not "spent nothing" — zero-filling that
  // would project a free month with total confidence.
  if (daily.length === 0) return null;

  // Zero-filled so a quiet day counts against the weekday mean it belongs to,
  // and tail-trimmed so the days the sync has not reached yet do not.
  const spine = zeroFillDaily(daily, range.from, range.to);
  const through = spine.at(-1)?.date;
  if (through === undefined || through < range.monthStart) return null;

  const monthDays = spine.filter((point) => point.date >= range.monthStart);
  const monthToDate = monthDays.reduce((total, point) => total + point.spend, 0);

  const profile = spine.slice(-PROFILE_DAYS);
  const runRate =
    profile.length === 0
      ? 0
      : profile.reduce((total, point) => total + point.spend, 0) / profile.length;

  const pending = remainingDates(through, range.monthEnd);
  const weekdays = weekdayRates(profile, pending);

  // A weekday the profile never saw falls back to the mixed run rate — worse
  // than a weekday mean, better than pretending the day is free.
  const remaining = pending.reduce(
    (total, date) => total + (weekdays[weekdayOf(date)]?.mean ?? runRate),
    0,
  );

  return {
    monthStart: range.monthStart,
    monthEnd: range.monthEnd,
    through,
    reportedDays: monthDays.length,
    remainingDays: pending.length,
    monthToDate,
    remaining,
    projected: monthToDate + remaining,
    flatProjected: monthToDate + pending.length * runRate,
    runRate,
    profileDays: profile.length,
    weekdays,
  };
}
