/**
 * How slow the backends were — `LiteLLM_SpendLogs` aggregated by the proxy,
 * read through `GET /model/metrics`.
 *
 * The gateway exports latency in exactly two places and they answer different
 * questions. `/spend/logs` carries `request_duration_ms` per row, which is the
 * truth for the requests it returns and a *biased* sample of the window: the
 * route has no sampling parameter, answers the head of the range, and is capped
 * at a few thousand rows out of millions. This route is the other one — the
 * proxy runs the aggregation itself, over every row in the window, and answers
 * one number per deployment per day.
 *
 * Four properties shape everything built on it, and three of them are traps:
 *
 *  1. **It is a rate, not a duration.** The SQL is
 *     `AVG(EXTRACT(epoch FROM ("endTime" - "startTime")) / NULLIF("completion_tokens", 0))`
 *     — *seconds per completion token*, averaged over requests. Multiplying it
 *     by anything to recover a request duration is a claim about a completion
 *     length this payload does not carry, so nothing here may be rendered as
 *     "how long a call took". The one honest re-reading is its reciprocal,
 *     tokens per second, which is the same fact with a friendlier unit.
 *  2. **The average is unweighted, per request.** It is a mean of per-request
 *     ratios rather than total seconds over total tokens, so a request that
 *     answered in one token carries the whole connection overhead in its ratio
 *     and counts as much as a two-thousand-token generation. That makes the
 *     figure sensitive to short answers in a way a throughput number is not —
 *     it is comparable *between* deployments serving similar work and is not a
 *     throughput measurement.
 *  3. **The key is an api_base, not a deployment.** LiteLLM builds the column
 *     name as the `api_base` when there is one and the backend model string
 *     when there is not, then cuts anything after `/openai/`. Two backend
 *     models behind the same base collapse onto one key *within a single
 *     response*, last row winning for that day — which is why the alias has to
 *     be carried by the caller and why `latencyDeploymentKey` exists rather
 *     than a parse.
 *  4. **It reads the request log.** Same table as `/spend/logs`, so
 *     `disable_spend_logs` empties this route too, its retention is the log's
 *     rather than the aggregates', and cache hits are excluded upstream
 *     (`cache_hit != 'True'`) — a cached answer has no backend latency to
 *     report. A deployment that only ever embedded is absent as well: the query
 *     has `HAVING SUM(completion_tokens) > 0`.
 */

/**
 * How many days of latency one read may ask for.
 *
 * A month, matching the exception layer and for the same reason: the proxy's own
 * default window on this route is thirty days, and the table underneath is
 * pruned on the request log's schedule rather than the aggregates' ninety days,
 * so a wider ask returns a shorter answer without saying so.
 */
export const LATENCY_MAX_WINDOW_DAYS = 31;

/**
 * How much slower than the gateway's median a deployment has to read before it
 * is worth a badge.
 *
 * A materiality ratio and nothing else, deliberately. The reliability card
 * guards its badge with a Wilson interval *and* a ratio, because it counts
 * events and can ask whether a difference is real. This payload carries no
 * counts at all — the proxy averaged them away and reports one number per day —
 * so there is no interval to compute and a badge here can only ever say "a lot
 * slower", never "certainly slower". `LATENCY_MIN_DAYS` is the substitute for
 * the evidence gate: one slow afternoon is not a slow deployment.
 */
export const LATENCY_ELEVATED_RATIO = 1.5;

/** How many days a key must have been observed before it may be badged. */
export const LATENCY_MIN_DAYS = 3;

/** One deployment key's latency on one day, as the proxy averaged it. */
export interface GatewayLatencyPoint {
  /** ISO date, UTC, as the proxy's `date_trunc('day')` produced it. */
  date: string;
  /** Seconds of wall clock per completion token. Never a request duration. */
  secondsPerToken: number;
}

