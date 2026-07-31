import {
  EXCEPTION_TREND_MIN_DAYS,
  GATEWAY_EXCEPTION_CLASS_INFO,
  deploymentExceptionKey,
  summarizeExceptionHistory,
} from '@dash/shared';
import type {
  GatewayDeployment,
  GatewayExceptionClass,
  GatewayExceptionHistory,
  GatewayExceptionHistoryClass,
  GatewayExceptionHistoryDeployment,
  GatewayExceptionHistorySummary,
  GatewayHealth,
} from '@dash/shared';
import { shiftIso } from './gateway.js';

/**
 * The nightly exception sweep read as a sequence — what the live card cannot say.
 *
 * `gatewayExceptions.ts` reads `/model/metrics/exceptions` for a window on
 * demand, and it is a good answer to "what were the failed calls" and no answer
 * at all to "is that what usually breaks here". This module reads the rows the
 * full sync files each night (`gateway_exception_daily`, one per alias per
 * deployment per `exception_type` per UTC day) beside the receipts that say the
 * sweep ran at all (`gateway_exception_sweep`) and answers the second question.
 *
 * The receipt is what makes the sequence readable, and it is the one thing this
 * layer needs that no other history here does: the route answers rows *only*
 * where something failed, so a night the gateway behaved records nothing and is
 * byte-identical to a night the sweep was refused, hit `disable_error_logs`, or
 * never ran. Those are opposite findings. A night with a receipt and no rows is
 * **clean**; a night with neither is **unread**.
 *
 * Like every other history view here it adds **no rule about the gateway**:
 * `summarizeExceptionHistory` in `@dash/shared` is the single statement of what a
 * run of nightly sweeps means — counts add because error-log rows are disjoint,
 * there is no denominator anywhere so there is no rate, no badge and no
 * significance test, every share is of what was *recorded*, and the one trend is
 * a **mix shift** because a class going from a fifth of recorded errors to half
 * of them is a change in what is breaking while ten times the traffic multiplies
 * every class and moves the mix by nothing. The API's own harness reads the same
 * function, so the card and the check cannot disagree.
 *
 * What is added here is only what the *drawing* needs:
 *
 *  - **a spine clamped forward to `recordingSince`.** There is no backfill for
 *    this table and cannot be: the sweep asks the proxy about one settled day and
 *    files what it answered, so the nights before this dashboard was watching are
 *    gone. A 60-night window on a four-night recording draws four nights.
 *  - **three states per cell, not two.** The receipt's whole purpose is that a
 *    clean night and an unread one are different claims, and a strip is the one
 *    place a reader would never notice which they were looking at.
 *  - **whether the window can express the layer's own extra statement.** The mix
 *    shift is the one thing the history adds over the live card, and under
 *    {@link EXCEPTION_TREND_MIN_DAYS} swept nights it is withheld — a card
 *    drawing no direction reads as "nothing moved", which would be a fact about
 *    the age of the recording rather than about the gateway.
 *
 * Nothing here is a failure rate, for the reason the table itself carries: the
 * error log has no denominator, so stacking sixty nights of counts produces a
 * bigger count with nothing under it.
 */

/**
 * The window the card asks for.
 *
 * Sixty nights, matching the three other history cards: long enough that a
 * standing fault, a fix and a workload shift all fit inside it, short enough that
 * the payload stays classes × nights. The route's own default, restated here
 * because the card names it.
 */
export const EXCEPTION_HISTORY_DAYS = 60;

/** One night of the drawn spine. Three states, never two — that is the receipt's job. */
export type ExceptionCellState = 'recorded' | 'clean' | 'unobserved';

export interface ExceptionCell {
  date: string;
  state: ExceptionCellState;
  /** Exceptions on that night. Zero on a clean night, zero on an unread one — read `state`. */
  count: number;
}

/** Gateway-wide, aligned to the spine — so an unread night is a hole here too. */
export interface ExceptionHistoryDay {
  date: string;
  /** A sweep was filed for this night, whatever it found. */
  observed: boolean;
  /** Swept and recorded nothing. Only meaningful while `observed`. */
  clean: boolean;
  total: number;
  /** How many deployments recorded at least one. Never the router's size. */
  deployments: number;
  /** Aliases swept that night — the sweep cap and a quiet gateway both lower it. */
  models: number;
  /** The night's own largest class, for the tooltip. Null on a clean or unread night. */
  dominantClass: GatewayExceptionClass | null;
}

export interface ExceptionHistoryClassRow extends GatewayExceptionHistoryClass {
  label: string;
  /** `capacity`, `configuration`, `governance`, … — the point of the whole layer. */
  owner: string;
  docs: string;
  /** One cell per night of the drawn spine, ascending. */
  cells: ExceptionCell[];
}

/**
 * Where the nightly health reading and the stored exception log agree.
 *
 * The same three-state join the live exception card carries, rebuilt with
 * `deploymentExceptionKey` for the same reason: the key is
 * `litellm_model_name` + `-` + `api_base` and both halves contain hyphens, so it
 * can be rebuilt and never split. `unread` is deliberately not `healthy` — an
 * absent row is silence — and it is more common here than on the live card,
 * because these rows may be older than the deployment list tonight's reading
 * names.
 */
