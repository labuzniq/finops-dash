import type {
  CopilotSeat,
  DateRange,
  ImportResult,
  ModelUsage,
  RefreshJob,
  SpendPoint,
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
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function fetchSeats(): Promise<CopilotSeat[]> {
  const { seats } = await request<{ seats: CopilotSeat[] }>('/seats');
  return seats;
}

export async function fetchSpend(days: number): Promise<SpendPoint[]> {
  const { spend } = await request<{ spend: SpendPoint[] }>(`/spend?days=${days}`);
  return spend;
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
 * Manual CSV/JSON/NDJSON import. `content` is the raw file text or JSON rows.
 * A 422 (nothing landed, but the server explained why) is a normal outcome we
 * surface to the user, not an exception — so this reads the body directly.
 */
export async function importData(content: string): Promise<ImportResult> {
  const response = await fetch(`${BASE}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  const payload = (await response.json().catch(() => null)) as { result?: ImportResult } | null;
  if (!payload?.result) {
    throw new Error(`Import failed: ${response.status}`);
  }
  return payload.result;
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

export async function fetchLatestRefreshJob(): Promise<RefreshJob | null> {
  const { job } = await request<{ job: RefreshJob | null }>('/refresh/latest');
  return job;
}
