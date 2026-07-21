import type {
  BillingImportResult,
  CopilotSeat,
  DateRange,
  ModelUsage,
  RefreshJob,
  RefreshKind,
  SpendPayload,
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
 * One GitHub billing usage report (Report 1 or Report 2 — the server detects
 * which from the header). The response body *is* the result, unwrapped.
 */
export function importBillingReport(csv: string): Promise<BillingImportResult> {
  return postCsv<BillingImportResult>('/import/billing', csv);
}

/** GitHub org user export (login → saml_name_id). Wrapped in `{ result }`. */
export async function importUserExport(csv: string): Promise<{ rowsUpserted: number }> {
  const { result } = await postCsv<{ result: { rowsUpserted: number } }>('/import/users', csv);
  return result;
}

/** Claude Code telemetry, rolled up to (day, user, model, metric, type). */
export async function fetchTelemetryRollup(days: number): Promise<TelemetryRollupRow[]> {
  const { rollup } = await request<{ rollup: TelemetryRollupRow[] }>(
    `/telemetry/rollup?days=${days}`,
  );
  return rollup;
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
