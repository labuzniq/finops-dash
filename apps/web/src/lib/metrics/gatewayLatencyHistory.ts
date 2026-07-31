import {
  LATENCY_ELEVATED_RATIO,
  LATENCY_MIN_DAYS,
  LATENCY_TREND_MIN_DAYS,
  latencyDeploymentKey,
  summarizeLatencyHistory,
  tokensPerSecond,
} from '@dash/shared';
import type {
  GatewayDeployment,
  GatewayHealth,
  GatewayLatencyHistory,
  GatewayLatencyHistoryKey,
  GatewayLatencyHistorySummary,
} from '@dash/shared';
import { shiftIso } from './gateway.js';

/**
 * The nightly latency sweep read as a sequence — the question the live card is
 * structurally unable to answer.
 *
 * `gatewayLatency.ts` reads `/model/metrics` for the days on screen when
 * somebody presses the button, and it is a good answer to "how slowly did the
 * backends answer" and no answer at all to "is that how they usually answer".
 * The route has no memory: it aggregates whatever window it is handed, so a
 * reader gets one number and no idea whether it is last week's number. This
 * module reads what the full sync files each night
 * (`gateway_latency_daily`, one reading per alias per deployment key per UTC
 * night) and answers that instead.
 *
 * It is the third of the four live reads to be kept, and the first kept on a
 * licence that is not arithmetic. The hang and exception tables accumulate
 * because their rows are disjoint *events* and counts add across nights. Nothing
 * here adds and nothing will: the proxy averaged the request counts away before
 * answering, so a night's reading carries no weight and two nights cannot be
 * pooled into one. What these rows support is the weaker operation — **kept and
 * compared, never pooled** — which is exactly the licence
 * `gateway_deployment_health_history` already runs on, and it is enough for the
 * only question that matters here: has this endpoint been reading slow all week,
 * or only tonight.
 *
 * Like every other history view in this integration it adds **no rule about the
 * gateway**: `summarizeLatencyHistory` in `@dash/shared` is the single statement
 * of what a run of nightly readings means — every window figure a median, the
 * badge the live layer's ratio and days-observed gate restated, the trend a
 * ratio rather than percentage points, an unobserved night never interpolated —
 * and the API's own verification reads the same function, so the card and the
 * harness cannot disagree. What is added here is only what the *drawing* needs:
 *
 *  - **a spine clamped forward to `recordingSince`.** There is no backfill for
 *    this table and cannot be: the sweep asks the proxy about one settled day
 *    and files what it answered, so the nights before this dashboard was
 *    watching are gone. A 60-night window on a four-night recording draws four.
 *  - **three states per cell, not two.** A night with no reading is a hole. The
 *    proxy omits a deployment that served no completion tokens
 *    (`HAVING SUM(completion_tokens) > 0`) and drops cache hits entirely, and a
 *    sweep that did not run files nothing at all — none of those is a fast
 *    night, and the strip is the one place a reader would never notice the
 *    difference. The third state is not "clean" as it is on the two sibling
 *    cards: there is no such thing as a clean reading here, only a fast one and
 *    a slow one, so a cell that carries a reading is drawn at its own rate
 *    against the window's median.
 *  - **whether the window can express the layer's own extra statement.** The
 *    trend is the one thing the history adds that the live card cannot compute,
 *    and under {@link LATENCY_TREND_MIN_DAYS} observed nights it is withheld —
 *    "unchanged" would be a fact about how long the recording is.
 *
 * Nothing here attaches a duration to anything, for the reason the table itself
 * carries: the reading is `AVG(seconds / completion_tokens)` per request, so
 * sixty nights of it is still a rate, and the only transformation that adds no
 * claim is its reciprocal.
 */

/**
 * The window the card asks for.
 *
 * Sixty nights, matching the three other history cards: long enough that a
 * standing regression, a fix and a model swap all fit inside it, short enough
 * that the payload stays pairs × nights.
 */
export const LATENCY_HISTORY_DAYS = 60;

/** One (alias, key) pair on one night of the drawn spine. Three states, never two. */
export type LatencyCellState = 'fast' | 'slow' | 'unobserved';

export interface LatencyCell {
  date: string;
  state: LatencyCellState;
  /** The night's reading. Null on an unread night — never the window median. */
  secondsPerToken: number | null;
  /** This night over the pair's own median. Null when unread. */
  ratioToOwnMedian: number | null;
}

