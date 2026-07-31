/**
 * How many calls hung — `LiteLLM_SpendLogs` counted by the proxy, read through
 * `GET /model/metrics/slow_responses`.
 *
 * The fourth live read and the last thing the gateway will say about a request
 * that did not fail. The three that came before it each answer a different
 * question about the same traffic and none of them can answer this one:
 *
 *  - `failed_requests` on the daily aggregates says how many calls **failed**.
 *    A call that took four minutes and then answered is a success there.
 *  - `/model/metrics/exceptions` says **why** the failed ones failed. A hang
 *    that resolved wrote no error log at all.
 *  - `/model/metrics` says how many **seconds per completion token** the
 *    successful ones averaged. A long answer at a normal per-token rate takes a
 *    long time and reads perfectly ordinary there, which is exactly the shape of
 *    a request somebody is waiting on.
 *
 * This route is the only one that measures **wall clock against a threshold**:
 * upstream it is
 * `SUM(CASE WHEN ("endTime" - "startTime") >= INTERVAL '1 second' * $1 THEN 1 ELSE 0 END)`
 * beside a `COUNT(*)`, grouped by `api_base`. Four properties shape everything
 * built on it, and three of them are traps.
 *
 *  1. **The threshold is the proxy's and is not in the response.** `$1` is
 *     `proxy_logging_obj.slack_alerting_instance.alerting_threshold`, falling
 *     back to `DEFAULT_SLACK_ALERTING_THRESHOLD` — 300 seconds unless somebody
 *     configured otherwise, and the payload never says which. So the count is
 *     "requests at or over the proxy's own alerting threshold" and may never be
 *     rendered with a number of seconds attached to it. `SLOW_RESPONSE_DEFAULT_THRESHOLD_SECONDS`
 *     exists to *describe* the default in prose, never to label the reading.
 *  2. **It carries its own denominator, and it is not the ledger's.**
 *     `total_count` counts the request-log rows this route grouped — the same
 *     window, the same alias, cache hits excluded (`cache_hit != 'True'`) — so a
 *     slow *share* is computable here, which is the one thing the exception
 *     layer cannot do. It is emphatically not a share of gateway requests: the
 *     ledger counts cached answers and lives in another table on another
 *     retention schedule.
 *  3. **The key is an api_base and nothing else.** Coarser than either sibling.
 *     `/model/metrics/exceptions` keys by `model-api_base` (both parts) and
 *     `/model/metrics` falls back to the backend model string when there is no
 *     base; this route selects `api_base` alone, groups on it, and answers `""`
 *     for a null. Every deployment of an alias that is addressed by region
 *     rather than by URL — Bedrock, Vertex — is therefore *one row* under the
 *     empty key, and there is nothing in the payload to split them with.
 *  4. **It reads the request log.** Same table as `/spend/logs` and
 *     `/model/metrics`, so `disable_spend_logs` empties this route too, its
 *     retention is the log's rather than the aggregates' ninety days, and cache
 *     hits are excluded upstream — a cached answer was never slow.
 */

/**
 * How many days of slow-response counts one read may ask for.
 *
 * A month, matching the exception and latency sweeps and for the same two
 * reasons: the proxy's own default window on this route is `DAYS_IN_A_MONTH`,
 * and the table underneath is pruned on the request log's schedule rather than
 * the aggregates', so a wider ask answers a shorter window without saying so.
 */
export const SLOW_RESPONSE_MAX_WINDOW_DAYS = 31;

/**
 * The threshold LiteLLM uses when nobody configured one — for prose only.
 *
 * `DEFAULT_SLACK_ALERTING_THRESHOLD = int(os.getenv("DEFAULT_SLACK_ALERTING_THRESHOLD", 300))`,
 * overridden by whatever `alerting_threshold` the proxy's Slack alerting was
 * set up with. The response carries neither number, so this constant may
 * describe what "slow" probably means on an unconfigured proxy and may never be
 * attached to a reading as though it were the threshold in force.
 */
export const SLOW_RESPONSE_DEFAULT_THRESHOLD_SECONDS = 300;

/**
 * The key a deployment with no `api_base` is reported under.
 *
 * Not a deployment: the proxy's `GROUP BY api_base` collapses every one of
 * them into a single row per alias and `row.get("api_base") or ""` names it the
 * empty string. Given its own constant so nothing renders a blank column and
 * nothing treats it as an addressable backend.
 */
