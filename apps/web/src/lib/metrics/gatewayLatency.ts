import {
  LATENCY_ELEVATED_RATIO,
  LATENCY_MAX_WINDOW_DAYS,
  LATENCY_MIN_DAYS,
  latencyDeploymentKey,
  summarizeGatewayLatency,
  tokensPerSecond,
} from '@dash/shared';
import type {
  GatewayDailyPoint,
  GatewayDeployment,
  GatewayHealth,
  GatewayLatency,
  GatewayLatencyDay,
  GatewayLatencyRow,
} from '@dash/shared';
import { shiftIso } from './gateway.js';

/**
 * How slowly the backends answered, as the page reads it.
 *
 * Every other gateway surface here is money, volume or a count of failures.
 * This is the only one that is *time*, and the only number the proxy exports
 * about it at all: `GET /model/metrics` answers
 * `AVG(seconds / completion_tokens)` per deployment per day, and
 * `summarizeGatewayLatency` in `@dash/shared` is the single statement of what a
 * window of those readings means.
 *
 * This module adds no rule about the gateway. It adds five about the *reading*,
 * every one of them forced by the layer rather than chosen by the view:
 *
 *  - **It is a rate, never a duration.** Seconds per completion token, averaged
 *    per request. Nothing here may be rendered as how long a call took, as a
 *    percentile or as an SLA figure, and the only transformation that adds no
 *    claim is its reciprocal — which is why `tokensPerSecond` is the one derived
 *    unit and there is no "×1,000 tokens = 12s" anywhere.
 *  - **It is keyed below the alias, and the key collapses.** The row key is an
 *    `api_base` where there is one, so two backend models deployed behind one
 *    Azure endpoint are one key — upstream, inside a single response, with
 *    nothing in the payload to undo it. The join to `gateway_deployment_health`
 *    therefore has a state the exception card did not need: `mixed`, where the
 *    reading names several deployments behind one base and disagrees about them,
 *    so the slow reading cannot be attributed to either.
 *  - **A key with no reading for a day is unread, not fast.** The proxy omits a
 *    deployment that served no completion tokens that day (`HAVING SUM(...) >
 *    0`) and drops cache hits entirely, so the daily strip carries how many keys
 *    reported and never fills a gap with the gateway median.
 *  - **It is read one alias at a time.** The route filters on `model_group`
 *    with no wildcard, so the API sweeps the window's models ranked by spend and
 *    caps the sweep. An alias in `skippedModels` is *unmeasured*, not fast.
 *  - **It is fetched on a press,** for the same reason the request sample and
 *    the exception sweep are: a read is a round trip per alias against the
 *    proxy, and this one reads the request log, so `disable_spend_logs` empties
 *    it and an empty answer is a silence rather than a fast gateway.
 *
 * It contributes no finding to the attention digest, and the button is the
 * reason — the same argument as the request-log card: a source that is unread
 * until somebody presses it would either report a blind spot on every visit or
 * make the digest depend on whether anybody clicked.
 *
 * Everything is pure: the window and the health reading are parameters.
 */

/** The window a latency read covers — at most a month, by the route's own rule. */
export interface LatencyWindow {
  from: string;
  to: string;
  days: number;
}

/**
 * The tail of what is on screen, at most `LATENCY_MAX_WINDOW_DAYS` long.
 *
 * Read off the page's already-trimmed spine rather than off the range picker,
 * exactly as the exception and request-sample windows are: the picker's last
 * day is today, the aggregates end yesterday, and anchoring on the picker asks
 * the proxy about a day nothing else on the page is drawing. Null on an empty
 * spine — there is no traffic on screen to have been slow.
 */
export function latencyWindow(
  daily: readonly GatewayDailyPoint[],
  maxDays: number = LATENCY_MAX_WINDOW_DAYS,
): LatencyWindow | null {
  const first = daily[0];
  const last = daily[daily.length - 1];
  if (first === undefined || last === undefined) return null;

  const span = Math.max(1, Math.min(maxDays, daily.length));
  const from = shiftIso(last.date, -(span - 1));
  return {
    from: from < first.date ? first.date : from,
    to: last.date,
    days: span,
  };
}