/** Everything `GET /api/gateway/latency` returns. */
export interface GatewayLatency {
  /** The window asked for, inclusive ISO dates. */
  from: string;
  to: string;
  /** The aliases actually asked about — one proxy call each. */
  models: string[];
  /**
   * Aliases that existed in the window and were not asked about, because the
   * read is capped. Reported rather than dropped, for the same reason the
   * exception sweep reports them: a per-model route with a silent cap reads as
   * a gateway with nothing to say.
   */
  skippedModels: string[];
  /** One entry per (alias, key) pair, each carrying its own daily points. */
  series: {
    /** The public alias the read was scoped to. The query parameter, not the row. */
    model: string;
    /** LiteLLM's combined name — an api_base, or the backend model when there is none. */
    key: string;
    points: GatewayLatencyPoint[];
  }[];
  /**
   * The proxy's own `all_api_bases`, verbatim. Evidence rather than a source of
   * truth: it is the set of keys the same response already used, and it is kept
   * so a reader can tell a deployment that reported nothing from one the parse
   * dropped.
   */
  apiBases: string[];
  /**
   * Whether the proxy answered the route at all. False means refused, absent,
   * or a proxy running `disable_spend_logs` — never "the gateway was fast".
   */
  available: boolean;
  /** When the proxy was asked. Nothing is stored — this route is live. */
  fetchedAt: string;
}

/**
 * The key `/model/metrics` reports a deployment under, built from the parts
 * `gateway_deployment_health` holds.
 *
 * The join, and it only runs in this direction — the same rule as
 * `deploymentExceptionKey`, over a different formula. LiteLLM's own version:
 *
 * ```python
 * _combined_model_name = str(_model)
 * if _api_base is not None and "https://" in _api_base:
 *     _combined_model_name = str(_api_base)
 * if "/openai/" in _combined_model_name:
 *     _combined_model_name = _combined_model_name.split("/openai/")[0]
 * ```
 *
 * Two consequences worth stating where the function lives. A Bedrock deployment
 * carries no URL, so it is keyed by its model string and reads like an alias
 * while being a backend. And an Azure base *is* the key, so two models deployed
 * behind one endpoint are one key here — the collapse is upstream and cannot be
 * undone from the payload.
 */
export function latencyDeploymentKey(backend: string, apiBase: string | null): string {
  const combined = apiBase !== null && apiBase.includes('https://') ? apiBase : backend;
  const cut = combined.indexOf('/openai/');
  return cut === -1 ? combined : combined.slice(0, cut);
}

/**
 * Seconds per completion token read the friendly way round.
 *
 * The only transformation of this number that adds no claim: it is the same
 * measurement, inverted. Anything that multiplies it instead is asserting a
 * completion length.
 */
export function tokensPerSecond(secondsPerToken: number): number | null {
  return secondsPerToken > 0 ? 1 / secondsPerToken : null;
}

/** One (alias, key) pair over the window. */
export interface GatewayLatencyRow {
  model: string;
  key: string;
  points: GatewayLatencyPoint[];
  /** Days the proxy reported this key at all. Days it did not are unread, not fast. */
  days: number;
  /**
   * Mean of the daily means, unweighted.
   *
   * Unweighted because it has to be: the payload carries no request counts, so
   * a busy Wednesday and an idle Sunday arrive as two equally-sized numbers.
   * Stated rather than hidden, since it is the one place this layer could
   * pretend to a precision the route does not offer.
   */
  meanSecondsPerToken: number;
  /** The slowest day the proxy reported for this key. */
  worst: GatewayLatencyPoint;
  /** The fastest, for the spread — a key that is always slow is a different finding from one that spiked. */
  best: GatewayLatencyPoint;
  /** The mean read as throughput. Null only for a nonsensical zero. */
  tokensPerSecond: number | null;
  /** This key's mean over the gateway-wide median of key means. Null when there is no median. */
  ratioToMedian: number | null;
  /** Materially slower than the gateway, on enough days to mean it. */
  elevated: boolean;
}