export type ExceptionHistoryHealthJoin = 'failing' | 'healthy' | 'unread';

export interface ExceptionHistoryDeploymentRow extends GatewayExceptionHistoryDeployment {
  label: string | null;
  health: ExceptionHistoryHealthJoin;
  healthError: string | null;
  /** Nights inside this deployment's *own* span that recorded nothing from it. */
  quietDays: number;
}

export interface ExceptionHistoryView {
  /** Whether the query has answered. False while it is in flight. */
  answered: boolean;
  /** Answered, and no sweep has ever been filed. Not "nothing has ever failed". */
  isEmpty: boolean;
  /**
   * Fewer than {@link EXCEPTION_TREND_MIN_DAYS} nights carry a sweep, so the one
   * statement this layer adds over the live card cannot be made yet whatever the
   * gateway is doing.
   */
  tooShort: boolean;
  /** The shared derivation, verbatim. Every claim about the gateway lives here. */
  summary: GatewayExceptionHistorySummary;
  /** The window asked for. Ends yesterday: today's sweep has not run. */
  from: string;
  to: string;
  /** The window drawn — clamped forward to the first night ever swept. */
  spineFrom: string;
  recordingSince: string | null;
  dates: string[];
  days: ExceptionHistoryDay[];
  /** Nights of the drawn spine carrying a sweep, clean ones included. */
  daysSwept: number;
  /** Of those, the ones that recorded nothing. A finding, not an absence. */
  daysClean: number;
  /** Nights of the drawn spine carrying no sweep at all. */
  daysMissed: number;
  classes: ExceptionHistoryClassRow[];
  deployments: ExceptionHistoryDeploymentRow[];
  /** Every exception recorded in the window. A floor on failures, never their count. */
  total: number;
  /** The swept night that recorded the most. Needs an exception to qualify. */
  worstDay: ExceptionHistoryDay | null;
  /** The largest move in the mix, when a trend is available at all. */
  biggestShift: {
    class: GatewayExceptionClass;
    label: string;
    owner: string;
    deltaPoints: number;
    earlierShare: number;
    recentShare: number;
  } | null;
}

const EMPTY_SUMMARY: GatewayExceptionHistorySummary = {
  from: '',
  to: '',
  recordingSince: null,
  observedDays: [],
  unobservedDays: 0,
  cleanDays: 0,
  days: [],
  classes: [],
  deployments: [],
  total: 0,
  trend: null,
};

const EMPTY_VIEW: ExceptionHistoryView = {
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
  daysSwept: 0,
  daysClean: 0,
  daysMissed: 0,
  classes: [],
  deployments: [],
  total: 0,
  worstDay: null,
  biggestShift: null,
};

function dayDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

export interface ExceptionHistoryOptions {
  /** The health snapshot, for the join this layer's key makes possible. */
  health?: GatewayHealth | null;
}

