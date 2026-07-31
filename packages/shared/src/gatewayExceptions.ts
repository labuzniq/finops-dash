/**
 * Why calls failed — `LiteLLM_ErrorLogs`, read through
 * `GET /model/metrics/exceptions`.
 *
 * Every other reliability surface in this dashboard counts failures. The daily
 * aggregates carry `failed_requests` per day and per key, which answers *how
 * many* and *where*, and structurally cannot answer *why*: `SpendMetrics` has
 * no error column at all. A rate limit, an expired Azure credential, a prompt
 * over the context window and a Bedrock region falling over are one number
 * there, and they are four different jobs for four different people.
 *
 * This route is the only place the proxy exports the reason. It reads a
 * separate table from both the aggregates and the request log, and reports one
 * row per *deployment* per window with the exception classes counted on it.
 *
 * Three properties shape everything built on it:
 *
 *  1. **It is a reason, not a count.** `LiteLLM_ErrorLogs` is written by the
 *     proxy's error logging, which is separately switchable (`disable_error_logs`
 *     is the twin of `disable_spend_logs`) and pruned on its own schedule. Its
 *     totals may legitimately disagree with the `failed_requests` the ledger
 *     carries for the same days — so nothing here may be rendered as the
 *     gateway's failure count, and an empty answer means "no errors recorded",
 *     which is not the same claim as "no errors".
 *  2. **It is keyed below the alias, like deployment health.** The row key is
 *     LiteLLM's `combined_model_api_base` — the backend model string, and the
 *     `api_base` after a hyphen when there is one. That is the resolution at
 *     which a throttled PTU pool is distinguishable from the pay-as-you-go
 *     deployment beside it, which is exactly the fault the aggregates hide.
 *  3. **It is scoped to one model group per read.** The proxy's query filters
 *     on `model_group`, so exceptions can only be asked for aliases the caller
 *     already knows. There is no "everything" call, and a model nobody asked
 *     about is unread rather than clean.
 */

/**
 * How many days of exceptions one read may ask for.
 *
 * A month rather than the usage layer's 90 days, and the reason is the table
 * rather than the query: `LiteLLM_ErrorLogs` is pruned on a retention schedule
 * of its own and the proxy's own default window on this route is thirty days,
 * so a wider ask returns a truncated answer that looks like a complete one.
 */
export const EXCEPTION_MAX_WINDOW_DAYS = 31;

/**
 * What kind of fault an exception is, in terms of who can do something about
 * it. The classes are the point of this layer: `RateLimitError` and
 * `AuthenticationError` are the same failed request to the ledger and two
 * unrelated pieces of work — one is capacity, the other is a credential.
 */
export const GATEWAY_EXCEPTION_CLASSES = [
  'rate-limit',
  'auth',
  'budget',
  'timeout',
  'backend',
  'request',
  'content',
  'other',
] as const;

export type GatewayExceptionClass = (typeof GATEWAY_EXCEPTION_CLASSES)[number];

export interface GatewayExceptionClassInfo {
  label: string;
  /** Who the finding belongs to. Rendered under the class on the view. */
  owner: string;
  docs: string;
}

export const GATEWAY_EXCEPTION_CLASS_INFO: Record<
  GatewayExceptionClass,
  GatewayExceptionClassInfo