export const UNKEYED_DEPLOYMENT = '(no api_base)';

/**
 * The key `/model/metrics/slow_responses` reports a deployment under, built
 * from the parts `gateway_deployment_health` holds.
 *
 * The join, and it only runs in this direction — the third one-directional key
 * in this integration, and the coarsest. LiteLLM's own version is the whole of
 * the route's post-processing:
 *
 * ```python
 * _api_base = row.get("api_base") or ""
 * if "/openai/" in _api_base:
 *     _api_base = _api_base.split("/openai/")[0]
 * ```
 *
 * Two consequences, both worth stating where the function lives. There is **no
 * fallback to the backend model string**, unlike `latencyDeploymentKey` — a
 * deployment with no base is not named at all, and every such deployment of
 * every alias in one call lands in a single `GROUP BY` bucket. And an Azure
 * base *is* the key, so several models behind one endpoint collapse together
 * exactly as they do on `/model/metrics`. A health verdict taken across a key
 * that several deployments share can therefore only be a verdict about the
 * whole endpoint.
 */
export function slowResponseDeploymentKey(apiBase: string | null): string {
  const base = (apiBase ?? '').trim();
  if (base === '') return UNKEYED_DEPLOYMENT;
  const cut = base.indexOf('/openai/');
  return cut === -1 ? base : base.slice(0, cut);
}

/**
 * How much slower-prone than the gateway a key has to read before it is badged.
 *
 * The same materiality ratio the reliability card uses, and — unlike the
 * latency layer next door — it is paired with a real significance test, because
 * this payload does carry counts. Two gates guarding opposite regimes: the
 * interval kills a key that hung once out of three calls, the ratio kills a key
 * that is 0.4% against a 0.35% gateway across a hundred thousand requests.
 */
export const SLOW_RESPONSE_ELEVATED_RATIO = 1.5;

/** Hangs required before a key may be badged at all — the materiality floor. */
export const SLOW_RESPONSE_MIN_COUNT = 5;

/** Normal quantile for the Wilson lower bound. 1.96 ≈ 95%. */
export const SLOW_RESPONSE_CONFIDENCE_Z = 1.96;

/** One `api_base` group, for one alias, over the window the proxy was asked about. */
export interface GatewaySlowResponseRecord {
  /** The public alias the read was scoped to — the query parameter, not the row. */
  model: string;
  /** LiteLLM's `api_base`, cut at `/openai/`, or `UNKEYED_DEPLOYMENT` for a null. */
  key: string;
  /** Request-log rows the proxy grouped. Cache hits excluded upstream. */
  total: number;
  /** Of those, how many ran at or past the proxy's own alerting threshold. */
  slow: number;
}

/** Everything `GET /api/gateway/slow-responses` returns. */
export interface GatewaySlowResponses {
  /** The window asked for, inclusive ISO dates. */
  from: string;
  to: string;
  /** The aliases actually asked about — one proxy call each. */
  models: string[];
  /**
   * Aliases that existed in the window and were not asked about, because the
   * read is capped. Reported rather than dropped: a capped per-model sweep that
   * says nothing about the cap reads as a gateway with nothing hanging.
   */
  skippedModels: string[];
  rows: GatewaySlowResponseRecord[];
  /**
   * Whether the proxy answered at all. False means refused, absent, or a proxy
   * running `disable_spend_logs` — never "nothing hung".
   */
  available: boolean;
  /** When the proxy was asked. Nothing is stored — this route is live. */
  fetchedAt: string;
}

/** One deployment key rolled up across the aliases that routed to it. */
export interface GatewaySlowResponseRow {
  key: string;
  /** The aliases whose traffic this key served, in the order they were asked. */
  models: string[];
  total: number;
  slow: number;
  /** Slow over total for this key. Null when the key served nothing. */
  slowShare: number | null;
  /** This key's share over the gateway-wide share. Null when either is unusable. */
  ratioToGateway: number | null;
  /**
   * Materially and measurably more prone to hanging than the rest of the
   * gateway — both gates, never one.
   */
  elevated: boolean;
}

