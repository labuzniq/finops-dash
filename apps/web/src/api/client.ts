import type {
  BillingImportResult,
  CopilotSeat,
  DateRange,
  GatewayBudgetHistory,
  GatewayBudgets,
  GatewayCoverage,
  GatewayDeploymentHistory,
  GatewayExceptions,
  GatewayHealth,
  GatewayLatency,
  GatewayModels,
  GatewayNotifications,
  GatewayProbe,
  GatewaySealHistory,
  GatewaySeals,
  GatewaySlowResponseHistory,
  GatewaySlowResponses,
  GatewaySource,
  GatewaySpendLogs,
  GatewayUsage,
  ImportLogEntry,
  ModelUsage,
  RefreshJob,
  RefreshKind,
  SpendPayload,
  TelemetryFreshness,
  TelemetryRollupRow,
  UsageHistory,
} from '@dash/shared';

/** Vite proxies /api to the backend in dev; same-origin in production. */
const BASE = '/api';

/**
 * Auth is a single shared token. Login sets an 8h session cookie; every other
 * call rides on it. See apps/api/src/auth/session.ts.
 */
export async function fetchAuthStatus(): Promise<boolean> {
  const response = await fetch(`${BASE}/auth/me`, { credentials: 'include' });
  return response.ok;
}

/** Resolves on success; throws with the server's message on a bad token. */
export async function login(token: string): Promise<void> {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? 'Login failed');
  }
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only advertise a JSON body when we're actually sending one. A POST that sets
  // Content-Type: application/json with an empty body makes Fastify reject it 400
  // (FST_ERR_CTP_EMPTY_JSON_BODY) — which is exactly what POST /refresh did.
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    // Carry the session cookie on every call.
    credentials: 'include',
    ...(init?.body
      ? { headers: { 'Content-Type': 'application/json', ...init.headers } }
      : {}),
  });

  if (!response.ok) {
    // The API answers every failure with `{ error }` — a rejected CSV names the
    // offending line, and a 503 explains that JIRA is unconfigured. Those read
    // far better than a bare status, so prefer them when present.
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${init?.method ?? 'GET'} ${path} failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

/** Raw-CSV POST. Same session cookie and error unwrapping as every other call. */
function postCsv<T>(path: string, csv: string): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    body: csv,
  });
}

export async function fetchSeats(): Promise<CopilotSeat[]> {
  const { seats } = await request<{ seats: CopilotSeat[] }>('/seats');
  return seats;
}

/**
 * The billing-report payload for an inclusive ISO date range. The body *is*
 * the `SpendPayload` — no wrapper key, unlike the other endpoints.
 */
export async function fetchSpend(from: string, to: string): Promise<SpendPayload> {
  return request<SpendPayload>(`/spend?from=${from}&to=${to}`);
}

/** Org usage history — daily aggregates, breakdowns, adoption phases. */
export async function fetchUsage(days: number): Promise<UsageHistory> {
  const { usage } = await request<{ usage: UsageHistory }>(`/usage?days=${days}`);
  return usage;
}

export async function fetchModels(range: DateRange): Promise<ModelUsage[]> {
  const query =
    range.kind === 'preset' ? `days=${range.days}` : `from=${range.from}&to=${range.to}`;
  const { models } = await request<{ models: ModelUsage[] }>(`/models?${query}`);
  return models;
}

/**
 * The uploaded file's name, for the import log. A query parameter because the
 * body of these two endpoints is the CSV itself — there is nowhere else to put
 * it. Omitted names are logged as `upload.csv` server-side.
 */
function named(path: string, filename?: string): string {
  return filename === undefined ? path : `${path}?filename=${encodeURIComponent(filename)}`;
}

/**
 * One GitHub billing usage report (Report 1 or Report 2 — the server detects
 * which from the header). The response body *is* the result, unwrapped.
 */
export function importBillingReport(
  csv: string,
  filename?: string,
): Promise<BillingImportResult> {
  return postCsv<BillingImportResult>(named('/import/billing', filename), csv);
}