/**
 * What tonight's health reading says about the deployment this key names.
 *
 * `unread` is silence and is deliberately not `healthy`: no reading taken, an
 * alias outside the catalogue, or a proxy running `health_check_details: false`
 * (which strips `api_base`, so the key cannot be rebuilt). `mixed` is this
 * layer's own state and exists because the latency key is coarser than the
 * health row — several deployments behind one endpoint collapse onto one key
 * upstream, so when the reading disagrees among them the slow number belongs to
 * no single one of them.
 */
export type LatencyHealthJoin = 'failing' | 'healthy' | 'mixed' | 'unread';

export interface LatencyRow extends GatewayLatencyRow {
  health: LatencyHealthJoin;
  /** How many deployments in the health reading collapse onto this key. */
  behindKey: number;
  provider: string | null;
  /** The proxy's own error text from the health reading, when it is failing. */
  healthError: string | null;
  /** Milliseconds per completion token — a unit change on the same rate, no new claim. */
  msPerToken: number;
}

/** One day of the gateway's own reading, with how thin it was. */
export interface LatencyDay extends GatewayLatencyDay {
  /**
   * Keys that reported that day over keys that reported anywhere in the window.
   * A thin day is a thin reading, not a fast one, and the strip says which.
   */
  coverage: number;
}

export interface LatencyView {
  /** Whether `GET /api/gateway/latency` has answered. False until the button is pressed. */
  answered: boolean;
  /**
   * The proxy served the route. False most often means `disable_spend_logs`, a
   * non-admin credential, or an older proxy — never "the gateway was fast".
   */
  available: boolean;
  /** Answered, available, and carrying no readings at all: measured nothing, not instant. */
  empty: boolean;
  window: LatencyWindow | null;
  /** When the proxy was asked. Nothing is stored — this read is live. */
  fetchedAt: string | null;

  rows: LatencyRow[];
  daily: LatencyDay[];
  /** Median of the key means — the number every ratio on the card is taken against. */
  medianSecondsPerToken: number | null;
  /** The same median read the friendly way round. Null when there is no median. */
  medianTokensPerSecond: number | null;
  /** (alias, key) pairs that reported anything. */
  observedKeys: number;
  /** Of those, the ones materially slower than the gateway on enough days to mean it. */
  elevatedKeys: number;
  /** The slowest key in the window, whether or not it cleared the badge's gates. */
  slowest: LatencyRow | null;

  /** The aliases the sweep asked about — one proxy round trip each. */
  models: string[];
  /** Aliases the cap left out. Unmeasured, not fast, and the card says so. */
  skippedModels: string[];

  /** Keys tonight's health reading also names — the only other deployment-keyed source. */
  joinedKeys: number;
  /** Of those, the ones it found failing: slow *and* refusing, from two independent reads. */
  failingJoined: number;
  /** Keys whose base fronts several deployments the reading disagrees about. */
  mixedJoins: number;
}

export interface LatencyOptions {
  /** The health snapshot, for the join only this layer's key makes possible. */
  health?: GatewayHealth | null;
}

const EMPTY_VIEW: LatencyView = {
  answered: false,
  available: false,
  empty: false,
  window: null,
  fetchedAt: null,
  rows: [],
  daily: [],
  medianSecondsPerToken: null,
  medianTokensPerSecond: null,
  observedKeys: 0,
  elevatedKeys: 0,
  slowest: null,
  models: [],
  skippedModels: [],
  joinedKeys: 0,
  failingJoined: 0,
  mixedJoins: 0,
};