/** The gateway's own reading for one day. */
export interface GatewayLatencyDay {
  date: string;
  /**
   * Median across the keys that reported that day.
   *
   * A median rather than a mean because the keys are not weighted and one
   * embedding-sized deployment would otherwise drag the day; and never a sum,
   * because rates do not add.
   */
  medianSecondsPerToken: number;
  /** How many keys reported. A day with fewer keys is a thinner reading, not a faster one. */
  keys: number;
}

export interface GatewayLatencySummary {
  from: string;
  to: string;
  available: boolean;
  /** True when the route answered and reported nothing at all. */
  empty: boolean;
  models: string[];
  skippedModels: string[];
  /** Slowest first. */
  rows: GatewayLatencyRow[];
  daily: GatewayLatencyDay[];
  /** Median of the row means — the number every ratio on the card is taken against. */
  medianSecondsPerToken: number | null;
  /** How many (alias, key) pairs reported anything. */
  observedKeys: number;
  fetchedAt: string;
}

/** Median of a non-empty list. Sorts a copy; the caller's order is meaningful elsewhere. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return ((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * Roll one window of `/model/metrics` rows up per key and per day.
 *
 * Pure, and with exactly one threshold of its own (`LATENCY_ELEVATED_RATIO`,
 * gated on `LATENCY_MIN_DAYS`) — which is one more than the exception layer
 * allows itself and for a reason: there, a count of errors has no denominator
 * anywhere in the payload, while here every key is measured in the same unit as
 * every other key, so "slower than the rest of this gateway" is a comparison the
 * data itself supports. What it still cannot support is *significance*: the
 * proxy averaged the requests away, so the badge is a materiality claim and
 * nothing more.
 */