export interface GatewaySlowResponseSummary {
  from: string;
  to: string;
  available: boolean;
  /** True when the route answered and grouped nothing at all. */
  empty: boolean;
  models: string[];
  skippedModels: string[];
  /** Most hangs first, then by share — the ranking a reader acts on. */
  rows: GatewaySlowResponseRow[];
  /** Requests the route grouped across every key. Never a gateway request count. */
  total: number;
  /** Hangs across every key. */
  slow: number;
  /** Gateway-wide slow share — the denominator every ratio is taken against. */
  slowShare: number | null;
  /** How many keys the sweep saw. */
  observedKeys: number;
  fetchedAt: string;
}

/**
 * Lower bound of the Wilson score interval for `hits / trials`, 0..1.
 *
 * The same statistic the reliability card computes over the ledger's failures,
 * restated here rather than imported from it because the two read different
 * tables and neither may borrow the other's numbers — and because `@dash/shared`
 * cannot import from `apps/web`. Wilson rather than the normal approximation
 * for the reason that card states: at rates near zero the textbook interval runs
 * negative, which is the regime every quiet key is in.
 */
export function wilsonScoreLowerBound(hits: number, trials: number, z: number): number {
  if (trials <= 0 || hits <= 0) return 0;
  const rate = hits / trials;
  const z2 = z * z;
  const centre = rate + z2 / (2 * trials);
  const margin = z * Math.sqrt((rate * (1 - rate) + z2 / (4 * trials)) / trials);
  return Math.max(0, (centre - margin) / (1 + z2 / trials));
}

/**
 * Roll one `/model/metrics/slow_responses` sweep up per deployment key.
 *
 * Per *key* rather than per (alias, key) pair, which is the opposite of the
 * latency layer's choice and is forced by the route: the proxy groups on
 * `api_base` alone, so one Azure endpoint answering four aliases returns the
 * same endpoint four times with four disjoint counts of the same deployment's
 * traffic. Adding them is the honest reading — they are counts of requests, they
 * do not overlap, and unlike a rate they may be summed. The aliases are kept
 * beside the row so a reader can see which traffic it covers.
 *
 * Two gates on the badge, and this is the one live read that can afford both:
 * the payload carries a count and a denominator, so `wilsonScoreLowerBound` can ask
 * whether a difference is real and `SLOW_RESPONSE_ELEVATED_RATIO` can ask
 * whether it is worth anybody's afternoon. The latency layer next door has only
 * the second because the proxy averaged its counts away.
 */
export function summarizeGatewaySlowResponses(
  payload: GatewaySlowResponses,
): GatewaySlowResponseSummary {
  const byKey = new Map<string, { key: string; models: string[]; total: number; slow: number }>();

  for (const record of payload.rows) {
    if (!Number.isFinite(record.total) || record.total <= 0) continue;
    const existing = byKey.get(record.key);
    if (existing === undefined) {
      byKey.set(record.key, {
        key: record.key,
        models: [record.model],
        total: record.total,
        slow: record.slow,
      });
    } else {
      if (!existing.models.includes(record.model)) existing.models.push(record.model);
      existing.total += record.total;
      existing.slow += record.slow;
    }
  }

  const total = [...byKey.values()].reduce((sum, row) => sum + row.total, 0);
  const slow = [...byKey.values()].reduce((sum, row) => sum + row.slow, 0);
  const gatewayShare = total > 0 ? slow / total : null;

  const rows: GatewaySlowResponseRow[] = [...byKey.values()]
    .map((row) => {
      const share = row.total > 0 ? row.slow / row.total : null;
      const ratio =
        share === null || gatewayShare === null || gatewayShare <= 0 ? null : share / gatewayShare;
      const significant =
        gatewayShare !== null &&
        wilsonScoreLowerBound(row.slow, row.total, SLOW_RESPONSE_CONFIDENCE_Z) > gatewayShare;
      return {
        key: row.key,
        models: row.models,
        total: row.total,
        slow: row.slow,
        slowShare: share,
        ratioToGateway: ratio,
        elevated:
          significant &&
          row.slow >= SLOW_RESPONSE_MIN_COUNT &&
          ratio !== null &&
          ratio >= SLOW_RESPONSE_ELEVATED_RATIO,
      };
    })
    .sort(
      (a, b) => b.slow - a.slow || (b.slowShare ?? 0) - (a.slowShare ?? 0) || a.key.localeCompare(b.key),
    );

  return {
    from: payload.from,
    to: payload.to,
    available: payload.available,
    empty: payload.available && rows.length === 0,
    models: payload.models,
    skippedModels: payload.skippedModels,
    rows,
    total,
    slow,
    slowShare: gatewayShare,
    observedKeys: rows.length,
    fetchedAt: payload.fetchedAt,
  };
}

