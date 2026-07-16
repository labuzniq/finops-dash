import { asc, gte } from 'drizzle-orm';
import { EDITORS } from '@dash/shared';
import type { CopilotSeat, Editor, ModelUsage, SpendPoint } from '@dash/shared';
import { db } from '../db/client.js';
import { copilotSeats, modelDaily, spendDaily } from '../db/schema.js';
import type { ModelDailyRow, SeatRow, SpendRow } from '../db/schema.js';

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

/**
 * Per-model activity aggregated over the last `days` days, busiest first.
 * Backs the per-model view.
 */
export async function listModels(days: number): Promise<ModelUsage[]> {
  const rows = await db
    .select()
    .from(modelDaily)
    .where(gte(modelDaily.date, earliestDate(days)));

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
