import { TELEMETRY_METRICS } from '@dash/shared';
import type { DateRange, TelemetryRollupRow } from '@dash/shared';
import { ALL } from './filter.js';
import type { ScaledSpendPoint } from './spend.js';

/**
 * Claude Code telemetry derivations. One pass over the rollup rows produces
 * the KPIs, the daily cost series and the per-user table — filtered by user
 * and model, sliced to the selected range. Pure functions, memoised by the
 * page, like the Copilot pipeline.
 */

/** Leaderboard depth — enough to show the shape without scrolling. */
const TOP_USERS_LIMIT = 8;

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
  pullRequests: number;
  /** ISO date of the most recent activity in range. */
  lastActiveDate: string | null;
  /** Model with the most tokens for this user; null before any token data. */
  topModel: string | null;
}

export interface DailyTokenPoint {
  date: Date;
  input: number;
  output: number;
  cache: number;
  total: number;
}

export interface TokenLeaderboardRow {
  user: string;
  input: number;
  output: number;
  cache: number;
  total: number;
}

/** Org-wide range totals; null when the metric has no rows at all in range. */
export interface TelemetryTotals {
  linesAdded: number | null;
  linesRemoved: number | null;
  commits: number | null;
  pullRequests: number | null;
}

export interface TelemetrySummary {
  totalCostUsd: number;
  totalTokens: number;
  sessions: number;
  activeUsers: number;
  /** Daily cost, zero-filled across the whole range so the chart has a spine. */
  points: ScaledSpendPoint[];
  /** Daily token volumes by kind, zero-filled across the whole range. */
  dailyTokens: DailyTokenPoint[];
  /** Top users by total tokens in range — the leaderboard card. */
  topUsersByTokens: TokenLeaderboardRow[];
  /** Org-wide engineering-output totals for the KPI tiles. */
  totals: TelemetryTotals;
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

/** Every ISO date from `from` to `to` inclusive — the chart's zero-fill spine. */
function isoDatesBetween(from: string, to: string): string[] {
  const [year, month, day] = from.split('-');
  const cursor = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const dates: string[] = [];
  for (let iso = from; iso <= to; ) {
    dates.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    iso = cursor.toISOString().slice(0, 10);
  }
  return dates;
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
    pullRequests: 0,
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
    case TELEMETRY_METRICS.pullRequests:
      acc.pullRequests += row.value;
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
  range: DateRange,
  filters: TelemetryFilters,
): TelemetrySummary {
  const startIso = range.kind === 'preset' ? isoDaysAgo(range.days - 1) : range.from;
  const endIso = range.kind === 'preset' ? isoDaysAgo(0) : range.to;
  const inRange = rows.filter((row) => row.date >= startIso && row.date <= endIso);

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
  const tokensByDate = new Map<string, { input: number; output: number; cache: number }>();
  let linesAdded: number | null = null;
  let linesRemoved: number | null = null;
  let commits: number | null = null;
  let pullRequests: number | null = null;
  const byUser = new Map<string, MutableUserRow>();

  for (const row of filtered) {
    if (row.metric === TELEMETRY_METRICS.cost) {
      totalCostUsd += row.value;
      costByDate.set(row.date, (costByDate.get(row.date) ?? 0) + row.value);
    } else if (row.metric === TELEMETRY_METRICS.tokens) {
      totalTokens += row.value;
      const day = tokensByDate.get(row.date) ?? { input: 0, output: 0, cache: 0 };
      if (row.type === 'input') day.input += row.value;
      else if (row.type === 'output') day.output += row.value;
      else day.cache += row.value;
      tokensByDate.set(row.date, day);
    } else if (row.metric === TELEMETRY_METRICS.sessions) {
      sessions += row.value;
    } else if (row.metric === TELEMETRY_METRICS.linesOfCode) {
      // Null-start: a metric that never appears stays unknown, not zero.
      if (row.type === 'removed') linesRemoved = (linesRemoved ?? 0) + row.value;
      else linesAdded = (linesAdded ?? 0) + row.value;
    } else if (row.metric === TELEMETRY_METRICS.commits) {
      commits = (commits ?? 0) + row.value;
    } else if (row.metric === TELEMETRY_METRICS.pullRequests) {
      pullRequests = (pullRequests ?? 0) + row.value;
    }

    const user = rowUser(row);
    if (user === null) continue;
    activeUsers.add(user);

    const acc = byUser.get(user) ?? emptyUserRow(user);
    accumulateUser(acc, row);
    byUser.set(user, acc);
  }

  const spine = isoDatesBetween(startIso, endIso);

  const points: ScaledSpendPoint[] = spine.map((iso) => {
    const cost = costByDate.get(iso) ?? 0;
    return { date: parseIsoDate(iso), license: cost, premiumOverage: 0, total: cost };
  });

  const dailyTokens: DailyTokenPoint[] = spine.map((iso) => {
    const day = tokensByDate.get(iso) ?? { input: 0, output: 0, cache: 0 };
    return { date: parseIsoDate(iso), ...day, total: day.input + day.output + day.cache };
  });

  const users = [...byUser.values()]
    .map(({ modelTokens, ...row }) => ({ ...row, topModel: topModel(modelTokens) }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const topUsersByTokens: TokenLeaderboardRow[] = users
    .filter((row) => row.tokens > 0)
    .map((row) => ({
      user: row.user,
      input: row.inputTokens,
      output: row.outputTokens,
      cache: row.cacheTokens,
      total: row.tokens,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, TOP_USERS_LIMIT);

  return {
    totalCostUsd,
    totalTokens,
    sessions,
    activeUsers: activeUsers.size,
    points,
    dailyTokens,
    topUsersByTokens,
    totals: { linesAdded, linesRemoved, commits, pullRequests },
    users,
    userOptions: [...userSet].sort((a, b) => a.localeCompare(b)),
    modelOptions: [...modelSet].sort((a, b) => a.localeCompare(b)),
  };
}
