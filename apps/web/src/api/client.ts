import type { CopilotSeat, ImportResult, ModelUsage, RefreshJob, SpendPoint } from '@dash/shared';

/** Vite proxies /api to the backend in dev; same-origin in production. */
const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only advertise a JSON body when we're actually sending one. A POST that sets
  // Content-Type: application/json with an empty body makes Fastify reject it 400
  // (FST_ERR_CTP_EMPTY_JSON_BODY) — which is exactly what POST /refresh did.
  const response = await fetch(`${BASE}${path}`, {
    ...init,
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

export async function fetchModels(days: number): Promise<ModelUsage[]> {
  const { models } = await request<{ models: ModelUsage[] }>(`/models?days=${days}`);
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