export function summarizeGatewayLatency(payload: GatewayLatency): GatewayLatencySummary {
  const rows: Omit<GatewayLatencyRow, 'ratioToMedian' | 'elevated'>[] = [];

  for (const series of payload.series) {
    const points = [...series.points]
      .filter((point) => Number.isFinite(point.secondsPerToken) && point.secondsPerToken > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (points.length === 0) continue;

    const mean = points.reduce((sum, point) => sum + point.secondsPerToken, 0) / points.length;
    const worst = points.reduce((slowest, point) =>
      point.secondsPerToken > slowest.secondsPerToken ? point : slowest,
    );
    const best = points.reduce((fastest, point) =>
      point.secondsPerToken < fastest.secondsPerToken ? point : fastest,
    );

    rows.push({
      model: series.model,
      key: series.key,
      points,
      days: points.length,
      meanSecondsPerToken: mean,
      worst,
      best,
      tokensPerSecond: tokensPerSecond(mean),
    });
  }

  const gatewayMedian = median(rows.map((row) => row.meanSecondsPerToken));

  const ranked: GatewayLatencyRow[] = rows
    .map((row) => {
      const ratio =
        gatewayMedian === null || gatewayMedian <= 0 ? null : row.meanSecondsPerToken / gatewayMedian;
      return {
        ...row,
        ratioToMedian: ratio,
        elevated: ratio !== null && ratio >= LATENCY_ELEVATED_RATIO && row.days >= LATENCY_MIN_DAYS,
      };
    })
    .sort(
      (a, b) =>
        b.meanSecondsPerToken - a.meanSecondsPerToken ||
        a.model.localeCompare(b.model) ||
        a.key.localeCompare(b.key),
    );

  const byDate = new Map<string, number[]>();
  for (const row of ranked) {
    for (const point of row.points) {
      const bucket = byDate.get(point.date);
      if (bucket === undefined) byDate.set(point.date, [point.secondsPerToken]);
      else bucket.push(point.secondsPerToken);
    }
  }

  const daily: GatewayLatencyDay[] = [...byDate.entries()]
    .map(([date, values]) => ({
      date,
      medianSecondsPerToken: median(values) ?? 0,
      keys: values.length,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    from: payload.from,
    to: payload.to,
    available: payload.available,
    empty: payload.available && ranked.length === 0,
    models: payload.models,
    skippedModels: payload.skippedModels,
    rows: ranked,
    daily,
    medianSecondsPerToken: gatewayMedian,
    observedKeys: ranked.length,
    fetchedAt: payload.fetchedAt,
  };
}

/**
 * ---------------------------------------------------------------------------
 * The stored nights
 * ---------------------------------------------------------------------------
 *
 * `gateway_latency_daily` keeps one reading per (day, alias, key) — what the
 * nightly sweep asked the proxy for the day usage had just settled on. The live
 * summary above states what one window means; everything below states what a
 * *sequence* of nightly windows may be read to mean, and the difference from the
 * two sibling history layers is the only rule worth restating:
 *
 * **These readings are kept and compared. They are never pooled.** The hang and
 * exception histories add their counts across nights because the rows they came
 * from are disjoint events. A rate is not an event: the proxy already averaged
 * the requests away, so nothing here knows how much traffic produced a night's
 * number, and a total or a weighted mean of two nights is unavailable in
 * principle rather than merely unimplemented. Every window figure is therefore a
 * **median of nightly readings**, unweighted and said so, exactly as the live
 * layer's own row mean is.
 *
 * The consequences are the same three the live layer already carries — no
 * duration, no percentile, no SLA figure — plus one this layer adds: a night the
 * sweep did not run is unknown, never a fast night, so it is left out of the
 * series and counted instead.
 */

/** One stored reading, as `GET /api/gateway/latency/history` serves it. */
export interface GatewayLatencyObservation {
  /** UTC day the reading covers — the day swept, not the day the sweep ran. */
  date: string;
  /** The alias the sweep was scoped to. */
  model: string;
  /** `latencyDeploymentKey`'s output, as the proxy reported it. */
  key: string;
  /** Seconds of wall clock per completion token. Never a request duration. */
  secondsPerToken: number;
  /** When the sweep that produced this reading ran. */
  observedAt: string;
}

/** Everything `GET /api/gateway/latency/history` returns. */
export interface GatewayLatencyHistory {
  from: string;
  to: string;
  /**
   * The first night any reading was ever filed, answered outside the window for
   * the reason every history route here answers it: without it, "nothing has
   * been slow in thirty days" and "we started recording on Tuesday" are the same
   * empty list.
   */
  recordingSince: string | null;
  observations: GatewayLatencyObservation[];
}

/**
 * Observed nights needed before the recording may be split in half and compared.
 *
 * Six, matching the two sibling histories, and the gate is doing more work here
 * than in either of them: those compare pooled counts, while this compares a
 * median of medians over a sample that carries no weights at all. Three nights a
 * side is the fewest at which one unusual evening cannot own the answer.
 */
export const LATENCY_TREND_MIN_DAYS = 6;

/** The gateway's own reading for one recorded night. */
export interface GatewayLatencyHistoryDay {
  date: string;
  /**
   * Median across the (alias, key) pairs that reported that night.
   *
   * A median, never a mean and never a sum: the pairs carry no weights, so one
   * embedding-sized deployment would otherwise own the night, and rates do not
   * add in any case.
   */
  medianSecondsPerToken: number;
  /** How many pairs reported. A thin night is a thin reading, not a fast one. */
  keys: number;
  /** How many aliases contributed. The sweep's own cap and a quiet alias both lower it. */
  models: number;
}

/** One (alias, key) pair across every night it was observed. */
export interface GatewayLatencyHistoryKey {
  model: string;
  key: string;
  /**
   * Median of this pair's nightly readings.
   *
   * The window figure, and a median rather than the live layer's mean for one
   * reason: a window here is months rather than days, and a single incident
   * night in a quarter should not become the pair's standing rate.
   */
  medianSecondsPerToken: number;
  /** The same reading as throughput. Null only for a nonsensical zero. */
  tokensPerSecond: number | null;
  /** Nights carrying a reading of this pair. Evidence, never a duration. */
  daysObserved: number;
  /** Nights inside this pair's own first-to-last span that carry no reading. */
  unobservedDays: number;
  firstDate: string;
  lastDate: string;
  /** The slowest night recorded, and the fastest — a standing fault reads differently from a spike. */
  worstDay: GatewayLatencyPoint;
  bestDay: GatewayLatencyPoint;
  /** This pair's median over the gateway-wide median of pair medians. */
  ratioToGateway: number | null;
  /** Materially slower than the rest of the gateway, on enough nights to mean it. */
  elevated: boolean;
}

/**
 * The recording split into two halves of observed nights.
 *
 * Each half is a **median of that half's nightly gateway medians** — the only
 * summary this payload supports — and the movement is reported as a *ratio*
 * rather than in percentage points, which is the opposite choice from the hang
 * and exception trends and forced by the unit. Those two compare shares, where a
 * difference of shares is points; this compares a rate, where the meaningful
 * comparison is "1.4× the seconds per token it was", and a subtraction would
 * produce a number in seconds-per-token whose size depends on which models the
 * gateway happens to run.
 *
 * What it is not is a verdict. A gateway that shipped a classifier answering in
 * one token drags this number without anything having got slower (the average is
 * per request, so short answers carry their whole connection overhead), so the
 * trend is evidence about the reading and not about the backends.
 */
export interface GatewayLatencyTrend {
  earlier: { from: string; to: string; days: number; medianSecondsPerToken: number };
  recent: { from: string; to: string; days: number; medianSecondsPerToken: number };
  /** recent ÷ earlier. Above 1 is slower per token. */
  ratio: number;
}

export interface GatewayLatencyHistorySummary {
  from: string;
  to: string;
  recordingSince: string | null;
  /** Nights carrying at least one reading, ascending. The sample, not the calendar. */
  observedDays: string[];
  /**
   * Calendar nights inside the window carrying no reading at all, counted from
   * `recordingSince` forward — a night before recording started is not a gap.
   * Never filled in.
   */
  unobservedDays: number;
  days: GatewayLatencyHistoryDay[];
  /** Slowest first. */
  keys: GatewayLatencyHistoryKey[];
  /** Median of the pair medians — what every ratio here is taken against. */
  medianSecondsPerToken: number | null;
  /** How many (alias, key) pairs reported anything. */
  observedKeys: number;
  trend: GatewayLatencyTrend | null;
}

/** `2026-07-31`, `2026-07-28` → 3. Both UTC midnights, so DST never shifts it. */
function daysBetweenIso(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Stored nightly readings → what each deployment has been doing.
 *
 * Pure, and it adds **no threshold the live layer does not already have**:
 * `LATENCY_ELEVATED_RATIO` gated on `LATENCY_MIN_DAYS`, restated over stored
 * nights, because a longer recording is more evidence rather than a different
 * question. Its one new statement is the trend, and that is a ratio of two
 * medians rather than anything pooled — see `GatewayLatencyTrend`.
 *
 * Three rules carry the rest, and all three are inherited:
 *
 *  - a reading is a rate per completion token, so nothing here is a duration;
 *  - readings are never added, weighted or averaged across nights or across
 *    aliases — the window figure is a median, and the (alias, key) pair is the
 *    grain because two aliases on one endpoint measured two different workloads;
 *  - a night with no reading is unknown: left out of the series, counted in
 *    `unobservedDays`, never drawn as a fast night.
 */
export function summarizeLatencyHistory(
  history: GatewayLatencyHistory,
): GatewayLatencyHistorySummary {
  const byDay = new Map<string, { values: number[]; models: Set<string> }>();
  const byPair = new Map<
    string,
    { model: string; key: string; points: Map<string, number> }
  >();

  for (const observation of history.observations) {
    if (!Number.isFinite(observation.secondsPerToken) || observation.secondsPerToken <= 0) continue;

    const day = byDay.get(observation.date);
    if (day === undefined) {
      byDay.set(observation.date, {
        values: [observation.secondsPerToken],
        models: new Set([observation.model]),
      });
    } else {
      day.values.push(observation.secondsPerToken);
      day.models.add(observation.model);
    }

    const id = `${observation.model}\u0000${observation.key}`;
    const pair = byPair.get(id);
    if (pair === undefined) {
      byPair.set(id, {
        model: observation.model,
        key: observation.key,
        points: new Map([[observation.date, observation.secondsPerToken]]),
      });
    } else {
      // One reading per pair per night by construction (the table's primary key
      // is that grain), so a duplicate is a re-sweep and the last one wins —
      // never a mean of the two, which would be the pooling this layer forbids.
      pair.points.set(observation.date, observation.secondsPerToken);
    }
  }

  const days: GatewayLatencyHistoryDay[] = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, day]) => ({
      date,
      medianSecondsPerToken: median(day.values) ?? 0,
      keys: day.values.length,
      models: day.models.size,
    }));
  const observedDays = days.map((day) => day.date);

  const pairs = [...byPair.values()].map((pair) => {
    const entries = [...pair.points.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const points: GatewayLatencyPoint[] = entries.map(([date, secondsPerToken]) => ({
      date,
      secondsPerToken,
    }));
    const values = points.map((point) => point.secondsPerToken);
    const pairMedian = median(values) ?? 0;
    const worstDay = points.reduce((slowest, point) =>
      point.secondsPerToken > slowest.secondsPerToken ? point : slowest,
    );
    const bestDay = points.reduce((fastest, point) =>
      point.secondsPerToken < fastest.secondsPerToken ? point : fastest,
    );
    const first = points[0]!;
    const last = points[points.length - 1]!;
    return {
      model: pair.model,
      key: pair.key,
      medianSecondsPerToken: pairMedian,
      tokensPerSecond: tokensPerSecond(pairMedian),
      daysObserved: points.length,
      // Gaps inside the pair's *own* span rather than the window's: a deployment
      // added last week has not been unread for the month before it existed.
      unobservedDays: Math.max(
        0,
        daysBetweenIso(first.date, last.date) + 1 - points.length,
      ),
      firstDate: first.date,
      lastDate: last.date,
      worstDay,
      bestDay,
    };
  });

  const gatewayMedian = median(pairs.map((pair) => pair.medianSecondsPerToken));

  const keys: GatewayLatencyHistoryKey[] = pairs
    .map((pair) => {
      const ratio =
        gatewayMedian === null || gatewayMedian <= 0
          ? null
          : pair.medianSecondsPerToken / gatewayMedian;
      return {
        ...pair,
        ratioToGateway: ratio,
        elevated:
          ratio !== null && ratio >= LATENCY_ELEVATED_RATIO && pair.daysObserved >= LATENCY_MIN_DAYS,
      };
    })
    .sort(
      (a, b) =>
        b.medianSecondsPerToken - a.medianSecondsPerToken ||
        a.model.localeCompare(b.model) ||
        a.key.localeCompare(b.key),
    );

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
    medianSecondsPerToken: gatewayMedian,
    observedKeys: keys.length,
    trend: buildLatencyTrend(days),
  };
}

/**
 * Split the observed nights down the middle and take each half's median.
 *
 * The split is on *observed* nights rather than on the calendar, so a fortnight
 * the scheduler was down shifts the boundary instead of emptying a half; an odd
 * number gives the extra night to the recent half, because the question is about
 * now. Both halves are medians of nightly medians — the one summary a sample
 * with no weights supports.
 */
function buildLatencyTrend(days: GatewayLatencyHistoryDay[]): GatewayLatencyTrend | null {
  if (days.length < LATENCY_TREND_MIN_DAYS) return null;
  const cut = Math.floor(days.length / 2);
  const earlierDays = days.slice(0, cut);
  const recentDays = days.slice(cut);

  const earlierMedian = median(earlierDays.map((day) => day.medianSecondsPerToken));
  const recentMedian = median(recentDays.map((day) => day.medianSecondsPerToken));
  if (earlierMedian === null || recentMedian === null || earlierMedian <= 0) return null;

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
      medianSecondsPerToken: earlierMedian,
    },
    recent: {
      from: firstRecent.date,
      to: last.date,
      days: recentDays.length,
      medianSecondsPerToken: recentMedian,
    },
    ratio: recentMedian / earlierMedian,
  };
}
