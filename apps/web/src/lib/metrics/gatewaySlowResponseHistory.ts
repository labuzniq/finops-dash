import {
  SLOW_RESPONSE_CONFIDENCE_Z,
  SLOW_RESPONSE_ELEVATED_RATIO,
  SLOW_RESPONSE_MIN_COUNT,
  SLOW_RESPONSE_TREND_MIN_DAYS,
  UNKEYED_DEPLOYMENT,
  summarizeSlowResponseHistory,
  wilsonScoreLowerBound,
} from '@dash/shared';
import type {
  GatewaySlowResponseHistory,
  GatewaySlowResponseHistoryKey,
  GatewaySlowResponseHistorySummary,
} from '@dash/shared';
import { shiftIso } from './gateway.js';

/**
 * The nightly hang sweep read as a sequence — what the live card structurally
 * cannot say.
 *
 * `gatewaySlowResponses.ts` reads `/model/metrics/slow_responses` for a window
 * on demand, and it is deliberately about that window: how many calls hung, on
 * which endpoint, against the proxy's own invisible threshold. What it cannot
 * do is compare tonight with last Tuesday — the route answers whatever range it
 * is asked for, so a reader pressing the button sees one number and no idea
 * whether it is the usual one. This module reads the rows the full sync files
 * each night (`gateway_slow_response_daily`, one per alias per endpoint per UTC
 * day) and answers that instead.
 *
 * It is the only one of the page's four live reads that has a history at all,
 * and the reason is arithmetic rather than product judgement: this route counts
 * disjoint request-log rows *beside their own denominator*, and counts add
 * across nights. `/model/metrics` answers a mean of per-request ratios (rates do
 * not add) and `/model/metrics/exceptions` carries no denominator at all
 * (a total with nothing under it accumulates into a bigger total with nothing
 * under it), so neither may be stored this way.
 *
 * Like every other history view here it adds **no rule about the gateway**:
 * `summarizeSlowResponseHistory` in `@dash/shared` is the single statement of
 * what a run of nightly sweeps means — counts pool, both badge gates are the
 * live card's own restated over the pooled counts, the trend is pooled rather
 * than averaged, an unobserved night is never interpolated — and the API's own
 * verification reads the same function, so the card and the harness cannot
 * disagree. What is added here is only what the *drawing* needs:
 *
 *  - **a spine clamped forward to `recordingSince`.** There is no backfill for
 *    this table and cannot be: the sweep asks the proxy about one settled day
 *    and files what it answered, so the nights before this dashboard was
 *    watching are gone. A 60-day window on a four-night recording draws four
 *    nights rather than 56 empty ones.
 *  - **three states per cell, not two.** A night with no reading is a hole. A
 *    clean night and a night the sweep was refused, hit `disable_spend_logs`,
 *    or simply did not run are opposite claims about the same absence of rows,
 *    and the strip is the one place a reader would never notice the difference.
 *  - **whether the window can express the layer's own extra statement.** The
 *    trend is the one thing the history adds that the live card has no way to
 *    compute, and under {@link SLOW_RESPONSE_TREND_MIN_DAYS} observed nights it
 *    is withheld — "flat" would be a fact about how long the recording is.
 *
 * Nothing here attaches a duration to anything, for the reason the table itself
 * carries: the proxy counts against its own `alerting_threshold`, never reports
 * which number it used, and a count of requests past an invisible line is not a
 * number of seconds however many nights of it are stacked up.
 */

/**
 * The window the card asks for.
 *
 * Sixty nights, matching the two other history cards: long enough that a
 * standing hang, a fix and a seasonal shift all fit inside it, short enough that
 * the payload stays endpoints × nights. The route's own default, restated here
 * because the card names it.
 */
export const SLOW_RESPONSE_HISTORY_DAYS = 60;

/** One endpoint on one night of the drawn spine. Three states, never two. */
export type HangCellState = 'hangs' | 'clean' | 'unobserved';

export interface HangCell {
  date: string;
  state: HangCellState;
  /** Hangs over the night's own grouped requests. Null on an unread night. */
  share: number | null;
  slow: number;
  total: number;
}

/** Gateway-wide, aligned to the spine — so an unread night is a hole here too. */
export interface HangHistoryDay {
  date: string;
  observed: boolean;
  total: number;
  slow: number;
  share: number | null;
  /** Endpoints that reported this night. The night's coverage, not the router's size. */
  keys: number;
  /** Aliases swept this night. The sweep cap and a quiet alias both lower it. */
  models: number;
}