> = {
  'rate-limit': {
    label: 'Rate limited',
    owner: 'capacity',
    docs: 'The deployment or its provider refused on quota. Answered by more capacity, a fallback, or a limit somebody set on this proxy.',
  },
  auth: {
    label: 'Authentication',
    owner: 'configuration',
    docs: 'The proxy could not authenticate to the backend, or the caller could not authenticate to the proxy. A credential, never a workload.',
  },
  budget: {
    label: 'Budget',
    owner: 'governance',
    docs: 'The call was refused by a cap this proxy enforces. The one class the gateway itself caused, and the one the budget card is already about.',
  },
  timeout: {
    label: 'Timeout',
    owner: 'latency',
    docs: 'The backend did not answer in time. Distinct from a refusal: the capacity existed and was too slow to reach.',
  },
  backend: {
    label: 'Backend error',
    owner: 'provider',
    docs: 'The provider answered with a fault of its own — a 5xx, a dropped connection, an unreachable region.',
  },
  request: {
    label: 'Bad request',
    owner: 'caller',
    docs: 'The call was malformed, oversized or asked for something that does not exist. Nothing about the gateway changes this.',
  },
  content: {
    label: 'Content policy',
    owner: 'policy',
    docs: 'The provider or a guardrail refused the content. A policy decision that worked as configured.',
  },
  other: {
    label: 'Other',
    owner: 'unclassified',
    docs: 'An exception class this dashboard does not recognise. Reported under its own name rather than folded into a neighbour.',
  },
};

/**
 * LiteLLM's exception classes, mapped to who owns them.
 *
 * Every LiteLLM exception inherits from an OpenAI one and the proxy stores the
 * class name verbatim in `exception_type`, so this is a lookup rather than a
 * heuristic — and an unknown name lands in `other` under its own label rather
 * than being guessed at. Two of the mappings are judgement rather than
 * translation and are worth stating: `ContextWindowExceededError` is a
 * *request* fault (a 400 the caller can fix by sending less) rather than a
 * capacity one, and `NotFoundError` is a request fault too — on this route it
 * is overwhelmingly a model alias that no longer exists.
 */
const EXCEPTION_CLASS_BY_TYPE: Record<string, GatewayExceptionClass> = {
  RateLimitError: 'rate-limit',
  AuthenticationError: 'auth',
  PermissionDeniedError: 'auth',
  BudgetExceededError: 'budget',
  Timeout: 'timeout',
  APITimeoutError: 'timeout',
  APIConnectionError: 'backend',
  APIError: 'backend',
  ServiceUnavailableError: 'backend',
  InternalServerError: 'backend',
  APIResponseValidationError: 'backend',
  BadRequestError: 'request',
  InvalidRequestError: 'request',
  UnsupportedParamsError: 'request',
  UnprocessableEntityError: 'request',
  ContextWindowExceededError: 'request',
  NotFoundError: 'request',
  JSONSchemaValidationError: 'request',
  ImageFetchError: 'request',
  ContentPolicyViolationError: 'content',
};

/**
 * Which class an `exception_type` belongs to.
 *
 * Case- and suffix-tolerant only where LiteLLM itself is inconsistent: the
 * table holds the Python class name, but a proxy that logged
 * `litellm.RateLimitError` or `openai.RateLimitError` is naming the same
 * fault. Anything still unrecognised is `other` — never a near-match, for the
 * same reason a deployment the catalogue cannot name is stored as null rather
 * than filed under a neighbour.
 */
export function classifyGatewayException(exceptionType: string): GatewayExceptionClass {
  const trimmed = exceptionType.trim();
  if (trimmed === '') return 'other';
  const bare = trimmed.slice(trimmed.lastIndexOf('.') + 1);
  return EXCEPTION_CLASS_BY_TYPE[bare] ?? 'other';
}

/** One exception class as the proxy counted it, for one deployment. */
export interface GatewayExceptionCount {
  /** `exception_type` verbatim — the Python class name the proxy stored. */
  type: string;
  class: GatewayExceptionClass;
  count: number;
}

/**
 * One deployment's exceptions over the window.
 *
 * `deployment` is LiteLLM's `combined_model_api_base` verbatim and is
 * deliberately never parsed back into its parts: it is built as
 * `CONCAT(litellm_model_name, '-', api_base)` and both halves contain hyphens,
 * so splitting it is guesswork. Joining to `gateway_deployment_health` runs the
 * other way — build the same string from the health row with
 * `deploymentExceptionKey` and compare.
 */
