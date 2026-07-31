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