/* ------------------------------------------------------------------------- *
 * The stored roll-up: what the sweep said, kept.
 * ------------------------------------------------------------------------- */

/**
 * One night's reading of one deployment key under one alias.
 *
 * The route is live and the window it answers is whatever it was asked for; a
 * *stored* reading is always one UTC day, because the nightly sync asks about
 * exactly the day it has just finished pulling usage for. That is what makes
 * these rows addable across days — they are disjoint counts of request-log rows,
 * the one quantity in this integration that may be summed in both directions.
 */
export interface GatewaySlowResponseObservation {
  /** The UTC day the counts cover — not the day the sweep ran. */
  date: string;
  /** The alias the read was scoped to: the query parameter, not the row. */
  model: string;
  /** `slowResponseDeploymentKey`'s output; `UNKEYED_DEPLOYMENT` for a deployment with no base. */
  key: string;
  total: number;
  slow: number;
  /** When the sweep that produced this row ran. */
  observedAt: string;
}

/** Everything `GET /api/gateway/slow-responses/history` returns. */
export interface GatewaySlowResponseHistory {
  from: string;
  to: string;
  /**
   * The first day any reading was ever filed, answered outside the window for
   * the same reason the health history answers it: without it, "nothing has hung
   * in thirty days" and "we started recording on Tuesday" are the same empty
   * list, and only the first of them is a finding.
   */
  recordingSince: string | null;
  observations: GatewaySlowResponseObservation[];
}

/**
 * Observed days needed before the window may be split into two halves and
 * compared.
 *
 * Six, so each half is three nights. Fewer than that and the split is one busy
 * afternoon against another: this sample is nightly and a single day's traffic
 * mix moves the pooled share more than any trend does. It is a count of
 * *observed* days rather than calendar ones, because a scheduler that missed
 * four nights has not accumulated evidence it did not gather.
 */
export const SLOW_RESPONSE_TREND_MIN_DAYS = 6;

/** Gateway-wide, for one day that carries readings. */
export interface GatewaySlowResponseHistoryDay {
  date: string;
  total: number;
  slow: number;
  /** Slow over total for the day. Null when nothing was grouped. */
  share: number | null;
  /** How many deployment keys reported this day — the day's coverage, not the gateway's size. */
  keys: number;
  /** How many aliases were swept this day. The cap and a quiet alias both lower it. */
  models: number;
}

/** One deployment key across every day it was observed. */
export interface GatewaySlowResponseHistoryKey {
  key: string;
  /** The aliases whose traffic routed here, ascending. */
  models: string[];
  total: number;
  slow: number;
  share: number | null;
  /** This key's share over the window-wide share. Null when either is unusable. */
  ratioToGateway: number | null;
  /**
   * Both gates over the pooled counts — the same test the live card applies to
   * a window, restated over the stored days. The history adds no threshold of
   * its own.
   */
  elevated: boolean;
  /** slow − total × window share. Signed, and sums to zero across every key. */
  excessSlow: number;
  /** Days carrying a reading of this key. Evidence, never a duration. */
  daysObserved: number;
  /** Of those, how many recorded at least one hang. */
  daysWithHangs: number;
  firstDate: string;
  lastDate: string;
  /** The observed day with the highest share, needing at least one hang to qualify. */
  worstDay: { date: string; share: number; slow: number; total: number } | null;
}

/**
 * The window split in two halves of observed days and pooled.
 *
 * Pooled counts rather than a mean of daily shares, because the shares are of
 * wildly different denominators — a quiet Sunday's 2-of-8 would otherwise weigh
 * as much as a Wednesday's 40-of-90,000. Reported in percentage points for the
 * reason every rate on this dashboard is: a share going 0.4% to 0.6% is +0.2
 * points, and "+50%" is a different and much louder claim.
 */
export interface GatewaySlowResponseTrend {
  earlier: { from: string; to: string; days: number; total: number; slow: number; share: number };
  recent: { from: string; to: string; days: number; total: number; slow: number; share: number };
  deltaPoints: number;
}