/** GitHub org user export (login → saml_name_id). Wrapped in `{ result }`. */
export async function importUserExport(
  csv: string,
  filename?: string,
): Promise<{ rowsUpserted: number }> {
  const { result } = await postCsv<{ result: { rowsUpserted: number } }>(
    named('/import/users', filename),
    csv,
  );
  return result;
}

/** The import log — every upload run, newest first, capped server-side. */
export async function fetchImportLogs(): Promise<ImportLogEntry[]> {
  const { imports } = await request<{ imports: ImportLogEntry[] }>('/imports');
  return imports;
}

/** Claude Code telemetry, rolled up to (day, user, model, metric, type). */
export async function fetchTelemetryRollup(days: number): Promise<TelemetryRollupRow[]> {
  const { rollup } = await request<{ rollup: TelemetryRollupRow[] }>(
    `/telemetry/rollup?days=${days}`,
  );
  return rollup;
}

/**
 * When the newest OTLP datapoint landed. Telemetry is pushed, not synced, so
 * this timestamp is the only "connected" signal the Claude Code source has.
 */
export function fetchTelemetryFreshness(): Promise<TelemetryFreshness> {
  return request<TelemetryFreshness>('/telemetry/freshness');
}

export async function startRefresh(): Promise<RefreshJob> {
  const { job } = await request<{ job: RefreshJob }>('/refresh', { method: 'POST' });
  return job;
}

export async function fetchRefreshJob(id: string): Promise<RefreshJob> {
  const { job } = await request<{ job: RefreshJob }>(`/refresh/${id}`);
  return job;
}

export async function fetchLatestRefreshJob(kind: RefreshKind = 'copilot'): Promise<RefreshJob | null> {
  const { job } = await request<{ job: RefreshJob | null }>(`/refresh/latest?kind=${kind}`);
  return job;
}

/**
 * Kick off a JIRA identity sync — same job table as the Copilot refresh, so the
 * returned job is polled through `fetchRefreshJob`. A 503 (JIRA env unset)
 * surfaces the server's own message via the shared error unwrapping.
 */
export async function startJiraSync(): Promise<RefreshJob> {
  const { job } = await request<{ job: RefreshJob }>('/jira/sync', { method: 'POST' });
  return job;
}

/**
 * Kick off an enterprise billing sync (kind `billing`) — polled through
 * `fetchRefreshJob` like the others. A 503 (GITHUB_ENTERPRISE unset) surfaces
 * the server's message via the shared error unwrapping.
 */
export async function startBillingSync(): Promise<RefreshJob> {
  const { job } = await request<{ job: RefreshJob }>('/refresh/billing', { method: 'POST' });
  return job;
}

/** An inclusive day range for a backfill; absent means the full nightly window. */
export interface GatewaySyncWindow {
  from: string;
  to: string;
}

/**
 * Kick off an LLM-gateway sync (kind `gateway`) — polled through
 * `fetchRefreshJob` like the others. A 503 (GATEWAY_SOURCE off) surfaces the
 * server's message via the shared error unwrapping.
 *
 * With a window it is a backfill of exactly those days, which is how the
 * coverage note's gaps are repaired; a 400 (a range the proxy has pruned)
 * surfaces the same way as the 503.
 */
export async function startGatewaySync(window?: GatewaySyncWindow): Promise<RefreshJob> {
  const query = window ? `?from=${window.from}&to=${window.to}` : '';
  const { job } = await request<{ job: RefreshJob }>(`/refresh/gateway${query}`, {
    method: 'POST',
  });
  return job;
}

/**
 * LiteLLM gateway usage for an inclusive ISO date range — daily totals plus
 * every breakdown dimension. The body *is* the payload, like `/spend`.
 */
export function fetchGatewayUsage(from: string, to: string): Promise<GatewayUsage> {
  return request<GatewayUsage>(`/gateway?from=${from}&to=${to}`);
}

/**
 * The proxy's current budgets and rate limits, per key and per team.
 *
 * No date range: this is configuration plus the counter for the period in
 * flight, replaced wholesale by every sync and carrying no history at all.
 */
export function fetchGatewayBudgets(): Promise<GatewayBudgets> {
  return request<GatewayBudgets>('/gateway/budgets');
}