export interface HangHistoryRow extends GatewaySlowResponseHistoryKey {
  /** One cell per night of the drawn spine, ascending. */
  cells: HangCell[];
  /** Nights inside this endpoint's *own* span carrying no reading of it. */
  unobservedDays: number;
  /**
   * This is the proxy's `GROUP BY api_base` bucket rather than an endpoint: every
   * deployment of an alias that is addressed by region rather than by URL, in one
   * row. It ranks and pools like any other row and it cannot be attributed to a
   * deployment, which the card has to say rather than let the key imply.
   */
  isUnkeyed: boolean;
}

export interface SlowResponseHistoryView {
  /** Whether the query has answered. False while it is in flight. */
  answered: boolean;
  /** Answered, and no sweep has ever been filed. Not "nothing has ever hung". */
  isEmpty: boolean;
  /**
   * Fewer than {@link SLOW_RESPONSE_TREND_MIN_DAYS} nights carry a reading, so
   * the one statement this layer adds over the live card cannot be made yet
   * whatever the gateway is doing.
   */
  tooShort: boolean;
  /** The shared derivation, verbatim. Every claim about the gateway lives here. */
  summary: GatewaySlowResponseHistorySummary;
  /** The window asked for. Ends yesterday: today can never carry a reading. */
  from: string;
  to: string;
  /** The window drawn — clamped forward to the first night ever filed. */
  spineFrom: string;
  recordingSince: string | null;
  dates: string[];
  days: HangHistoryDay[];
  /** Nights of the drawn spine carrying a reading of anything. */
  daysRecorded: number;
  /** Nights of the drawn spine carrying none — sweeps that did not run or were refused. */
  daysMissed: number;
  rows: HangHistoryRow[];
  /** Pooled over every observed night, and the denominator every ratio is taken against. */
  total: number;
  slow: number;
  share: number | null;
  /** Endpoints past both of the live card's gates over the pooled counts. */
  elevatedKeys: number;
  /** The observed night with the highest hang share, needing a hang to qualify. */
  worstDay: HangHistoryDay | null;
}

const EMPTY_SUMMARY: GatewaySlowResponseHistorySummary = {
  from: '',
  to: '',
  recordingSince: null,
  observedDays: [],
  unobservedDays: 0,
  days: [],
  keys: [],
  total: 0,
  slow: 0,
  share: null,
  trend: null,
};

const EMPTY_VIEW: SlowResponseHistoryView = {
  answered: false,
  isEmpty: false,
  tooShort: false,
  summary: EMPTY_SUMMARY,
  from: '',
  to: '',
  spineFrom: '',
  recordingSince: null,
  dates: [],
  days: [],
  daysRecorded: 0,
  daysMissed: 0,
  rows: [],
  total: 0,
  slow: 0,
  share: null,
  elevatedKeys: 0,
  worstDay: null,
};

function dayDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

