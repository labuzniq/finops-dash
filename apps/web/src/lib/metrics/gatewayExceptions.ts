import {
  deploymentExceptionKey,
  summarizeGatewayExceptions,
  EXCEPTION_MAX_WINDOW_DAYS,
  GATEWAY_EXCEPTION_CLASS_INFO,
} from '@dash/shared';
import type {
  GatewayDailyPoint,
  GatewayDeployment,
  GatewayExceptionClass,
  GatewayExceptionClassRollup,
  GatewayExceptionDeploymentRollup,
  GatewayExceptions,
  GatewayHealth,
} from '@dash/shared';
import { shiftIso } from './gateway.js';

/**
 * Why the failed calls failed, as the page reads it.
 *
 * Every other reliability surface here counts failures. The ledger's
 * `failed_requests` answers *how many* and *where*, per day and per key, and
 * structurally cannot answer *why* — `SpendMetrics` has no error column, so a
 * rate limit, an expired credential, an over-long prompt and a region falling
 * over are one number there and four different jobs for four different people.
 * `GET /api/gateway/exceptions` is the only place the proxy exports the reason,
 * and `summarizeGatewayExceptions` in `@dash/shared` is the single statement of
 * what a window of those rows means.
 *
 * This module adds no rule about the gateway. It adds four about the *reading*,
 * all four forced by the layer rather than chosen by the view:
 *
 *  - **It is a reason, never a count.** `LiteLLM_ErrorLogs` is a third table
 *    with a third switch (`disable_error_logs`) and a retention schedule of its
 *    own, and it carries no denominator at all. So nothing here is a failure
 *    rate or a share of traffic; every share on this card is a share of the
 *    exceptions *recorded*, and the one figure that touches the ledger
 *    (`recordedShare`) is deliberately unclamped, because the two tables may
 *    legitimately disagree in either direction.
 *  - **It is keyed below the alias.** The row key is a deployment, which is the
 *    resolution `gateway_deployment_health` is keyed at and the one the daily
 *    aggregates do not have. Joining the two is what turns "this alias is
 *    degraded tonight" into "and this is what it has been refusing with", and
 *    the join only runs one way — `deploymentExceptionKey` rebuilds the
 *    exception key from a health row, because the key itself cannot be parsed
 *    back (both halves contain hyphens).
 *  - **It is read one alias at a time.** The proxy filters on `model_group`
 *    with no wildcard, so the API sweeps the window's own models ranked by
 *    spend and caps the sweep. An alias in `skippedModels` is *unread*, not
 *    clean, and the card has to say so or a capped read renders as a quiet
 *    gateway.
 *  - **It is fetched on a press.** A sweep is a round trip per alias against
 *    production, which is the request-log card's argument in the same words.
 *
 * Everything is pure: the window, the ledger figure and the health reading are
 * all parameters.
 */

/** The window an exception read covers — at most a month, by the route's own rule. */
export interface ExceptionWindow {
  from: string;
  to: string;
  days: number;
}

/**
 * The tail of what is on screen, at most `EXCEPTION_MAX_WINDOW_DAYS` long.
 *
 * Read off the page's already-trimmed spine rather than off the range picker,
 * for the same reason the request sample's window is: the picker's last day is
 * today and the aggregates end yesterday, so anchoring on the picker asks the
 * proxy about a day nothing else on the page is showing. Null on an empty
 * spine — there are no failures on screen to explain.
 */