export function deriveGatewayLatency(
  payload: GatewayLatency | null | undefined,
  options: LatencyOptions = {},
): LatencyView {
  if (payload === null || payload === undefined) return EMPTY_VIEW;

  const summary = summarizeGatewayLatency(payload);
  const window: LatencyWindow = {
    from: summary.from,
    to: summary.to,
    days: dayCount(summary.from, summary.to),
  };

  const answered: LatencyView = {
    ...EMPTY_VIEW,
    answered: true,
    available: summary.available,
    empty: summary.empty,
    window,
    fetchedAt: summary.fetchedAt,
    models: summary.models,
    skippedModels: summary.skippedModels,
  };
  if (!summary.available || summary.rows.length === 0) return answered;

  const byKey = healthByLatencyKey(options.health?.deployments ?? []);
  const rows: LatencyRow[] = summary.rows.map((row) => {
    const match = byKey.get(row.key);
    return {
      ...row,
      health: match === undefined ? 'unread' : match.state,
      behindKey: match?.deployments.length ?? 0,
      provider: match?.provider ?? null,
      healthError: match?.error ?? null,
      msPerToken: row.meanSecondsPerToken * 1000,
    };
  });

  const daily: LatencyDay[] = summary.daily.map((day) => ({
    ...day,
    coverage: summary.observedKeys === 0 ? 0 : day.keys / summary.observedKeys,
  }));

  return {
    ...answered,
    rows,
    daily,
    medianSecondsPerToken: summary.medianSecondsPerToken,
    medianTokensPerSecond:
      summary.medianSecondsPerToken === null
        ? null
        : tokensPerSecond(summary.medianSecondsPerToken),
    observedKeys: summary.observedKeys,
    elevatedKeys: rows.filter((row) => row.elevated).length,
    slowest: rows[0] ?? null,
    joinedKeys: rows.filter((row) => row.health !== 'unread').length,
    failingJoined: rows.filter((row) => row.health === 'failing').length,
    mixedJoins: rows.filter((row) => row.health === 'mixed').length,
  };
}

/** What the badge on a row means, in the card's own words and nowhere else. */
export function latencyBadgeReason(row: LatencyRow): string {
  if (row.ratioToMedian === null) return 'no gateway median to compare against';
  if (row.days < LATENCY_MIN_DAYS) {
    return `${row.days} day${row.days === 1 ? '' : 's'} observed — under the ${LATENCY_MIN_DAYS} this layer needs before it will say anything`;
  }
  if (row.ratioToMedian < LATENCY_ELEVATED_RATIO) {
    return `${row.ratioToMedian.toFixed(2)}× the gateway median — under the ${LATENCY_ELEVATED_RATIO}× this card calls material`;
  }
  return `${row.ratioToMedian.toFixed(2)}× the gateway median over ${row.days} days`;
}

interface HealthJoin {
  state: Exclude<LatencyHealthJoin, 'unread'>;
  deployments: GatewayDeployment[];
  provider: string | null;
  error: string | null;
}

/**
 * The health snapshot, keyed the way `/model/metrics` keys a deployment.
 *
 * The join runs in this direction and only this direction, like the exception
 * one — the key cannot be parsed back — but the collapse is worse here: the
 * exception key carries the backend model *and* the base, while this one is the
 * base alone whenever there is one. Several health rows landing on a single key
 * is therefore ordinary rather than pathological, and it is reported as `mixed`
 * instead of picked between: a base fronting one failing and one healthy
 * deployment has a latency reading that belongs to neither.
 */
function healthByLatencyKey(
  deployments: readonly GatewayDeployment[],
): Map<string, HealthJoin> {
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
    const state =
      failing.length === 0 ? 'healthy' : failing.length === bucket.length ? 'failing' : 'mixed';
    const providers = new Set(
      bucket.map((deployment) => deployment.provider).filter((provider): provider is string =>
        provider !== null,
      ),
    );
    joins.set(key, {
      state,
      deployments: bucket,
      provider: providers.size === 1 ? [...providers][0]! : null,
      error: failing.find((deployment) => deployment.error !== null)?.error ?? null,
    });
  }
  return joins;
}

/** Inclusive day count between two ISO dates. */
function dayCount(from: string, to: string): number {
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  return Number.isFinite(span) ? Math.max(1, Math.round(span)) : 1;
}
