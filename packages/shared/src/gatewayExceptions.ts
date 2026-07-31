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