export function deriveExceptionHistory(
  history: GatewayExceptionHistory | null | undefined,
  options: ExceptionHistoryOptions = {},
): ExceptionHistoryView {
  if (history === null || history === undefined) return EMPTY_VIEW;

  const summary = summarizeExceptionHistory(history);

  // The spine starts at the later of the window and the first night ever swept.
  // Padding backwards would draw the weeks before this table existed as weeks the
  // sweep missed, which is true of the scheduler and misleading about the gateway
  // — the same clamp, for the same reason, as the two other history cards.
  const { from, to } = history;
  const recordingSince = history.recordingSince;
  const spineFrom = recordingSince !== null && recordingSince > from ? recordingSince : from;
  const dates: string[] = [];
  if (from !== '' && to !== '' && spineFrom <= to) {
    for (let date = spineFrom; date <= to; date = shiftIso(date, 1)) dates.push(date);
  }

  const dayByDate = new Map(summary.days.map((day) => [day.date, day]));
  const days: ExceptionHistoryDay[] = dates.map((date) => {
    const day = dayByDate.get(date);
    if (day === undefined) {
      return {
        date,
        observed: false,
        clean: false,
        total: 0,
        deployments: 0,
        models: 0,
        dominantClass: null,
      };
    }
    return {
      date,
      observed: true,
      clean: day.clean,
      total: day.total,
      deployments: day.deployments,
      models: day.models,
      dominantClass: day.classes[0]?.class ?? null,
    };
  });

  // A class's night is read off the shared summary's own day series rather than
  // off the raw rows, so the strip and the roll-up cannot drift: `clean` there is
  // already "swept and found nothing", which is exactly the state a class strip
  // has to keep apart from an unread night.
  const countsByDate = new Map<string, Map<GatewayExceptionClass, number>>();
  for (const day of summary.days) {
    countsByDate.set(day.date, new Map(day.classes.map((entry) => [entry.class, entry.count])));
  }

  const classes: ExceptionHistoryClassRow[] = summary.classes.map((row) => {
    const info = GATEWAY_EXCEPTION_CLASS_INFO[row.class];
    const cells: ExceptionCell[] = days.map((day) => {
      if (!day.observed) return { date: day.date, state: 'unobserved', count: 0 };
      const count = countsByDate.get(day.date)?.get(row.class) ?? 0;
      return { date: day.date, state: count > 0 ? 'recorded' : 'clean', count };
    });
    return { ...row, label: info.label, owner: info.owner, docs: info.docs, cells };
  });

  const byKey = healthByExceptionKey(options.health?.deployments ?? []);
  const deployments: ExceptionHistoryDeploymentRow[] = summary.deployments.map((row) => {
    const match = byKey.get(row.deployment);
    // Counted over this deployment's own span rather than the window's: a
    // deployment the router only gained last Tuesday recorded nothing before it
    // existed, which is not the same as a night it stayed quiet.
    const span =
      row.firstDate === '' || row.lastDate === '' ? 0 : dayDiff(row.firstDate, row.lastDate) + 1;
    return {
      ...row,
      label: match?.backend ?? null,
      health: match === undefined ? 'unread' : match.healthy ? 'healthy' : 'failing',
      healthError: match?.error ?? null,
      quietDays: Math.max(0, span - row.daysPresent),
    };
  });

  const worstDay = days.reduce<ExceptionHistoryDay | null>((worst, day) => {
    if (!day.observed || day.total <= 0) return worst;
    if (worst === null || day.total > worst.total) return day;
    return worst;
  }, null);

  const moved = summary.trend?.classes[0] ?? null;
  const observedDates = new Set(summary.observedDays);

  return {
    answered: true,
    isEmpty: summary.observedDays.length === 0,
    // A recording too short to split in half says nothing about a direction, and
    // the card leads with that rather than drawing a flat one.
    tooShort: summary.observedDays.length < EXCEPTION_TREND_MIN_DAYS,
    summary,
    from,
    to,
    spineFrom,
    recordingSince,
    dates,
    days,
    daysSwept: days.filter((day) => day.observed).length,
    daysClean: days.filter((day) => day.observed && day.clean).length,
    daysMissed: dates.filter((date) => !observedDates.has(date)).length,
    classes,
    deployments,
    total: summary.total,
    worstDay,
    biggestShift:
      moved === null
        ? null
        : {
            class: moved.class,
            label: GATEWAY_EXCEPTION_CLASS_INFO[moved.class].label,
            owner: GATEWAY_EXCEPTION_CLASS_INFO[moved.class].owner,
            deltaPoints: moved.deltaPoints,
            earlierShare: moved.earlierShare,
            recentShare: moved.recentShare,
          },
  };
}

/**
 * Why a class's direction is missing, in the window's own terms.
 *
 * There is no badge in this layer to explain — with no denominator there is
 * nothing to be significant against — so the only silence a reader meets is a
 * withheld shift, and it has three causes worth telling apart: too few swept
 * nights to split, a half that recorded nothing at all (every class would read
 * as moving to zero), or a class the split simply did not see.
 */
export function mixShiftReason(view: ExceptionHistoryView, row: GatewayExceptionHistoryClass): string {
  const { trend } = view.summary;
  if (trend === null) {
    if (view.summary.observedDays.length < EXCEPTION_TREND_MIN_DAYS) {
      return `withheld — ${view.summary.observedDays.length} swept night${
        view.summary.observedDays.length === 1 ? '' : 's'
      } of the ${EXCEPTION_TREND_MIN_DAYS} a half-over-half split needs`;
    }
    return 'withheld — one half of the window recorded nothing, so there is no mix to compare it against';
  }
  if (row.shiftPoints === null) {
    return 'recorded outside both halves of the split';
  }
  if (row.newInRecentHalf === true) {
    return `new in the recent half — nothing of this class in the ${trend.earlier.days} night${
      trend.earlier.days === 1 ? '' : 's'
    } before it`;
  }
  return `${(row.share * 100).toFixed(1)}% of everything recorded in the window · pooled halves, never a mean of nightly mixes`;
}

/**
 * The health snapshot, keyed the way the exception log keys a deployment.
 *
 * One direction only, and the same rule the live card encodes: LiteLLM builds the
 * key as `litellm_model_name` + `-` + `api_base`, both of which contain hyphens
 * of their own, so it can be rebuilt and never parsed back.
 */
function healthByExceptionKey(
  deployments: readonly GatewayDeployment[],
): Map<string, GatewayDeployment> {
  const byKey = new Map<string, GatewayDeployment>();
  for (const deployment of deployments) {
    const key = deploymentExceptionKey(deployment.backend, deployment.apiBase);
    const existing = byKey.get(key);
    // A failing reading wins a collision, for the live card's reason: two
    // deployments only share a key when the proxy stripped their bases, and the
    // fault is the thing worth surfacing.
    if (existing === undefined || (existing.healthy && !deployment.healthy)) {
      byKey.set(key, deployment);
    }
  }
  return byKey;
}

/** Whether the card has anything to draw at all. */
export function hasExceptionHistory(view: ExceptionHistoryView): boolean {
  return view.answered && !view.isEmpty;
}
