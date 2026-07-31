import {
  SLOW_RESPONSE_CONFIDENCE_Z,
  SLOW_RESPONSE_DEFAULT_THRESHOLD_SECONDS,
  SLOW_RESPONSE_ELEVATED_RATIO,
  SLOW_RESPONSE_MAX_WINDOW_DAYS,
  SLOW_RESPONSE_MIN_COUNT,
  UNKEYED_DEPLOYMENT,
  slowResponseDeploymentKey,
  summarizeGatewaySlowResponses,
  wilsonScoreLowerBound,
} from '@dash/shared';
import type {
  GatewayDailyPoint,
  GatewayDeployment,
  GatewayHealth,
  GatewaySlowResponseRow,
  GatewaySlowResponses,
} from '@dash/shared';
import { shiftIso } from './gateway.js';

/**
 * How many calls hung, as the page reads it.
 *
 * The last of the four questions this page asks about one window of traffic,
 * and the only one about *wall clock*. The reliability card counts the calls
 * that failed; the exception card says why they failed; the latency card says
 * how many seconds per completion token the rest averaged. A request that ran
 * for four minutes and then answered correctly is a success on the first, wrote
 * no error log for the second, and — if it was a long answer at an ordinary
 * per-token rate — is entirely unremarkable on the third. It is also the
 * request somebody was sitting in front of.
 *
 * `GET /api/gateway/slow-responses` is the only place the proxy exports it, and
 * `summarizeGatewaySlowResponses` in `@dash/shared` is the single statement of
 * what a sweep of those rows means. This module adds no rule about the gateway.
 * It adds five about the *reading*, every one of them forced by the route:
 *
 *  - **The count has no duration attached, and cannot be given one.** Upstream
 *    the comparison is against `alerting_threshold` — the proxy's own, 300
 *    seconds unless somebody configured otherwise — and the response carries
 *    neither the threshold nor a single elapsed time. So every figure here is
 *    "requests at or past this proxy's threshold", the card names the default
 *    as prose and never as a label on a reading, and two proxies' counts are
 *    not comparable.
 *  - **Its denominator is its own, and it is not the ledger's.** `total_count`
 *    is the request-log rows the route grouped, with cache hits excluded
 *    upstream. Every share on this card is taken against that, never against
 *    gateway requests. The ledger's own count for the same days is carried
 *    beside it as `ledgerShare` — a disagreement between two tables, unclamped
 *    for the exception card's reason, and never a denominator.
 *  - **The key is an `api_base` and nothing else.** Coarser than either sibling:
 *    the exception key carries the backend model too, the latency key falls back
 *    to it. Here a deployment addressed by region rather than by URL is not
 *    named at all, and every such deployment of an alias lands in one bucket. A
 *    bucket is not an endpoint, so it takes no health verdict — `unkeyed` is its
 *    own state rather than `unread`, because the reading is not silent about
 *    those deployments, it simply cannot be asked about this row.
 *  - **It is read one alias at a time.** No wildcard on `model_group`, so the
 *    API sweeps the window's own models ranked by spend and caps the sweep. An
 *    alias in `skippedModels` is *unswept*, not healthy.
 *  - **It is fetched on a press,** like the request sample, the exception sweep
 *    and the latency read, and for the same two reasons: a round trip per alias,
 *    over the proxy's largest table.
 *
 * The badge is the one thing this layer can do that its two siblings cannot.
 * The payload carries a count *and* the denominator it came out of, so both
 * gates the reliability card uses are computable here: a Wilson lower bound
 * asking whether the difference is real, and a materiality ratio asking whether
 * it is worth an afternoon. Exceptions have no denominator and get no gate;
 * latency had its counts averaged away and gets the ratio only.
 *
 * Everything is pure: the window, the ledger figure and the health reading are
 * all parameters.
 */