export interface GatewayDeploymentExceptions {
  deployment: string;
  /** The public alias the read was scoped to. Supplied by the caller, not the row. */
  model: string;
  exceptions: GatewayExceptionCount[];
  /** Our sum over `exceptions`, which is the only honest total. */
  total: number;
  /**
   * The proxy's own `total_exceptions` field.
   *
   * Kept because it is evidence, and never used as a count: the route's SQL
   * takes `COUNT(*)` over a `GROUP BY (deployment, exception_type)` CTE, so the
   * number is how many *distinct classes* the deployment produced, not how many
   * exceptions it threw. A deployment with 4,000 rate limits and 2 timeouts
   * reports `total_exceptions: 2`.
   */
  reportedTotal: number;
}

/** Everything `GET /api/gateway/exceptions` returns. */
export interface GatewayExceptions {
  /** The window asked for, inclusive ISO dates. */
  from: string;
  to: string;
  /** The aliases actually asked about — one proxy call each. */
  models: string[];
  /**
   * Aliases that existed in the window and were not asked about, because the
   * read is capped. Reported rather than dropped: a per-model route with a cap
   * that says nothing reads as a clean gateway.
   */
  skippedModels: string[];
  deployments: GatewayDeploymentExceptions[];
  /**
   * Whether the proxy answered the route at all. False means it was refused or
   * is absent — which on LiteLLM most often means an older proxy or a
   * credential without admin rights, not a broken gateway.
   */
  available: boolean;
  /** When the proxy was asked. Nothing is stored — this route is live. */
  fetchedAt: string;
}

/**
 * The key `/model/metrics/exceptions` reports a deployment under, built from
 * the parts `gateway_deployment_health` holds.
 *
 * This is the join, and it only runs in this direction. LiteLLM builds the key
 * as `api_base = '' ? litellm_model_name : litellm_model_name + '-' + api_base`,
 * and a null `api_base` (Bedrock addresses by region, not by URL) is the empty
 * case.
 */
export function deploymentExceptionKey(backend: string, apiBase: string | null): string {
  return apiBase === null || apiBase === '' ? backend : `${backend}-${apiBase}`;
}

/** One class's share of the window, gateway-wide. */
export interface GatewayExceptionClassRollup {
  class: GatewayExceptionClass;
  count: number;
  /** Share of every exception recorded in the window. */
  share: number;
  /** How many deployments produced at least one of these. */
  deployments: number;
  /** The class's own types, largest first — `RateLimitError` and its neighbours. */
  types: GatewayExceptionCount[];
}

/** One deployment, ranked, with the class that dominates it. */
export interface GatewayExceptionDeploymentRollup extends GatewayDeploymentExceptions {
  /** Share of every exception recorded in the window. */
  share: number;
  /** The class carrying the most of this deployment's exceptions, or null when it recorded none. */
  dominantClass: GatewayExceptionClass | null;
  /** Whether one class carries at least this share of the deployment's own exceptions. */
  dominantShare: number | null;
}

export interface GatewayExceptionSummary {
  from: string;
  to: string;
  available: boolean;
  /** Every exception counted in the window. A floor on failures, never their count. */
  total: number;
  classes: GatewayExceptionClassRollup[];
  deployments: GatewayExceptionDeploymentRollup[];
  models: string[];
  skippedModels: string[];
  /** True when the route answered and recorded nothing at all. */
  empty: boolean;
  fetchedAt: string;
}

/**
 * Roll one window of exception rows up two ways — by class and by deployment.
 *
 * Pure, and deliberately without a threshold of its own. There is no "elevated"
 * badge here and there cannot be one: this table carries no denominator, so a
 * deployment's 300 rate limits are 300 of something whose total the route never
 * reports. Rates belong to the reliability card, which reads the ledger; this
 * layer only ever says *which kind*.
 */