/** Gateway-wide, aligned to the spine — so an unread night is a hole here too. */
export interface LatencyHistoryDay {
  date: string;
  observed: boolean;
  /** Median across the pairs that reported. Null on an unread night. */
  medianSecondsPerToken: number | null;
  /** Pairs that reported this night. The night's coverage, not the router's size. */
  keys: number;
  /** Aliases that contributed. The sweep's own cap and a quiet alias both lower it. */
  models: number;
}

export interface LatencyHistoryRow extends GatewayLatencyHistoryKey {
  /** One cell per night of the drawn spine, ascending. */
  cells: LatencyCell[];
  /** The pair's median read the friendly way round. Null only for a nonsensical zero. */
  tokensPerSecond: number | null;
  /** Milliseconds per completion token — a unit change on the same rate, no new claim. */
  msPerToken: number;
  /** What tonight's `/health` reading says about the deployment this key names. */
  health: LatencyHistoryHealthJoin;
  /** How many deployments in that reading collapse onto this key. */
  behindKey: number;
}

/**
 * The four states the live latency card's join has, restated.
 *
 * `unread` is silence and is deliberately not `healthy` — no reading taken, an
 * alias outside the catalogue, or a proxy running `health_check_details: false`,
 * which strips `api_base` so the key cannot be rebuilt. `mixed` is this key's
 * own state: `/model/metrics` keys on an `api_base` alone wherever there is one,
 * so several deployments behind one endpoint collapse upstream, and a reading
 * that disagrees among them describes none of them.
 */
export type LatencyHistoryHealthJoin = 'failing' | 'healthy' | 'mixed' | 'unread';

export interface LatencyHistoryView {
  /** Whether the query has answered. False while it is in flight. */
  answered: boolean;
  /** Answered, and no night has ever been filed. Not "nothing has ever been slow". */
  isEmpty: boolean;
  /**
   * Fewer than {@link LATENCY_TREND_MIN_DAYS} nights carry a reading, so the one
   * statement this layer adds over the live card cannot be made yet whatever the
   * backends are doing.
   */
  tooShort: boolean;
  /** The shared derivation, verbatim. Every claim about the gateway lives here. */
  summary: GatewayLatencyHistorySummary;
  /** The window asked for. Ends yesterday: today can never carry a reading. */
  from: string;
  to: string;
  /** The window drawn — clamped forward to the first night ever filed. */
  spineFrom: string;
  recordingSince: string | null;
  dates: string[];
  days: LatencyHistoryDay[];
  /** Nights of the drawn spine carrying a reading of anything. */
  daysRecorded: number;
  /** Nights of the drawn spine carrying none — sweeps that did not run or were refused. */
  daysMissed: number;
  rows: LatencyHistoryRow[];
  /** Median of the pair medians — what every ratio here is taken against. */
  medianSecondsPerToken: number | null;
  /** The same median read the friendly way round. */
  medianTokensPerSecond: number | null;
  /** Pairs past the live layer's ratio and days-observed gates over their stored nights. */
  elevatedKeys: number;
  /** The slowest pair of the recording, badged or not. */
  slowest: LatencyHistoryRow | null;
  /** The observed night whose gateway median was the slowest. */
  worstDay: LatencyHistoryDay | null;
  /** Pairs tonight's health reading also names — the only other deployment-keyed source. */
  joinedKeys: number;
  /** Of those, the ones it found failing: slow *and* refusing, from two independent reads. */
  failingJoined: number;
  /** Pairs whose base fronts deployments the reading disagrees about. */
  mixedJoins: number;
}

export interface LatencyHistoryOptions {
  /** Tonight's health snapshot, for the join this layer's key makes possible. */
  health?: GatewayHealth | null;
}

const EMPTY_SUMMARY: GatewayLatencyHistorySummary = {
  from: '',
  to: '',
  recordingSince: null,
  observedDays: [],
  unobservedDays: 0,
  days: [],
  keys: [],
  medianSecondsPerToken: null,
  observedKeys: 0,
  trend: null,
};

const EMPTY_VIEW: LatencyHistoryView = {
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
  medianSecondsPerToken: null,
  medianTokensPerSecond: null,
  elevatedKeys: 0,
  slowest: null,
  worstDay: null,
  joinedKeys: 0,
  failingJoined: 0,
  mixedJoins: 0,
};