/** The window a hang read covers — at most a month, by the route's own rule. */
export interface SlowResponseWindow {
  from: string;
  to: string;
  days: number;
}

/**
 * The tail of what is on screen, at most `SLOW_RESPONSE_MAX_WINDOW_DAYS` long.
 *
 * Read off the page's already-trimmed spine rather than off the range picker,
 * exactly as the exception and latency windows are: the picker's last day is
 * today, the aggregates end yesterday, and anchoring on the picker asks the
 * proxy about a day nothing else on the page draws. Null on an empty spine —
 * there is no traffic on screen to have hung.
 */
export function slowResponseWindow(
  daily: readonly GatewayDailyPoint[],
  maxDays: number = SLOW_RESPONSE_MAX_WINDOW_DAYS,
): SlowResponseWindow | null {
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
 * What tonight's health reading says about the endpoint this key names.
 *
 * Five states, one more than the latency card's four, and the extra one is this
 * route's key rather than a preference. `unkeyed` is the `GROUP BY api_base`
 * bucket every deployment without a URL falls into: it is not an address, so
 * there is no deployment to look up and nothing the reading could say about it.
 * Calling that `unread` would be wrong in the opposite direction from calling it
 * `healthy` — the reading may name all of those deployments perfectly well; it
 * is this row that cannot be attributed to any of them.
 *
 * `mixed` is inherited from the latency layer for the same reason it exists
 * there: an Azure base fronts several deployments, so a reading that disagrees
 * among them describes none of them. `unread` stays silence.
 */
export type SlowResponseHealthJoin = 'failing' | 'healthy' | 'mixed' | 'unread' | 'unkeyed';

export interface SlowResponseRow extends GatewaySlowResponseRow {
  health: SlowResponseHealthJoin;
  /** How many deployments in the health reading collapse onto this key. */
  behindKey: number;
  provider: string | null;
  /** The proxy's own error text from the health reading, when it is failing. */
  healthError: string | null;
  /** This key's hangs over every hang the sweep counted. Never a share of traffic. */
  shareOfSlow: number | null;
}

export interface SlowResponseView {
  /** Whether `GET /api/gateway/slow-responses` has answered. False until pressed. */
  answered: boolean;
  /**
   * The proxy served the route. False most often means `disable_spend_logs`, a
   * non-admin credential or an older proxy — never "nothing hung".
   */
  available: boolean;
  /** Answered, available and grouping nothing: the route counted no requests at all. */
  empty: boolean;
  window: SlowResponseWindow | null;
  /** When the proxy was asked. Nothing is stored — this read is live. */
  fetchedAt: string | null;

  rows: SlowResponseRow[];
  /** Request-log rows the route grouped. Cache hits excluded upstream. */
  total: number;
  /** Of those, the ones that ran past the proxy's own threshold. */
  slow: number;
  /** Gateway-wide hang share — the denominator every ratio here is taken against. */
  slowShare: number | null;
  /** Deployment keys the sweep saw. */
  observedKeys: number;
  /** Of those, the ones both gates agree are materially more prone to hanging. */
  elevatedKeys: number;
  /** The row with the most hangs — what a reader acts on first, badged or not. */
  mostHangs: SlowResponseRow | null;
  /**
   * The highest hang *share* any key reached — the scale every bar is drawn
   * against. Kept apart from `mostHangs` deliberately: the endpoint carrying the
   * most hangs is usually the one carrying the most traffic, and the endpoint
   * most likely to hang is usually a small one.
   */
  worstShare: number | null;

  /** The aliases the sweep asked about — one proxy round trip each. */
  models: string[];
  /** Aliases the cap left out. Unswept, not healthy. */
  skippedModels: string[];

  /** The ledger's own request count for the same days, when the spine covers them. */
  ledgerRequests: number | null;
  /**
   * Requests this route grouped over the ledger's count for the same days.
   *
   * A disagreement between two tables and never a coverage figure: the request
   * log excludes cache hits, is switchable and is pruned on its own schedule, so
   * under 100% is ordinary. Unclamped, like the exception card's `recordedShare`
   * — over 100% is a real reading and hiding it would assert an agreement
   * neither table promises.
   */
  ledgerShare: number | null;

  /** Keys tonight's health reading also names. */
  joinedKeys: number;
  /** Of those, the ones it found failing: hanging *and* refusing, from two reads. */
  failingJoined: number;
  /** Keys whose base fronts deployments the reading disagrees about. */
  mixedJoins: number;
  /** Rows that are the unaddressable bucket rather than an endpoint. */
  unkeyedRows: number;
}

export interface SlowResponseOptions {
  /** The ledger's requests over the same days — context, never a denominator. */
  ledgerRequests?: number | null;
  /** The health snapshot, for the join the deployment key makes possible. */
  health?: GatewayHealth | null;
}

const EMPTY_VIEW: SlowResponseView = {
  answered: false,
  available: false,
  empty: false,
  window: null,
  fetchedAt: null,
  rows: [],
  total: 0,
  slow: 0,
  slowShare: null,
  observedKeys: 0,
  elevatedKeys: 0,
  mostHangs: null,
  worstShare: null,
  models: [],
  skippedModels: [],
  ledgerRequests: null,
  ledgerShare: null,
  joinedKeys: 0,
  failingJoined: 0,
  mixedJoins: 0,
  unkeyedRows: 0,
};

export function deriveGatewaySlowResponses(
  payload: GatewaySlowResponses | null | undefined,
  options: SlowResponseOptions = {},
): SlowResponseView {
  if (payload === null || payload === undefined) return EMPTY_VIEW;

  const summary = summarizeGatewaySlowResponses(payload);
  const window: SlowResponseWindow = {
    from: summary.from,
    to: summary.to,
    days: dayCount(summary.from, summary.to),
  };
  const ledgerRequests = options.ledgerRequests ?? null;

  const answered: SlowResponseView = {
    ...EMPTY_VIEW,
    answered: true,
    available: summary.available,
    empty: summary.empty,
    window,
    fetchedAt: summary.fetchedAt,
    models: summary.models,
    skippedModels: summary.skippedModels,
    ledgerRequests,
  };
  if (!summary.available || summary.rows.length === 0) return answered;

  const byKey = healthBySlowResponseKey(options.health?.deployments ?? []);
  const rows: SlowResponseRow[] = summary.rows.map((row) => {
    // The bucket is not an address. Even if the reading carries deployments
    // with no api_base of their own, they are not *this* row's deployments —
    // they are whatever this proxy failed to give a URL, across every alias.
    const match = row.key === UNKEYED_DEPLOYMENT ? undefined : byKey.get(row.key);
    return {
      ...row,
      health:
        row.key === UNKEYED_DEPLOYMENT ? 'unkeyed' : match === undefined ? 'unread' : match.state,
      behindKey: match?.deployments.length ?? 0,
      provider: match?.provider ?? null,
      healthError: match?.error ?? null,
      shareOfSlow: summary.slow > 0 ? row.slow / summary.slow : null,
    };
  });

  return {
    ...answered,
    rows,
    total: summary.total,
    slow: summary.slow,
    slowShare: summary.slowShare,
    observedKeys: summary.observedKeys,
    elevatedKeys: rows.filter((row) => row.elevated).length,
    mostHangs: rows[0] ?? null,
    worstShare: rows.reduce<number | null>(
      (highest, row) =>
        row.slowShare === null ? highest : highest === null || row.slowShare > highest ? row.slowShare : highest,
      null,
    ),
    ledgerShare:
      ledgerRequests === null || ledgerRequests <= 0 ? null : summary.total / ledgerRequests,
    joinedKeys: rows.filter((row) => row.health === 'failing' || row.health === 'healthy' || row.health === 'mixed')
      .length,
    failingJoined: rows.filter((row) => row.health === 'failing').length,
    mixedJoins: rows.filter((row) => row.health === 'mixed').length,
    unkeyedRows: rows.filter((row) => row.health === 'unkeyed').length,
  };
}

/**
 * What the badge on a row means — and, when it is absent, which gate said no.
 *
 * An unbadged row is a claim too, and the two gates guard opposite regimes: one
 * key hung twice out of three calls and is certainly not measurable, another is
 * 0.4% against a 0.35% gateway across a hundred thousand requests and is
 * certainly not worth anybody's afternoon. A card that renders neither reason
 * leaves the reader to assume the first, which is the wrong one most of the
 * time.
 */
export function slowResponseBadgeReason(row: SlowResponseRow, gatewayShare: number | null): string {
  if (row.ratioToGateway === null || gatewayShare === null) {
    return 'no gateway rate to compare against';
  }
  if (row.slow < SLOW_RESPONSE_MIN_COUNT) {
    return `${row.slow} hang${row.slow === 1 ? '' : 's'} — under the ${SLOW_RESPONSE_MIN_COUNT} this card needs before it will say anything`;
  }
  const bound = wilsonScoreLowerBound(row.slow, row.total, SLOW_RESPONSE_CONFIDENCE_Z);
  if (bound <= gatewayShare) {
    return `${((row.slowShare ?? 0) * 100).toFixed(2)}% of ${row.total.toLocaleString()} requests — inside the noise around the gateway's ${(gatewayShare * 100).toFixed(2)}%`;
  }
  if (row.ratioToGateway < SLOW_RESPONSE_ELEVATED_RATIO) {
    return `${row.ratioToGateway.toFixed(2)}× the gateway rate — measurable, but under the ${SLOW_RESPONSE_ELEVATED_RATIO}× this card calls material`;
  }
  return `${row.ratioToGateway.toFixed(2)}× the gateway rate over ${row.total.toLocaleString()} requests`;
}

/**
 * How the card describes what "slow" means, given that it cannot know.
 *
 * The proxy compares against its own `alerting_threshold` and never says which
 * number it used. This sentence names the upstream default as *prose about the
 * likely configuration* — the one thing the constant may be used for — and it
 * must never be rendered as a label on a count.
 */
export const SLOW_RESPONSE_THRESHOLD_NOTE = `the proxy's own alerting threshold — ${SLOW_RESPONSE_DEFAULT_THRESHOLD_SECONDS}s unless somebody configured otherwise, and the response never says which`;

interface HealthJoin {
  state: Exclude<SlowResponseHealthJoin, 'unread' | 'unkeyed'>;
  deployments: GatewayDeployment[];
  provider: string | null;
  error: string | null;
}

/**
 * The health snapshot, keyed the way `/model/metrics/slow_responses` keys a row.
 *
 * The third one-directional join in this integration and the coarsest: the key
 * is an `api_base` cut at `/openai/`, with no fallback to a backend model
 * string. Deployments the reading carries with no base of their own are
 * therefore **dropped from the map entirely** rather than filed under
 * `UNKEYED_DEPLOYMENT`: the proxy's bucket is one row per alias covering every
 * unaddressed deployment behind it, so joining the two would attribute a whole
 * Bedrock fleet's hangs to whichever deployments happen to lack a URL in the
 * health reading — a join that looks like a match and is an accident of two
 * unrelated absences.
 */
function healthBySlowResponseKey(
  deployments: readonly GatewayDeployment[],
): Map<string, HealthJoin> {
  const grouped = new Map<string, GatewayDeployment[]>();
  for (const deployment of deployments) {
    const key = slowResponseDeploymentKey(deployment.apiBase);
    if (key === UNKEYED_DEPLOYMENT) continue;
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
      bucket
        .map((deployment) => deployment.provider)
        .filter((provider): provider is string => provider !== null),
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