export interface GatewaySlowResponseHistorySummary {
  from: string;
  to: string;
  recordingSince: string | null;
  /** Days carrying at least one reading, ascending. The sample, not the calendar. */
  observedDays: string[];
  /**
   * Calendar days inside the window that carry no reading at all, counted from
   * `recordingSince` forward — a day before recording started is not a gap.
   * Never filled in: an unread night is unknown, not a night nothing hung.
   */
  unobservedDays: number;
  days: GatewaySlowResponseHistoryDay[];
  /** Most hangs first, then by share — the ranking a reader acts on. */
  keys: GatewaySlowResponseHistoryKey[];
  total: number;
  slow: number;
  /** Window-wide share, and the denominator every ratio here is taken against. */
  share: number | null;
  trend: GatewaySlowResponseTrend | null;
}

/** `2026-07-31`, `2026-07-28` → 3. Both UTC midnights, so DST never shifts it. */
function daysBetweenIso(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Stored readings → what each deployment key did across the window.
 *
 * Pure, and the counterpart to `summarizeGatewaySlowResponses` in the same way
 * `summarizeDeploymentHistory` is to `summarizeDeploymentHealth`: that one
 * states the rule over one window the proxy answered, this one states what a
 * *sequence* of nightly windows may be read to mean. Four rules carry it, and
 * three are inherited rather than new:
 *
 *  - counts add, across the sweep and across days, because they are disjoint
 *    request-log rows — which is the only reason this table exists where the
 *    exception and latency sweeps have none;
 *  - every share is of the route's own denominator, never of gateway traffic;
 *  - the badge is the live card's two gates over the pooled counts, unchanged:
 *    a stored window is more evidence, not a different question;
 *  - a day with no reading is unknown. It is left out of the day series, counted
 *    in `unobservedDays`, and never zero-filled — a night the sweep was refused
 *    and a night nothing hung would otherwise draw identically.
 */
export function summarizeSlowResponseHistory(
  history: GatewaySlowResponseHistory,
): GatewaySlowResponseHistorySummary {
  const byDay = new Map<string, { total: number; slow: number; keys: Set<string>; models: Set<string> }>();
  const byKey = new Map<
    string,
    {
      key: string;
      models: Set<string>;
      total: number;
      slow: number;
      days: Map<string, { total: number; slow: number }>;
    }
  >();

  for (const observation of history.observations) {
    if (!Number.isFinite(observation.total) || observation.total <= 0) continue;

    const day = byDay.get(observation.date);
    if (day === undefined) {
      byDay.set(observation.date, {
        total: observation.total,
        slow: observation.slow,
        keys: new Set([observation.key]),
        models: new Set([observation.model]),
      });
    } else {
      day.total += observation.total;
      day.slow += observation.slow;
      day.keys.add(observation.key);
      day.models.add(observation.model);
    }

    const key = byKey.get(observation.key);
    if (key === undefined) {
      byKey.set(observation.key, {
        key: observation.key,
        models: new Set([observation.model]),
        total: observation.total,
        slow: observation.slow,
        days: new Map([[observation.date, { total: observation.total, slow: observation.slow }]]),
      });
    } else {
      key.models.add(observation.model);
      key.total += observation.total;
      key.slow += observation.slow;
      // Two aliases routing to one endpoint on the same night are two disjoint
      // counts of that endpoint's traffic, so the day's reading is their sum —
      // the same addition `summarizeGatewaySlowResponses` performs across a
      // sweep, performed here across a sweep *and* a calendar.
      const existing = key.days.get(observation.date);
      if (existing === undefined) {
        key.days.set(observation.date, { total: observation.total, slow: observation.slow });
      } else {
        existing.total += observation.total;
        existing.slow += observation.slow;
      }
    }
  }

  const days: GatewaySlowResponseHistoryDay[] = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, day]) => ({
      date,
      total: day.total,
      slow: day.slow,
      share: day.total > 0 ? day.slow / day.total : null,
      keys: day.keys.size,
      models: day.models.size,
    }));
  const observedDays = days.map((day) => day.date);

  const total = days.reduce((sum, day) => sum + day.total, 0);
  const slow = days.reduce((sum, day) => sum + day.slow, 0);
  const windowShare = total > 0 ? slow / total : null;

  const keys: GatewaySlowResponseHistoryKey[] = [...byKey.values()]
    .map((row) => {
      const share = row.total > 0 ? row.slow / row.total : null;
      const ratio =
        share === null || windowShare === null || windowShare <= 0 ? null : share / windowShare;
      const significant =
        windowShare !== null &&
        wilsonScoreLowerBound(row.slow, row.total, SLOW_RESPONSE_CONFIDENCE_Z) > windowShare;
      const dayEntries = [...row.days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const dates = dayEntries.map(([date]) => date);
      let worstDay: GatewaySlowResponseHistoryKey['worstDay'] = null;
      let daysWithHangs = 0;
      for (const [date, day] of dayEntries) {
        if (day.slow <= 0) continue;
        daysWithHangs += 1;
        const dayShare = day.slow / day.total;
        if (worstDay === null || dayShare > worstDay.share) {
          worstDay = { date, share: dayShare, slow: day.slow, total: day.total };
        }
      }
      return {
        key: row.key,
        models: [...row.models].sort(),
        total: row.total,
        slow: row.slow,
        share,
        ratioToGateway: ratio,
        elevated:
          significant &&
          row.slow >= SLOW_RESPONSE_MIN_COUNT &&
          ratio !== null &&
          ratio >= SLOW_RESPONSE_ELEVATED_RATIO,
        excessSlow: windowShare === null ? 0 : row.slow - row.total * windowShare,
        daysObserved: dates.length,
        daysWithHangs,
        firstDate: dates[0] ?? '',
        lastDate: dates[dates.length - 1] ?? '',
        worstDay,
      };
    })
    .sort((a, b) => b.slow - a.slow || (b.share ?? 0) - (a.share ?? 0) || a.key.localeCompare(b.key));

  // Gaps are counted from the first day anything was ever recorded, so the
  // stretch before this dashboard was watching is not reported as missing data.
  const start =
    history.recordingSince !== null && history.recordingSince > history.from
      ? history.recordingSince
      : history.from;
  const span = start > history.to ? 0 : daysBetweenIso(start, history.to) + 1;
  const observedInSpan = observedDays.filter((date) => date >= start && date <= history.to).length;

  return {
    from: history.from,
    to: history.to,
    recordingSince: history.recordingSince,
    observedDays,
    unobservedDays: Math.max(0, span - observedInSpan),
    days,
    keys,
    total,
    slow,
    share: windowShare,
    trend: buildTrend(days),
  };
}