export function deriveLatencyHistory(
  history: GatewayLatencyHistory | null | undefined,
  options: LatencyHistoryOptions = {},
): LatencyHistoryView {
  if (history === null || history === undefined) return EMPTY_VIEW;

  const summary = summarizeLatencyHistory(history);

  // The spine starts at the later of the window and the first night ever filed.
  // Padding backwards would draw the weeks before this table existed as weeks
  // the sweep missed — true of the scheduler and misleading about the gateway —
  // the same clamp, for the same reason, as the three sibling history cards.
  const { from, to } = history;
  const recordingSince = history.recordingSince;
  const spineFrom = recordingSince !== null && recordingSince > from ? recordingSince : from;
  const dates: string[] = [];
  if (from !== '' && to !== '' && spineFrom <= to) {
    for (let date = spineFrom; date <= to; date = shiftIso(date, 1)) dates.push(date);
  }

  const dayByDate = new Map(summary.days.map((day) => [day.date, day]));
  const days: LatencyHistoryDay[] = dates.map((date) => {
    const day = dayByDate.get(date);
    if (day === undefined) {
      return { date, observed: false, medianSecondsPerToken: null, keys: 0, models: 0 };
    }
    return {
      date,
      observed: true,
      medianSecondsPerToken: day.medianSecondsPerToken,
      keys: day.keys,
      models: day.models,
    };
  });

  // Per (alias, key) pair per night. Keyed on the pair rather than on the
  // endpoint alone — the opposite of the hang history, and forced by the
  // payload: two aliases behind one endpoint are two averages over two
  // workloads, and there is no weight anywhere in this layer with which to
  // combine them. A duplicate reading for one pair on one night is a re-sweep
  // and the later one wins, exactly as the shared roll-up resolves it.
  const byPair = new Map<string, Map<string, number>>();
  for (const observation of history.observations) {
    if (!Number.isFinite(observation.secondsPerToken) || observation.secondsPerToken <= 0) continue;
    const id = pairId(observation.model, observation.key);
    const nights = byPair.get(id) ?? new Map<string, number>();
    nights.set(observation.date, observation.secondsPerToken);
    byPair.set(id, nights);
  }

  const byKey = healthByLatencyKey(options.health?.deployments ?? []);

  const rows: LatencyHistoryRow[] = summary.keys.map((key) => {
    const nights = byPair.get(pairId(key.model, key.key)) ?? new Map<string, number>();
    const cells: LatencyCell[] = dates.map((date) => {
      const reading = nights.get(date);
      if (reading === undefined) {
        return { date, state: 'unobserved', secondsPerToken: null, ratioToOwnMedian: null };
      }
      const ratio =
        key.medianSecondsPerToken > 0 ? reading / key.medianSecondsPerToken : null;
      return {
        date,
        // Against the pair's *own* median rather than the gateway's: the strip
        // answers "was this endpoint slow for it", and a permanently slow
        // deployment drawn as sixty red cells says nothing the row's ratio
        // column does not already say.
        state: ratio !== null && ratio >= LATENCY_ELEVATED_RATIO ? 'slow' : 'fast',
        secondsPerToken: reading,
        ratioToOwnMedian: ratio,
      };
    });

    const match = byKey.get(key.key);
    return {
      ...key,
      cells,
      tokensPerSecond: tokensPerSecond(key.medianSecondsPerToken),
      msPerToken: key.medianSecondsPerToken * 1000,
      health: match === undefined ? 'unread' : match.state,
      behindKey: match?.deployments.length ?? 0,
    };
  });

  const observedDays = new Set(summary.observedDays);
  const worstDay = days.reduce<LatencyHistoryDay | null>((worst, day) => {
    if (!day.observed || day.medianSecondsPerToken === null) return worst;
    if (worst === null || day.medianSecondsPerToken > (worst.medianSecondsPerToken ?? 0)) return day;
    return worst;
  }, null);

  return {
    answered: true,
    isEmpty: summary.observedDays.length === 0,
    // A recording too short to split in half says nothing about a direction, and
    // a card that simply drew no direction would read as "unchanged".
    tooShort: summary.observedDays.length < LATENCY_TREND_MIN_DAYS,
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
    medianSecondsPerToken: summary.medianSecondsPerToken,
    medianTokensPerSecond:
      summary.medianSecondsPerToken === null
        ? null
        : tokensPerSecond(summary.medianSecondsPerToken),
    elevatedKeys: summary.keys.filter((key) => key.elevated).length,
    slowest: rows[0] ?? null,
    worstDay,
    joinedKeys: rows.filter((row) => row.health !== 'unread').length,
    failingJoined: rows.filter((row) => row.health === 'failing').length,
    mixedJoins: rows.filter((row) => row.health === 'mixed').length,
  };
}