/**
 * What those budgets read on each of the last `days` days.
 *
 * The only governance call with a window, and the only source of any budget
 * fact older than the last sync — the proxy serves current state only, so this
 * is the dashboard's own recording rather than a second read of LiteLLM.
 */
export function fetchGatewayBudgetHistory(days: number): Promise<GatewayBudgetHistory> {
  return request<GatewayBudgetHistory>(`/gateway/budgets/history?days=${days}`);
}

/**
 * Governance findings and their delivery state — the one gateway read about the
 * dashboard's own behaviour rather than the proxy's.
 */
export function fetchGatewayNotifications(days: number): Promise<GatewayNotifications> {
  return request<GatewayNotifications>(`/gateway/notifications?days=${days}`);
}

/**
 * The proxy's configured price list — one row per public model alias.
 *
 * Configuration rather than usage, like the budget snapshot: no date range, no
 * history, replaced wholesale by every full sync. It is what the recorded spend
 * is *compared against*, never what a dollar figure is computed from.
 */
export function fetchGatewayModels(): Promise<GatewayModels> {
  return request<GatewayModels>('/gateway/models');
}

/**
 * Per-deployment health as the last full sync read it.
 *
 * A *stored* reading rather than a live call, and the distinction is the whole
 * shape of the card: `/health` on the proxy issues a test call to every
 * deployment while answering, so it is taken once a night and rendered with its
 * own age on it. No date range — like the budget snapshot and the price list,
 * it is current state replaced wholesale by every full sync.
 */
export function fetchGatewayHealth(): Promise<GatewayHealth> {
  return request<GatewayHealth>('/gateway/health');
}

/**
 * What those deployments read on each of the last `days` days — our own
 * recording, not a second read of the proxy.
 *
 * The snapshot above is replaced by every full sync, so it can say a pool is
 * refusing tonight and never that it has been refusing all week. A thinner
 * sample than the budget history and read as one: a day with no row is a night
 * nobody looked at, and nothing derived from it is ever a duration.
 */
export function fetchGatewayDeploymentHistory(days: number): Promise<GatewayDeploymentHistory> {
  return request<GatewayDeploymentHistory>(`/gateway/health/history?days=${days}`);
}

/**
 * Which days the dashboard has stored, and which are missing.
 *
 * Not a usage call: it describes the table, and it is what tells the page how
 * far back it may look. The stored history outlives the proxy's retention
 * window, so a floor computed from `today − 89` in the browser would hide data
 * the API is holding.
 */
export function fetchGatewayCoverage(): Promise<GatewayCoverage> {
  return request<GatewayCoverage>('/gateway/coverage');
}

/**
 * The months that have been sealed — a closed month's totals as they were
 * recorded, not as the daily rows read today.
 *
 * Headers only, and no date range: it is a handful of rows and the chargeback
 * card needs whichever month it happens to be showing. The sealed total is what
 * the card compares its own derivation against, which is how a month that was
 * revised after its statement was issued becomes visible.
 */
export function fetchGatewaySeals(): Promise<GatewaySeals> {
  return request<GatewaySeals>('/gateway/months');
}

/**
 * Every statement one month has carried, with what each re-seal changed.
 *
 * Fetched only for a month that has been re-sealed — a month sealed once has
 * nothing to compare — which is why it is a second call rather than part of
 * the seal list: the list is on every visit, this is on the rare month whose
 * bill was corrected.
 */
export function fetchGatewaySealHistory(month: string): Promise<GatewaySealHistory> {
  return request<GatewaySealHistory>(`/gateway/months/${month}/revisions`);
}

/**
 * A sample of individual requests — the only gateway read that carries every
 * dimension on one row, and the only one that is fetched from the proxy live.
 *
 * Nothing stores these rows: they come from the largest table LiteLLM has, are
 * pruned on the proxy's own schedule, and may be switched off entirely. The
 * window is capped at a week upstream and the answer at a few thousand rows, so
 * what comes back is evidence rather than a ledger — which is also why this is
 * a manual read rather than something the page mounts.
 */