/**
 * Split the observed days down the middle and pool each half.
 *
 * The split is on *observed* days rather than on the calendar, so a fortnight
 * the scheduler was down shifts the boundary instead of emptying a half. An odd
 * number of days gives the extra one to the recent half, because the question
 * the card asks is about now.
 */
function buildTrend(days: GatewaySlowResponseHistoryDay[]): GatewaySlowResponseTrend | null {
  if (days.length < SLOW_RESPONSE_TREND_MIN_DAYS) return null;
  const cut = Math.floor(days.length / 2);
  const earlierDays = days.slice(0, cut);
  const recentDays = days.slice(cut);

  const pool = (window: GatewaySlowResponseHistoryDay[]) => {
    const total = window.reduce((sum, day) => sum + day.total, 0);
    const slow = window.reduce((sum, day) => sum + day.slow, 0);
    return { total, slow, share: total > 0 ? slow / total : 0 };
  };

  const earlier = pool(earlierDays);
  const recent = pool(recentDays);
  if (earlier.total <= 0 || recent.total <= 0) return null;

  const first = earlierDays[0];
  const lastEarlier = earlierDays[earlierDays.length - 1];
  const firstRecent = recentDays[0];
  const last = recentDays[recentDays.length - 1];
  if (
    first === undefined ||
    lastEarlier === undefined ||
    firstRecent === undefined ||
    last === undefined
  ) {
    return null;
  }

  return {
    earlier: {
      from: first.date,
      to: lastEarlier.date,
      days: earlierDays.length,
      total: earlier.total,
      slow: earlier.slow,
      share: earlier.share,
    },
    recent: {
      from: firstRecent.date,
      to: last.date,
      days: recentDays.length,
      total: recent.total,
      slow: recent.slow,
      share: recent.share,
    },
    deltaPoints: (recent.share - earlier.share) * 100,
  };
}