export function summarizeGatewayExceptions(payload: GatewayExceptions): GatewayExceptionSummary {
  const total = payload.deployments.reduce((sum, row) => sum + row.total, 0);

  const byClass = new Map<GatewayExceptionClass, { count: number; deployments: Set<string>; types: Map<string, GatewayExceptionCount> }>();

  for (const deployment of payload.deployments) {
    for (const entry of deployment.exceptions) {
      let bucket = byClass.get(entry.class);
      if (bucket === undefined) {
        bucket = { count: 0, deployments: new Set(), types: new Map() };
        byClass.set(entry.class, bucket);
      }
      bucket.count += entry.count;
      bucket.deployments.add(deployment.deployment);
      const type = bucket.types.get(entry.type);
      if (type === undefined) bucket.types.set(entry.type, { ...entry });
      else type.count += entry.count;
    }
  }

  const classes: GatewayExceptionClassRollup[] = [...byClass.entries()]
    .map(([exceptionClass, bucket]) => ({
      class: exceptionClass,
      count: bucket.count,
      share: total === 0 ? 0 : bucket.count / total,
      deployments: bucket.deployments.size,
      types: [...bucket.types.values()].sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count);

  const deployments: GatewayExceptionDeploymentRollup[] = payload.deployments
    .map((row) => {
      const dominant = [...row.exceptions]
        .reduce<{ class: GatewayExceptionClass; count: number } | null>((best, entry) => {
          if (best === null || entry.count > best.count) return { class: entry.class, count: entry.count };
          return best;
        }, null);
      return {
        ...row,
        exceptions: [...row.exceptions].sort((a, b) => b.count - a.count),
        share: total === 0 ? 0 : row.total / total,
        dominantClass: dominant?.class ?? null,
        dominantShare: dominant === null || row.total === 0 ? null : dominant.count / row.total,
      };
    })
    .sort((a, b) => b.total - a.total || a.deployment.localeCompare(b.deployment));

  return {
    from: payload.from,
    to: payload.to,
    available: payload.available,
    total,
    classes,
    deployments,
    models: payload.models,
    skippedModels: payload.skippedModels,
    empty: payload.available && total === 0,
    fetchedAt: payload.fetchedAt,
  };
}

/* ------------------------------------------------------------------------- *
 * The stored roll-up: what the nightly sweep recorded, kept.
 * ------------------------------------------------------------------------- */

/**
 * One night's count of one exception type, for one deployment under one alias.
 *
 * The second of the four live reads to be stored, and it is stored for the same
 * arithmetic reason as the first: these are counts of *disjoint* `LiteLLM_ErrorLogs`
 * rows, so they add across the aliases of one sweep and across nights.
 * `/model/metrics` is stored too, and on a narrower licence: it answers a mean
 * of per-request ratios with its counts already discarded, so its nights may be
 * compared and never added — an average of nightly averages is a number with no
 * referent.
 *
 * What does **not** follow from the hang table is a rate. That route carries
 * `total_count` beside `slow_count`; this one carries no denominator at all, so
 * everything derived here is a count or a share of *recorded exceptions*, and
 * nothing may be rendered as a failure rate, a share of traffic, or a badge.
 *
 * `type` is stored verbatim and the *class* is derived at read time, which is the
 * opposite of `gateway_deployment_health_history.model` and the difference is
 * worth stating: that column is resolved against the catalogue fetched in the
 * same run, so re-resolving it later would re-file a deployment that has since
 * moved. A class is a static mapping from a Python class name to the party who
 * can act on it — nothing about it depends on the night — so deriving it on read
 * means a taxonomy fix re-files history instead of leaving old rows filed under
 * `other` forever.
 */
export interface GatewayExceptionObservation {
  /** The UTC day the counts cover — not the day the sweep ran. */
  date: string;
  /** The alias the read was scoped to: the query parameter, not the row. */
  model: string;
  /** LiteLLM's `combined_model_api_base`, verbatim and never parsed back. */
  deployment: string;
  /** `exception_type` as the proxy stored it. Classified on read. */
  type: string;
  count: number;
  /** When the sweep that produced this row ran. */
  observedAt: string;
}

/**
 * A receipt that the sweep ran on a night, whatever it found.
 *
 * This layer needs one and the hang layer does not, and the asymmetry is a
 * property of the two routes rather than a design choice.
 * `/model/metrics/slow_responses` answers a row per deployment key with traffic,
 * so a night that was read always leaves rows behind. `/model/metrics/exceptions`
 * answers rows only for deployments that *faulted*, so a night on which the
 * whole gateway behaved records nothing — byte-identical to a night the sweep
 * was refused, timed out, or never ran.
 *
 * Those are opposite findings ("no errors were recorded" against "we did not
 * look"), so the night the sweep ran is filed separately from what it found. A
 * day with a receipt and no observations is *clean*; a day with neither is
 * unread and stays unknown, exactly as an unobserved night does everywhere else
 * in this integration.
 */
export interface GatewayExceptionSweep {
  date: string;
  /** How many aliases were asked about. The cap and a quiet gateway both lower it. */
  models: number;
  /** How many deployments came back with at least one exception. */
  deployments: number;
  /** Our sum over the night's rows — never the proxy's `total_exceptions`. */
  exceptions: number;
  observedAt: string;
}

/** Everything `GET /api/gateway/exceptions/history` returns. */
export interface GatewayExceptionHistory {
  from: string;
  to: string;
  /**
   * The first night a sweep was ever filed, answered outside the window for the
   * same reason every other history route answers it: an empty list means "no
   * errors recorded" or "we started recording on Tuesday", and only one of those
   * is a finding.
   */
  recordingSince: string | null;
  observations: GatewayExceptionObservation[];
  sweeps: GatewayExceptionSweep[];
}

/**
 * Observed nights needed before the window may be split in half and compared.
 *
 * Six, matching the hang history, and for the same reason restated over a
 * different quantity: each half is three nights, and fewer than that compares
 * one afternoon's incident against another. Counted in *swept* nights rather
 * than calendar ones — a scheduler that missed four nights gathered no evidence.
 */
export const EXCEPTION_TREND_MIN_DAYS = 6;

/** Gateway-wide, for one night the sweep ran. */
export interface GatewayExceptionHistoryDay {
  date: string;
  /** Exceptions recorded that night. Zero on a swept night that found none. */
  total: number;
  /** The night's own mix, largest first. Empty on a clean night. */
  classes: { class: GatewayExceptionClass; count: number }[];
  /** How many deployments recorded at least one. */
  deployments: number;
  /** How many aliases were swept — the night's coverage, not the gateway's size. */
  models: number;
  /** Swept and found nothing. Distinct from a night with no reading at all. */
  clean: boolean;
}

/** One class across every night it was recorded. */
export interface GatewayExceptionHistoryClass {
  class: GatewayExceptionClass;
  count: number;
  /**
   * Share of every exception *recorded* in the window — the mix, and the only
   * share this layer can produce. Never a share of traffic or of failures.
   */
  share: number;
  /** Nights carrying at least one of these. Evidence, never a duration. */
  daysPresent: number;
  /** How many deployments produced them. */
  deployments: number;
  /** The class's own types, largest first. */
  types: GatewayExceptionCount[];
  firstDate: string;
  lastDate: string;
  /**
   * Half-over-half movement of this class's **share of the mix**, in percentage
   * points. Null while the trend is withheld.
   *
   * A mix shift rather than a count trend, and that is the whole point of the
   * layer: with no denominator, a doubling of traffic doubles every class and
   * means nothing, while a class going from a fifth of recorded errors to half
   * of them is a change in what is breaking. Counts ride along as evidence and
   * are never the statement.
   */
  shiftPoints: number | null;
  /** Recorded in the recent half and never in the earlier one. Null while withheld. */
  newInRecentHalf: boolean | null;
}

/** One deployment across every night it recorded something. */
export interface GatewayExceptionHistoryDeployment {
  /** `combined_model_api_base`, verbatim. Join to health with `deploymentExceptionKey`. */
  deployment: string;
  /** The aliases whose traffic routed here, ascending. */
  models: string[];
  count: number;
  /** Share of every exception recorded in the window. */
  share: number;
  dominantClass: GatewayExceptionClass | null;
  dominantShare: number | null;
  daysPresent: number;
  firstDate: string;
  lastDate: string;
  /** The night this deployment recorded the most. */
  worstDay: { date: string; count: number } | null;
}

/**
 * The swept nights split in two halves and pooled, compared on **mix**.
 *
 * Pooled counts rather than a mean of nightly shares, for the reason the hang
 * trend pools: nightly totals differ by orders of magnitude, so a quiet night's
 * two timeouts would otherwise outvote a bad night's four hundred rate limits.
 */
export interface GatewayExceptionMixTrend {
  earlier: { from: string; to: string; days: number; total: number };
  recent: { from: string; to: string; days: number; total: number };
  /** Every class seen in either half, ordered by the size of the move. */
  classes: {
    class: GatewayExceptionClass;
    earlierCount: number;
    earlierShare: number;
    recentCount: number;
    recentShare: number;
    deltaPoints: number;
  }[];
}

export interface GatewayExceptionHistorySummary {
  from: string;
  to: string;
  recordingSince: string | null;
  /** Nights the sweep ran, ascending — including the ones that found nothing. */
  observedDays: string[];
  /**
   * Calendar days inside the window carrying no sweep at all, counted forward
   * from `recordingSince`. Never filled in: an unswept night is unknown, not a
   * night on which nothing failed.
   */
  unobservedDays: number;
  /** Of the observed nights, how many were swept and recorded nothing. */
  cleanDays: number;
  days: GatewayExceptionHistoryDay[];
  classes: GatewayExceptionHistoryClass[];
  deployments: GatewayExceptionHistoryDeployment[];
  /** Every exception recorded in the window. A floor on failures, never their count. */
  total: number;
  trend: GatewayExceptionMixTrend | null;
}

/** `2026-07-31`, `2026-07-28` → 3. Both UTC midnights, so DST never shifts it. */
function daysBetweenIso(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Stored nightly sweeps → what has been breaking, and whether that changed.
 *
 * Pure, and the counterpart to `summarizeGatewayExceptions` in the same way
 * `summarizeSlowResponseHistory` is to `summarizeGatewaySlowResponses`: that one
 * states what one window the proxy answered may be read to mean, this one states
 * what a *sequence* of nightly windows may. Four rules carry it:
 *
 *  - counts add, across the sweep and across nights, because they are disjoint
 *    error-log rows — the same licence the hang table has and `/model/metrics`
 *    does not;
 *  - there is still **no denominator**, so there is no rate, no badge and no
 *    significance test anywhere in here; every share is of recorded exceptions;
 *  - the trend is therefore a **mix shift** in percentage points, which is the
 *    one reading a missing denominator cannot corrupt;
 *  - a night with no sweep is unknown, a night with a sweep and no rows is clean,
 *    and the two are never merged.
 */
export function summarizeExceptionHistory(
  history: GatewayExceptionHistory,
): GatewayExceptionHistorySummary {
  const sweptDays = new Map<string, GatewayExceptionSweep>();
  for (const sweep of history.sweeps) sweptDays.set(sweep.date, sweep);

  const byDay = new Map<
    string,
    { total: number; classes: Map<GatewayExceptionClass, number>; deployments: Set<string> }
  >();
  const byClass = new Map<
    GatewayExceptionClass,
    {
      count: number;
      days: Set<string>;
      deployments: Set<string>;
      types: Map<string, GatewayExceptionCount>;
    }
  >();
  const byDeployment = new Map<
    string,
    {
      models: Set<string>;
      count: number;
      classes: Map<GatewayExceptionClass, number>;
      days: Map<string, number>;
    }
  >();

  for (const observation of history.observations) {
    if (!Number.isFinite(observation.count) || observation.count <= 0) continue;
    const exceptionClass = classifyGatewayException(observation.type);

    let day = byDay.get(observation.date);
    if (day === undefined) {
      day = { total: 0, classes: new Map(), deployments: new Set() };
      byDay.set(observation.date, day);
    }
    day.total += observation.count;
    day.classes.set(exceptionClass, (day.classes.get(exceptionClass) ?? 0) + observation.count);
    day.deployments.add(observation.deployment);

    let klass = byClass.get(exceptionClass);
    if (klass === undefined) {
      klass = { count: 0, days: new Set(), deployments: new Set(), types: new Map() };
      byClass.set(exceptionClass, klass);
    }
    klass.count += observation.count;
    klass.days.add(observation.date);
    klass.deployments.add(observation.deployment);
    const type = klass.types.get(observation.type);
    if (type === undefined) {
      klass.types.set(observation.type, {
        type: observation.type,
        class: exceptionClass,
        count: observation.count,
      });
    } else {
      type.count += observation.count;
    }

    let deployment = byDeployment.get(observation.deployment);
    if (deployment === undefined) {
      deployment = { models: new Set(), count: 0, classes: new Map(), days: new Map() };
      byDeployment.set(observation.deployment, deployment);
    }
    deployment.models.add(observation.model);
    deployment.count += observation.count;
    deployment.classes.set(
      exceptionClass,
      (deployment.classes.get(exceptionClass) ?? 0) + observation.count,
    );
    deployment.days.set(
      observation.date,
      (deployment.days.get(observation.date) ?? 0) + observation.count,
    );
  }

  // The night series is driven by the *receipts*, not by the rows: a swept night
  // that recorded nothing is a day of the series with a total of zero, and a
  // night nobody swept is absent from it. A day carrying rows but no receipt is
  // tolerated as observed — the rows are proof the sweep ran, whatever went
  // missing on the way to the receipt table.
  const dayDates = new Set<string>([...sweptDays.keys(), ...byDay.keys()]);
  const days: GatewayExceptionHistoryDay[] = [...dayDates]
    .sort((a, b) => a.localeCompare(b))
    .map((date) => {
      const recorded = byDay.get(date);
      const sweep = sweptDays.get(date);
      const classes = [...(recorded?.classes ?? new Map<GatewayExceptionClass, number>())]
        .map(([exceptionClass, count]) => ({ class: exceptionClass, count }))
        .sort((a, b) => b.count - a.count || a.class.localeCompare(b.class));
      const total = recorded?.total ?? 0;
      return {
        date,
        total,
        classes,
        deployments: recorded?.deployments.size ?? 0,
        models: sweep?.models ?? 0,
        clean: total === 0,
      };
    });
  const observedDays = days.map((day) => day.date);
  const total = days.reduce((sum, day) => sum + day.total, 0);

  const trend = buildMixTrend(days, history.observations);
  const trendClasses = new Map(trend?.classes.map((entry) => [entry.class, entry]) ?? []);

  const classes: GatewayExceptionHistoryClass[] = [...byClass.entries()]
    .map(([exceptionClass, bucket]) => {
      const dates = [...bucket.days].sort((a, b) => a.localeCompare(b));
      const moved = trendClasses.get(exceptionClass);
      return {
        class: exceptionClass,
        count: bucket.count,
        share: total === 0 ? 0 : bucket.count / total,
        daysPresent: dates.length,
        deployments: bucket.deployments.size,
        types: [...bucket.types.values()].sort((a, b) => b.count - a.count),
        firstDate: dates[0] ?? '',
        lastDate: dates[dates.length - 1] ?? '',
        shiftPoints: moved?.deltaPoints ?? null,
        newInRecentHalf:
          trend === null ? null : moved !== undefined && moved.earlierCount === 0 && moved.recentCount > 0,
      };
    })
    .sort((a, b) => b.count - a.count || a.class.localeCompare(b.class));

  const deployments: GatewayExceptionHistoryDeployment[] = [...byDeployment.entries()]
    .map(([deployment, bucket]) => {
      const dates = [...bucket.days.keys()].sort((a, b) => a.localeCompare(b));
      let dominant: { class: GatewayExceptionClass; count: number } | null = null;
      for (const [exceptionClass, count] of bucket.classes) {
        if (dominant === null || count > dominant.count) dominant = { class: exceptionClass, count };
      }
      let worstDay: GatewayExceptionHistoryDeployment['worstDay'] = null;
      for (const [date, count] of bucket.days) {
        if (worstDay === null || count > worstDay.count) worstDay = { date, count };
      }
      return {
        deployment,
        models: [...bucket.models].sort(),
        count: bucket.count,
        share: total === 0 ? 0 : bucket.count / total,
        dominantClass: dominant?.class ?? null,
        dominantShare: dominant === null || bucket.count === 0 ? null : dominant.count / bucket.count,
        daysPresent: dates.length,
        firstDate: dates[0] ?? '',
        lastDate: dates[dates.length - 1] ?? '',
        worstDay,
      };
    })
    .sort((a, b) => b.count - a.count || a.deployment.localeCompare(b.deployment));

  // Gaps are counted from the first night anything was ever swept, so the
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
    cleanDays: days.filter((day) => day.clean).length,
    days,
    classes,
    deployments,
    total,
    trend,
  };
}

/**
 * Split the swept nights down the middle and compare the two halves' mixes.
 *
 * The split is on *swept* nights rather than on the calendar, so a fortnight the
 * scheduler was down shifts the boundary instead of emptying a half; an odd
 * night goes to the recent half, because the question is about now. Clean nights
 * count towards the split — they are evidence the gateway was quiet — but a half
 * that recorded nothing at all has no mix to compare, so the trend is withheld
 * rather than reported as every class moving to zero.
 */
function buildMixTrend(
  days: GatewayExceptionHistoryDay[],
  observations: GatewayExceptionObservation[],
): GatewayExceptionMixTrend | null {
  if (days.length < EXCEPTION_TREND_MIN_DAYS) return null;
  const cut = Math.floor(days.length / 2);
  const earlierDays = days.slice(0, cut);
  const recentDays = days.slice(cut);
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

  const earlierTotal = earlierDays.reduce((sum, day) => sum + day.total, 0);
  const recentTotal = recentDays.reduce((sum, day) => sum + day.total, 0);
  if (earlierTotal <= 0 || recentTotal <= 0) return null;

  const earlierByClass = new Map<GatewayExceptionClass, number>();
  const recentByClass = new Map<GatewayExceptionClass, number>();
  for (const observation of observations) {
    if (!Number.isFinite(observation.count) || observation.count <= 0) continue;
    const bucket =
      observation.date <= lastEarlier.date
        ? earlierByClass
        : observation.date >= firstRecent.date
          ? recentByClass
          : null;
    if (bucket === null) continue;
    const exceptionClass = classifyGatewayException(observation.type);
    bucket.set(exceptionClass, (bucket.get(exceptionClass) ?? 0) + observation.count);
  }

  const seen = new Set<GatewayExceptionClass>([...earlierByClass.keys(), ...recentByClass.keys()]);
  const classes = [...seen]
    .map((exceptionClass) => {
      const earlierCount = earlierByClass.get(exceptionClass) ?? 0;
      const recentCount = recentByClass.get(exceptionClass) ?? 0;
      const earlierShare = earlierCount / earlierTotal;
      const recentShare = recentCount / recentTotal;
      return {
        class: exceptionClass,
        earlierCount,
        earlierShare,
        recentCount,
        recentShare,
        deltaPoints: (recentShare - earlierShare) * 100,
      };
    })
    .sort((a, b) => Math.abs(b.deltaPoints) - Math.abs(a.deltaPoints) || a.class.localeCompare(b.class));

  return {
    earlier: {
      from: first.date,
      to: lastEarlier.date,
      days: earlierDays.length,
      total: earlierTotal,
    },
    recent: {
      from: firstRecent.date,
      to: last.date,
      days: recentDays.length,
      total: recentTotal,
    },
    classes,
  };
}
