import { and, asc, gte, lte } from 'drizzle-orm';
import { EDITORS, USAGE_DIMENSIONS } from '@dash/shared';
import type {
  AdoptionPhasePoint,
  BreakdownPoint,
  CopilotSeat,
  Editor,
  ModelUsage,
  OrgDailyPoint,
  SpendPoint,
  UsageDimension,
  UsageHistory,
} from '@dash/shared';
import { db } from '../db/client.js';
import {
  adoptionPhaseDaily,
  copilotSeats,
  modelDaily,
  orgDaily,
  spendDaily,
  usageBreakdownDaily,
} from '../db/schema.js';
import type {
  AdoptionPhaseRow,
  ModelDailyRow,
  OrgDailyRow,
  SeatRow,
  SpendRow,
  UsageBreakdownRow,
} from '../db/schema.js';

const MS_PER_DAY = 86_400_000;

/**
 * The DB columns are plain varchars, so narrow the closed ones (editor) back
 * onto their union. Language is free-form (GitHub emits dozens), so it passes
 * through as-is.
 */
function narrow<T extends string>(allowed: readonly T[], value: string | null): T | null {
  if (value === null) return null;
  return allowed.find((candidate) => candidate === value) ?? null;
}

/** Whole days since the timestamp; null stays null (never used). */
function daysSince(timestamp: Date | null, now: Date): number | null {
  if (timestamp === null) return null;
  return Math.max(0, Math.floor((now.getTime() - timestamp.getTime()) / MS_PER_DAY));
}

function toSeat(row: SeatRow, now: Date): CopilotSeat {
  return {
    login: row.login,
    name: row.name,
    plan: row.plan,
    editor: narrow<Editor>(EDITORS, row.editor),
    language: row.language,
    lastActivityDays: daysSince(row.lastActivityAt, now),
    premiumRequests28d: row.premiumRequests28d,
    acceptanceRate: row.acceptanceRate,
    usedAgent: row.usedAgent,
    usedChat: row.usedChat,
    topModel: row.topModel,
    team: row.team,
  };
}

function toSpendPoint(row: SpendRow): SpendPoint {
  return {
    date: row.date,
    license: row.licenseCents / 100,
    premiumOverage: row.premiumOverageCents / 100,
  };
}

/** ISO date `days` days before now. */
function earliestDate(days: number): string {
  const earliest = new Date();
  earliest.setDate(earliest.getDate() - days);
  return earliest.toISOString().slice(0, 10);
}

/**
 * Every seat, in one response.
 *
 * At ~1,000 seats this is a small payload, and the dashboard filters, sorts
 * and paginates client-side. Paginating server-side would mean recomputing
 * KPIs per request for no benefit.
 */
export async function listSeats(): Promise<CopilotSeat[]> {
  const rows = await db.select().from(copilotSeats).orderBy(asc(copilotSeats.login));
  const now = new Date();
  return rows.map((row) => toSeat(row, now));
}

/** Daily spend for the last `days` days, oldest first. */
export async function listSpend(days: number): Promise<SpendPoint[]> {
  const rows = await db
    .select()
    .from(spendDaily)
    .where(gte(spendDaily.date, earliestDate(days)))
    .orderBy(asc(spendDaily.date));

  return rows.map(toSpendPoint);
}

function toOrgDailyPoint(row: OrgDailyRow): OrgDailyPoint {
  const { syncedAt: _syncedAt, ...point } = row;
  return point;
}

function toBreakdownPoint(row: UsageBreakdownRow): BreakdownPoint | null {
  const dimension = narrow<UsageDimension>(USAGE_DIMENSIONS, row.dimension);
  if (dimension === null) return null;
  const { syncedAt: _syncedAt, ...rest } = row;
  return { ...rest, dimension };
}

function toAdoptionPoint(row: AdoptionPhaseRow): AdoptionPhasePoint {
  const { syncedAt: _syncedAt, ...point } = row;
  return point;
}

/**
 * The full usage history in one payload — org days, breakdown rows, adoption
 * phases. The web app fetches it once and slices by range client-side, the
 * same contract as /api/seats and /api/spend.
 */
export async function getUsageHistory(days: number): Promise<UsageHistory> {
  const floor = earliestDate(days);

  const [orgRows, breakdownRows, adoptionRows] = await Promise.all([
    db.select().from(orgDaily).where(gte(orgDaily.date, floor)).orderBy(asc(orgDaily.date)),
    db
      .select()
      .from(usageBreakdownDaily)
      .where(gte(usageBreakdownDaily.date, floor))
      .orderBy(
        asc(usageBreakdownDaily.date),
        asc(usageBreakdownDaily.dimension),
        asc(usageBreakdownDaily.key),
      ),
    db
      .select()
      .from(adoptionPhaseDaily)
      .where(gte(adoptionPhaseDaily.date, floor))
      .orderBy(asc(adoptionPhaseDaily.date), asc(adoptionPhaseDaily.phaseNumber)),
  ]);

  return {
    orgDaily: orgRows.map(toOrgDailyPoint),
    breakdowns: breakdownRows
      .map(toBreakdownPoint)
      .filter((point): point is BreakdownPoint => point !== null),
    adoption: adoptionRows.map(toAdoptionPoint),
  };
}

/** "Last N days" tail, or an explicit inclusive calendar window. */
export type ModelWindow = { days: number } | { from: string; to: string };

/**
 * Per-model activity aggregated over the window, busiest first.
 * Backs the per-model view.
 */
export async function listModels(window: ModelWindow): Promise<ModelUsage[]> {
  const where =
    'days' in window
      ? gte(modelDaily.date, earliestDate(window.days))
      : and(gte(modelDaily.date, window.from), lte(modelDaily.date, window.to));

  const rows = await db.select().from(modelDaily).where(where);

  const byModel = new Map<string, ModelUsage>();
  for (const row of rows as ModelDailyRow[]) {
    const acc =
      byModel.get(row.model) ??
      { model: row.model, generations: 0, acceptances: 0, locAdded: 0, locDeleted: 0, acceptanceRate: null };
    acc.generations += row.generations;
    acc.acceptances += row.acceptances;
    acc.locAdded += row.locAdded;
    acc.locDeleted += row.locDeleted;
    byModel.set(row.model, acc);
  }

  const models = [...byModel.values()];
  for (const model of models) {
    model.acceptanceRate =
      model.generations > 0 ? Math.round((model.acceptances / model.generations) * 100) : null;
  }

  return models.sort((a, b) => b.generations - a.generations);
}