export function fetchGatewaySpendLogs(
  from: string,
  to: string,
  limit?: number,
): Promise<GatewaySpendLogs> {
  const query = new URLSearchParams({ from, to });
  if (limit !== undefined) query.set('limit', String(limit));
  return request<GatewaySpendLogs>(`/gateway/logs?${query.toString()}`);
}

/**
 * Why the failed calls in a window failed, per deployment — the only source
 * that carries a *reason* rather than a count.
 *
 * Live like the request sample, and stored nowhere: it reads
 * `LiteLLM_ErrorLogs`, which is switched on separately from the aggregates and
 * pruned on its own schedule. The proxy's route has no wildcard, so the API
 * sweeps one alias at a time and reports the ones its cap left unread — which
 * is why this is a manual read too.
 */
export function fetchGatewayExceptions(from: string, to: string): Promise<GatewayExceptions> {
  const query = new URLSearchParams({ from, to });
  return request<GatewayExceptions>(`/gateway/exceptions?${query.toString()}`);
}

/**
 * How slowly each deployment answered over a window — the only time the proxy
 * exports, and the only gateway read whose unit is a rate.
 *
 * Live like the request sample and the exception sweep, and stored nowhere: it
 * aggregates `LiteLLM_SpendLogs`, so `disable_spend_logs` empties it and it is
 * pruned on the request log's schedule. The route has no wildcard either, so
 * the API sweeps one alias at a time and reports what its cap left out — which
 * is why this is a manual read too.
 */
export function fetchGatewayLatency(from: string, to: string): Promise<GatewayLatency> {
  const query = new URLSearchParams({ from, to });
  return request<GatewayLatency>(`/gateway/latency?${query.toString()}`);
}

/**
 * How many calls hung over a window, per endpoint — the only reading of wall
 * clock the proxy will aggregate.
 *
 * Live and stored nowhere like the three reads above it, and manual for both of
 * their reasons at once: it counts `LiteLLM_SpendLogs` rows (so
 * `disable_spend_logs` empties it and its retention is the log's) and it filters
 * on one alias at a time with no wildcard, so a read is a round trip per model.
 * The threshold it counts against is the proxy's own and is not in the
 * response — nothing downstream may attach seconds to what comes back.
 */
export function fetchGatewaySlowResponses(
  from: string,
  to: string,
): Promise<GatewaySlowResponses> {
  const query = new URLSearchParams({ from, to });
  return request<GatewaySlowResponses>(`/gateway/slow-responses?${query.toString()}`);
}

/**
 * The nightly hang sweeps kept — our own recording, not a second read of the
 * proxy.
 *
 * The only history any of the four live reads has, and the only one any of them
 * may have: this route answers counts of disjoint request-log rows beside their
 * own denominator, and counts add across nights where an average
 * (`/model/metrics`) and a denominator-less total (`/model/metrics/exceptions`)
 * do not. Read on mount unlike the live sweep above it, because it is a table of
 * ours rather than a round trip per alias into the proxy's request log.
 *
 * Its window ends *yesterday*, unlike the two other history routes: the sweep
 * covers the day usage has settled for, so today can never carry a reading and a
 * window ending on it would report a gap on the newest night forever.
 */
export function fetchGatewaySlowResponseHistory(days: number): Promise<GatewaySlowResponseHistory> {
  return request<GatewaySlowResponseHistory>(`/gateway/slow-responses/history?days=${days}`);
}

/**
 * A live connection check against the proxy — one round trip per route it
 * depends on, run now rather than read from a table.
 *
 * Slower than every other call here (it is bounded by the proxy, not by
 * Postgres) and deliberately manual: it is a diagnostic someone asks for, not
 * something a page mounts.
 */
export function fetchGatewayProbe(): Promise<GatewayProbe> {
  return request<GatewayProbe>('/gateway/probe');
}

/** Whether a gateway source is configured at all — gates the whole view. */
export function fetchGatewayStatus(): Promise<GatewayStatus> {
  return request<GatewayStatus>('/gateway/status');
}

export interface GatewayStatus {
  source: GatewaySource;
  configured: boolean;
}