export function deriveSlowResponseHistory(
  history: GatewaySlowResponseHistory | null | undefined,
): SlowResponseHistoryView {
  if (history === null || history === undefined) return EMPTY_VIEW;

  const summary = summarizeSlowResponseHistory(history);

  // The spine starts at the later of the window and the first night ever filed.
  // Padding backwards would draw the weeks before this table existed as weeks
  // the sweep missed, which is true of the scheduler and misleading about the
  // gateway — the same clamp, for the same reason, as the health history.
  const { from, to } = history;
  const recordingSince = history.recordingSince;
  const spineFrom = recordingSince !== null && recordingSince > from ? recordingSince : from;
  const dates: string[] = [];
  if (from !== '' && to !== '' && spineFrom <= to) {
    for (let date = spineFrom; date <= to; date = shiftIso(date, 1)) dates.push(date);
  }

  const dayByDate = new Map(summary.days.map((day) => [day.date, day]));
  const days: HangHistoryDay[] = dates.map((date) => {
    const day = dayByDate.get(date);
    if (day === undefined) {
      return { date, observed: false, total: 0, slow: 0, share: null, keys: 0, models: 0 };
    }
    return {
      date,
      observed: true,
      total: day.total,
      slow: day.slow,
      share: day.share,
      keys: day.keys,
      models: day.models,
    };
  });

  // Per key per night, summed across the aliases that routed there — two aliases
  // answering out of one endpoint on one night are two disjoint counts of that
  // endpoint's traffic, which is the same addition the shared roll-up performs
  // across a sweep, performed here per cell so the strip and the row agree.
  const byKey = new Map<string, Map<string, { total: number; slow: number }>>();
  for (const observation of history.observations) {
    if (!Number.isFinite(observation.total) || observation.total <= 0) continue;
    const nights = byKey.get(observation.key) ?? new Map<string, { total: number; slow: number }>();
    const night = nights.get(observation.date);
    if (night === undefined) {
      nights.set(observation.date, { total: observation.total, slow: observation.slow });
    } else {
      night.total += observation.total;
      night.slow += observation.slow;
    }
    byKey.set(observation.key, nights);
  }

  const rows: HangHistoryRow[] = summary.keys.map((key) => {
    const nights = byKey.get(key.key) ?? new Map<string, { total: number; slow: number }>();
    const cells: HangCell[] = dates.map((date) => {
      const night = nights.get(date);
      if (night === undefined) {
        return { date, state: 'unobserved', share: null, slow: 0, total: 0 };
      }
      return {
        date,
        state: night.slow > 0 ? 'hangs' : 'clean',
        share: night.total > 0 ? night.slow / night.total : null,
        slow: night.slow,
        total: night.total,
      };
    });

    // Counted over this endpoint's own span rather than the window's: an
    // endpoint the router only gained last Tuesday has no missing nights before
    // it existed, exactly as the health history counts a deployment's.
    const span =
      key.firstDate === '' || key.lastDate === '' ? 0 : dayDiff(key.firstDate, key.lastDate) + 1;

    return {
      ...key,
      cells,
      unobservedDays: Math.max(0, span - key.daysObserved),
      isUnkeyed: key.key === UNKEYED_DEPLOYMENT,
    };
  });

  const observedDays = new Set(summary.observedDays);
  const worstDay = days.reduce<HangHistoryDay | null>((worst, day) => {
    if (!day.observed || day.slow <= 0 || day.share === null) return worst;
    if (worst === null || day.share > (worst.share ?? 0)) return day;
    return worst;
  }, null);

  return {
    answered: true,
    isEmpty: summary.observedDays.length === 0,
    // A recording too short to split in half says nothing about a direction.
    // The card leads with that rather than drawing a flat one.
    tooShort: summary.observedDays.length < SLOW_RESPONSE_TREND_MIN_DAYS,
    summary,
    from,
    to,
    spineFrom,
    recordingSince,
    dates,
    days,
    daysRecorded: dates.filter((date) => observedDays.has(date)).length,
    daysMissed: dates.filter((date) => !observedDays.has(date)).length,
    rows,
    total: summary.total,
    slow: summary.slow,
    share: summary.share,
    elevatedKeys: summary.keys.filter((key) => key.elevated).length,
    worstDay,
  };
}

/**
 * Which gate refused an unbadged endpoint, in the pooled window's terms.
 *
 * The same three sentences the live card carries, and for the same reason: the
 * badge has two gates guarding opposite regimes, so "not badged" means either
 * "not measurably different", "not much worse" or "we have barely seen it", and
 * a row rendering none of the three reads as clean. The Wilson bound is computed
 * again here rather than read off the summary because the shared roll-up only
 * exports the conjunction.
 */
export function hangBadgeReason(row: GatewaySlowResponseHistoryKey, windowShare: number | null): string {
  if (row.ratioToGateway === null || windowShare === null) {
    return 'no window rate to compare against';
  }
  if (row.slow < SLOW_RESPONSE_MIN_COUNT) {
    return `${row.slow} hang${row.slow === 1 ? '' : 's'} across ${row.daysObserved} night${
      row.daysObserved === 1 ? '' : 's'
    } — under the ${SLOW_RESPONSE_MIN_COUNT} this card needs before it will say anything`;
  }
  const bound = wilsonScoreLowerBound(row.slow, row.total, SLOW_RESPONSE_CONFIDENCE_Z);
  if (bound <= windowShare) {
    return `${((row.share ?? 0) * 100).toFixed(2)}% of ${row.total.toLocaleString()} pooled requests — inside the noise around the window's ${(windowShare * 100).toFixed(2)}%`;
  }
  if (row.ratioToGateway < SLOW_RESPONSE_ELEVATED_RATIO) {
    return `${row.ratioToGateway.toFixed(2)}× the window rate — measurable, but under the ${SLOW_RESPONSE_ELEVATED_RATIO}× this card calls material`;
  }
  return `${row.ratioToGateway.toFixed(2)}× the window rate over ${row.total.toLocaleString()} pooled requests from ${row.daysWithHangs} night${
    row.daysWithHangs === 1 ? '' : 's'
  } with hangs`;
}

/** Whether the card has anything to draw at all. */
export function hasSlowResponseHistory(view: SlowResponseHistoryView): boolean {
  return view.answered && !view.isEmpty && view.rows.length > 0;
}