export function exceptionWindow(
  daily: readonly GatewayDailyPoint[],
  maxDays: number = EXCEPTION_MAX_WINDOW_DAYS,
): ExceptionWindow | null {
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

/** One class of fault, with the party that can act on it named. */
export interface ExceptionClassRow extends GatewayExceptionClassRollup {
  label: string;
  /** `capacity`, `configuration`, `governance`, … — the point of the whole layer. */
  owner: string;
  docs: string;
}

/**
 * Where the health reading and the exception log agree about a deployment.
 *
 * `failing` and `healthy` are the reading's verdict at the moment it was taken;
 * `unread` is a deployment the exception log named and the health snapshot does
 * not carry — an alias out of the catalogue, a proxy running
 * `health_check_details: false` (which strips `api_base`, so the key cannot be
 * rebuilt), or simply a reading nobody has taken yet. It is deliberately not
 * `healthy`: an absent row is silence.
 */
export type ExceptionHealthJoin = 'failing' | 'healthy' | 'unread';

export interface ExceptionDeploymentRow extends GatewayExceptionDeploymentRollup {
  health: ExceptionHealthJoin;
  /** The routing string the health reading knows this deployment by, when joined. */
  backend: string | null;
  provider: string | null;
  /** The proxy's own error text from the health reading — a second, live-checked reason. */
  healthError: string | null;
}

export interface ExceptionView {
  /** Whether `GET /api/gateway/exceptions` has answered. False until the button is pressed. */
  answered: boolean;
  /** The proxy served the route — false most often means `disable_error_logs` or an older proxy. */
  available: boolean;
  /** Answered, available, and carrying no rows: no errors *recorded*, which is not "none happened". */
  empty: boolean;
  window: ExceptionWindow | null;
  /** When the proxy was asked. Nothing is stored — this read is live. */
  fetchedAt: string | null;

  /** Every exception recorded in the window. A floor on failures, never their count. */
  total: number;
  classes: ExceptionClassRow[];
  deployments: ExceptionDeploymentRow[];
  /** The class carrying the most of the window, with its share of what was recorded. */
  dominant: { class: GatewayExceptionClass; label: string; owner: string; share: number } | null;

  /** The aliases the sweep asked about — one proxy round trip each. */
  models: string[];
  /** Aliases the cap left unread. Unread is not clean, and the card says so. */
  skippedModels: string[];

  /**
   * Failures the *ledger* counted over the same days, when the page could
   * supply it. Context for the exception total and never its denominator.
   */
  ledgerFailures: number | null;
  /**
   * Exceptions recorded over failures counted, **unclamped and not a coverage
   * figure**: the two tables are switched on and pruned independently, so this
   * may sit under 1 (error logging off for part of the window, or pruned) or
   * over it (a retried call failing twice logs two exceptions against one
   * failed request). It is shown to make the disagreement visible, which is the
   * opposite of reconciling it away.
   */
  recordedShare: number | null;

  /** Deployments whose exception rows the health reading also names. */
  joinedDeployments: number;
  /** Of those, the ones the reading found failing — the same fault twice, from two sources. */
  failingJoined: number;
}

export interface ExceptionOptions {
  /** The ledger's failure count for the same days, when it is known. */
  ledgerFailures?: number | null;
  /** The health snapshot, for the join that only this layer's key makes possible. */
  health?: GatewayHealth | null;
}

const EMPTY_VIEW: ExceptionView = {
  answered: false,
  available: false,
  empty: false,
  window: null,
  fetchedAt: null,
  total: 0,
  classes: [],
  deployments: [],
  dominant: null,
  models: [],
  skippedModels: [],
  ledgerFailures: null,
  recordedShare: null,
  joinedDeployments: 0,
  failingJoined: 0,
};

export function deriveGatewayExceptions(
  payload: GatewayExceptions | null | undefined,
  options: ExceptionOptions = {},
): ExceptionView {
  const ledgerFailures = options.ledgerFailures ?? null;
  if (payload === null || payload === undefined) return { ...EMPTY_VIEW, ledgerFailures };

  const summary = summarizeGatewayExceptions(payload);
  const window: ExceptionWindow = {
    from: summary.from,
    to: summary.to,
    days: dayCount(summary.from, summary.to),
  };

  const answered: ExceptionView = {
    ...EMPTY_VIEW,
    answered: true,
    available: summary.available,
    empty: summary.empty,
    window,
    fetchedAt: summary.fetchedAt,
    models: summary.models,
    skippedModels: summary.skippedModels,
    ledgerFailures,
  };
  if (!summary.available || summary.total === 0) return answered;

  const classes: ExceptionClassRow[] = summary.classes.map((row) => {
    const info = GATEWAY_EXCEPTION_CLASS_INFO[row.class];
    return { ...row, label: info.label, owner: info.owner, docs: info.docs };
  });

  const byKey = healthByExceptionKey(options.health?.deployments ?? []);
  const deployments: ExceptionDeploymentRow[] = summary.deployments.map((row) => {
    const match = byKey.get(row.deployment);
    return {
      ...row,
      health: match === undefined ? 'unread' : match.healthy ? 'healthy' : 'failing',
      backend: match?.backend ?? null,
      provider: match?.provider ?? null,
      healthError: match?.error ?? null,
    };
  });

  const leader = classes[0];

  return {
    ...answered,
    total: summary.total,
    classes,
    deployments,
    dominant:
      leader === undefined
        ? null
        : {
            class: leader.class,
            label: leader.label,
            owner: leader.owner,
            share: leader.share,
          },
    recordedShare:
      ledgerFailures === null || ledgerFailures <= 0 ? null : summary.total / ledgerFailures,
    joinedDeployments: deployments.filter((row) => row.health !== 'unread').length,
    failingJoined: deployments.filter((row) => row.health === 'failing').length,
  };
}

/**
 * The health snapshot, keyed the way the exception log keys a deployment.
 *
 * The join runs in this direction and only this direction: LiteLLM builds the
 * exception row's key as `litellm_model_name` + `-` + `api_base`, both of which
 * contain hyphens of their own, so it can be rebuilt and never split. A
 * deployment whose `api_base` the proxy stripped keys on the backend alone,
 * which is the same rule `deploymentExceptionKey` encodes.
 */
function healthByExceptionKey(
  deployments: readonly GatewayDeployment[],
): Map<string, GatewayDeployment> {
  const byKey = new Map<string, GatewayDeployment>();
  for (const deployment of deployments) {
    const key = deploymentExceptionKey(deployment.backend, deployment.apiBase);
    // A failing reading wins a collision: two deployments cannot share a key
    // unless the proxy stripped their bases, and in that case the fault is the
    // thing worth surfacing.
    const existing = byKey.get(key);
    if (existing === undefined || (existing.healthy && !deployment.healthy)) {
      byKey.set(key, deployment);
    }
  }
  return byKey;
}

/**
 * Failures the aggregate layer recorded over the same days.
 *
 * Taken from the spine the page already holds rather than from a second fetch,
 * and used as *context* rather than as a denominator: the exception layer reads
 * a different table with a different switch and a different retention, so the
 * honest thing to do with the two numbers is to show them side by side.
 */
export function ledgerFailuresIn(
  daily: readonly GatewayDailyPoint[],
  window: ExceptionWindow | null,
): number | null {
  if (window === null) return null;
  let total = 0;
  let matched = 0;
  for (const day of daily) {
    if (day.date < window.from || day.date > window.to) continue;
    matched += 1;
    total += day.failedRequests;
  }
  return matched === 0 ? null : total;
}

/** Inclusive day count between two ISO dates. */
function dayCount(from: string, to: string): number {
  const span =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  return Number.isFinite(span) ? Math.max(1, Math.round(span)) : 1;
}