/**
 * Which gate refused an unbadged pair, in the recording's terms.
 *
 * The live card's own two sentences restated over stored nights, and a row
 * rendering neither reads as fast. There is only one statistical gate to name
 * here — this payload carries no counts, so there is no interval to compute and
 * the badge can only ever be a materiality claim; `LATENCY_MIN_DAYS` is what
 * stands in for the evidence the proxy averaged away.
 */
export function latencyHistoryBadgeReason(row: GatewayLatencyHistoryKey): string {
  if (row.ratioToGateway === null) return 'no gateway median to compare against';
  if (row.daysObserved < LATENCY_MIN_DAYS) {
    return `${row.daysObserved} night${row.daysObserved === 1 ? '' : 's'} recorded — under the ${LATENCY_MIN_DAYS} this layer needs before it will say anything`;
  }
  if (row.ratioToGateway < LATENCY_ELEVATED_RATIO) {
    return `${row.ratioToGateway.toFixed(2)}× the gateway median — under the ${LATENCY_ELEVATED_RATIO}× this card calls material`;
  }
  return `${row.ratioToGateway.toFixed(2)}× the gateway median across ${row.daysObserved} recorded night${row.daysObserved === 1 ? '' : 's'}`;
}

/**
 * Why a direction is withheld, when it is.
 *
 * The layer's only silence — with no denominator to badge against and no
 * significance test available, the trend is the one statement that can be
 * absent — so a card drawing nothing where a direction belongs has to say which
 * of these it is.
 */
export function latencyTrendReason(view: LatencyHistoryView): string {
  if (view.isEmpty) return 'no night has been recorded yet';
  if (view.tooShort) {
    return `${view.daysRecorded} night${view.daysRecorded === 1 ? '' : 's'} recorded — a split needs ${LATENCY_TREND_MIN_DAYS}, so each half is three`;
  }
  return 'the earlier half carries no usable median';
}

interface HealthJoin {
  state: Exclude<LatencyHistoryHealthJoin, 'unread'>;
  deployments: GatewayDeployment[];
}

/**
 * Tonight's health snapshot, keyed the way `/model/metrics` keys a deployment.
 *
 * One-directional, like every join in this integration: the key cannot be parsed
 * back into a deployment. Several health rows landing on one key is ordinary
 * rather than pathological here — the latency key is the `api_base` alone
 * wherever there is one — so a disagreement is reported as `mixed` instead of
 * picked between.
 */
function healthByLatencyKey(deployments: readonly GatewayDeployment[]): Map<string, HealthJoin> {
  const grouped = new Map<string, GatewayDeployment[]>();
  for (const deployment of deployments) {
    const key = latencyDeploymentKey(deployment.backend, deployment.apiBase);
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [deployment]);
    else bucket.push(deployment);
  }

  const joins = new Map<string, HealthJoin>();
  for (const [key, bucket] of grouped) {
    const failing = bucket.filter((deployment) => !deployment.healthy);
    joins.set(key, {
      state:
        failing.length === 0 ? 'healthy' : failing.length === bucket.length ? 'failing' : 'mixed',
      deployments: bucket,
    });
  }
  return joins;
}

/**
 * The pair grain - (alias, key), joined on a character neither can contain.
 *
 * The separator matters rather than being pedantry: an alias and a backend model
 * string are both slash-and-dash shaped, so a naive join makes `gpt-4o` + `-eu`
 * and `gpt-4o-` + `eu` the same pair.
 */
function pairId(model: string, key: string): string {
  return `${model}\n${key}`;
}

/** Whether the card has anything to draw at all. */
export function hasLatencyHistory(view: LatencyHistoryView): boolean {
  return view.answered && !view.isEmpty && view.rows.length > 0;
}
