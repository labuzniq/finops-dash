import { TELEMETRY_METRICS } from '@dash/shared';
import type { TelemetryRollupRow } from '@dash/shared';
import { ALL } from './filter.js';
import type { ScaledSpendPoint } from './spend.js';

/**
 * Claude Code telemetry derivations. One pass over the rollup rows produces
 * the KPIs, the daily cost series and the per-user table — filtered by user
 * and model, sliced to the selected range. Pure functions, memoised by the
 * page, like the Copilot pipeline.
 */

export interface TelemetryFilters {
  /** A user identity (email, else id) or ALL. */
  user: string;
  /** A model id or ALL. */
  model: string;
}

export interface TelemetryUserRow {
  user: string;
  costUsd: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  sessions: number;
  linesAdded: number;
  linesRemoved: number;
  commits: number;
  /** ISO date of the most recent activity in range. */
  lastActiveDate: string | null;
  /** Model with the most tokens for this user; null before any token data. */
  topModel: string | null;
}

export interface TelemetrySummary {
  totalCostUsd: number;
  totalTokens: number;
  sessions: number;
  activeUsers: number;
  /** Daily cost, zero-filled across the whole range so the chart has a spine. */
  points: ScaledSpendPoint[];
  users: TelemetryUserRow[];
  /** Distinct identities/models in range, unfiltered — the select options. */
  userOptions: string[];
  modelOptions: string[];
}

/** Email is the human-readable identity; fall back to the exporter's user id. */
export function rowUser(row: TelemetryRollupRow): string | null {
  return row.userEmail ?? row.userId;
}

/** ISO date `days` days ago, in UTC to match the API's rollup buckets. */
function isoDaysAgo(days: number): string {
  const date = new Date(Date.now() - days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

/** `2026-07-16` as a *local* midnight, so axis labels can't slip a day. */
function parseIsoDate(iso: string): Date {
  const [year, month, day] = iso.split('-');
  return new Date(Number(year), Number(month) - 1, Number(day));
}

interface MutableUserRow extends TelemetryUserRow {
  modelTokens: Map<string, number>;
}

function emptyUserRow(user: string): MutableUserRow {
  return {
    user,
    costUsd: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    sessions: 0,
    linesAdded: 0,
    linesRemoved: 0,
    commits: 0,
    lastActiveDate: null,
    topModel: null,
    modelTokens: new Map(),
  };
}

function accumulateUser(acc: MutableUserRow, row: TelemetryRollupRow): void {
  if (acc.lastActiveDate === null || row.date > acc.lastActiveDate) acc.lastActiveDate = row.date;

  switch (row.metric) {
    case TELEMETRY_METRICS.cost:
      acc.costUsd += row.value;
      break;
    case TELEMETRY_METRICS.tokens:
      acc.tokens += row.value;
      if (row.type === 'input') acc.inputTokens += row.value;
      else if (row.type === 'output') acc.outputTokens += row.value;
      else acc.cacheTokens += row.value;
      if (row.model !== null) {
        acc.modelTokens.set(row.model, (acc.modelTokens.get(row.model) ?? 0) + row.value);
      }
      break;
    case TELEMETRY_METRICS.sessions:
      acc.sessions += row.value;
      break;
    case TELEMETRY_METRICS.linesOfCode:
      if (row.type === 'removed') acc.linesRemoved += row.value;
      else acc.linesAdded += row.value;
      break;
    case TELEMETRY_METRICS.commits:
      acc.commits += row.value;
      break;
    default:
      break;
  }
}

function topModel(modelTokens: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let bestTokens = -1;
  for (const [model, tokens] of modelTokens) {
    if (tokens > bestTokens) {
      best = model;
      bestTokens = tokens;
    }
  }
  return best;
}

export function deriveTelemetry(
  rows: readonly TelemetryRollupRow[],
  rangeDays: number,
  filters: TelemetryFilters,
): TelemetrySummary {
  const startIso = isoDaysAgo(rangeDays - 1);
  const inRange = rows.filter((row) => row.date >= startIso);

  const userSet = new Set<string>();
  const modelSet = new Set<string>();
  for (const row of inRange) {
    const user = rowUser(row);
    if (user !== null) userSet.add(user);
    if (row.model !== null) modelSet.add(row.model);
  }

  // The model filter only constrains model-dimensioned rows (tokens, cost);
  // sessions, lines and commits carry no model and pass through untouched.
  const filtered = inRange.filter(
    (row) =>
      (filters.user === ALL || rowUser(row) === filters.user) &&
      (filters.model === ALL || row.model === null || row.model === filters.model),
  );

  let totalCostUsd = 0;
  let totalTokens = 0;
  let sessions = 0;
  const activeUsers = new Set<string>();
  const costByDate = new Map<string, number>();
  const byUser = new Map<string, MutableUserRow>();

  for (const row of filtered) {
    if (row.metric === TELEMETRY_METRICS.cost) {
      totalCostUsd += row.value;
      costByDate.set(row.date, (costByDate.get(row.date) ?? 0) + row.value);
    } else if (row.metric === TELEMETRY_METRICS.tokens) {
      totalTokens += row.value;
    } else if (row.metric === TELEMETRY_METRICS.sessions) {
      sessions += row.value;
    }

    const user = rowUser(row);
    if (user === null) continue;
    activeUsers.add(user);

    const acc = byUser.get(user) ?? emptyUserRow(user);
    accumulateUser(acc, row);
    byUser.set(user, acc);
  }

  const points: ScaledSpendPoint[] = [];
  for (let daysBack = rangeDays - 1; daysBack >= 0; daysBack -= 1) {
    const iso = isoDaysAgo(daysBack);
    const cost = costByDate.get(iso) ?? 0;
    points.push({ date: parseIsoDate(iso), license: cost, premiumOverage: 0, total: cost });
  }

  const users = [...byUser.values()]
    .map(({ modelTokens, ...row }) => ({ ...row, topModel: topModel(modelTokens) }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    totalCostUsd,
    totalTokens,
    sessions,
    activeUsers: activeUsers.size,
    points,
    users,
    userOptions: [...userSet].sort((a, b) => a.localeCompare(b)),
    modelOptions: [...modelSet].sort((a, b) => a.localeCompare(b)),
  };
}
