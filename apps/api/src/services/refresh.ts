import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { PLAN_PRICE, BILLING_MONTH_DAYS, PREMIUM_WINDOW_DAYS, premiumOverage } from '@dash/shared';
import type { RefreshJob } from '@dash/shared';
import { db } from '../db/client.js';
import {
  adoptionPhaseDaily,
  copilotSeats,
  modelDaily,
  orgDaily,
  refreshJobs,
  spendDaily,
  usageBreakdownDaily,
} from '../db/schema.js';
import type { RefreshJobRow, SpendInsert } from '../db/schema.js';
import { createCopilotClient } from '../copilot/index.js';
import type { CopilotSnapshot, SeatSnapshot } from '../copilot/index.js';

/** How much history a refresh pulls — the widest range the dashboard offers. */
const SERIES_DAYS = 90;

const ACTIVE_STATUSES = ['pending', 'running'] as const;

/**
 * A refresh takes seconds; anything still "running" after this was abandoned by
 * a crashed or restarted process. Reaping it stops one dead job from wedging
 * every future refresh via the in-flight dedup below.
 */
const STALE_JOB_MS = 5 * 60_000;

function toJob(row: RefreshJobRow): RefreshJob {
  return {
    id: row.id,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    seatsSynced: row.seatsSynced,
    error: row.error,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/**
 * Derive the daily spend series. GitHub exposes no dollar billing to this org
 * (usage endpoint 404s), so money comes entirely from the cost model:
 *
 *   • License is the current roster × plan price ÷ 30. We only know today's
 *     roster, not each past day's, so license history is append-only: this value
 *     seeds days new to the series and past days keep what they already recorded
 *     (see persistSnapshot) rather than being rewritten to today's headcount.
 *   • Premium overage is the modelled 28-day total, distributed across the last
 *     28 report days in proportion to that day's code-generation activity, so
 *     the trend has real shape without inventing dollars outside the window.
 *
 * Documented in docs/github-integration.md.
 */
export function deriveSpend(
  seats: readonly SeatSnapshot[],
  org: CopilotSnapshot['orgDaily'],
): SpendInsert[] {
  if (org.length === 0) return [];

  const licenseDollarsPerDay =
    seats.reduce((total, seat) => total + PLAN_PRICE[seat.plan], 0) / BILLING_MONTH_DAYS;
  const licenseCents = toCents(licenseDollarsPerDay);

  const overageTotalCents = toCents(
    seats.reduce((total, seat) => total + premiumOverage(seat.plan, seat.premiumRequests28d), 0),
  );

  // The premium window is the newest PREMIUM_WINDOW_DAYS report days.
  const recent = [...org].sort((a, b) => b.date.localeCompare(a.date)).slice(0, PREMIUM_WINDOW_DAYS);
  const windowDates = new Set(recent.map((d) => d.date));
  const genTotal = recent.reduce((sum, d) => sum + d.generations, 0);

  return org.map((day) => {
    let premiumOverageCents = 0;
    if (windowDates.has(day.date)) {
      premiumOverageCents =
        genTotal > 0
          ? Math.round((overageTotalCents * day.generations) / genTotal)
          : Math.round(overageTotalCents / recent.length);
    }
    return { date: day.date, licenseCents, premiumOverageCents };
  });
}

/**
 * Replaces the seat table with a fresh snapshot and upserts the daily series.
 *
 * Seats are deleted-then-inserted inside a transaction: a refresh represents
 * the org as it is now, so a seat that vanished upstream must vanish here.
 * The daily tables are upserted, since past days are settled and only the most
 * recent ones move. License spend is append-only: a day already in spend_daily
 * keeps its recorded licenseCents, since we only know today's roster and must
 * not rewrite past headcount — only new days take the current derived value.
 */
export async function persistSnapshot(snapshot: CopilotSnapshot): Promise<void> {
  const { seats, orgDaily: org, modelDaily: models, breakdownDaily, adoptionDaily } = snapshot;
  const spend = deriveSpend(seats, org);

  await db.transaction(async (tx) => {
    await tx.delete(copilotSeats);

    if (seats.length > 0) {
      await tx.insert(copilotSeats).values(
        seats.map((seat) => ({
          login: seat.login,
          name: seat.name,
          plan: seat.plan,
          editor: seat.editor,
          language: seat.language,
          lastActivityAt: seat.lastActivityAt,
          premiumRequests28d: seat.premiumRequests28d,
          acceptanceRate: seat.acceptanceRate,
          usedAgent: seat.usedAgent,
          usedChat: seat.usedChat,
          topModel: seat.topModel,
          team: seat.team,
        })),
      );
    }

    for (const point of spend) {
      await tx
        .insert(spendDaily)
        .values(point)
        .onConflictDoUpdate({
          target: spendDaily.date,
          // licenseCents is deliberately not updated — see persistSnapshot doc.
          set: { premiumOverageCents: point.premiumOverageCents },
        });
    }

    for (const day of org) {
      await tx
        .insert(orgDaily)
        .values(day)
        .onConflictDoUpdate({
          target: orgDaily.date,
          set: {
            dailyActiveUsers: day.dailyActiveUsers,
            weeklyActiveUsers: day.weeklyActiveUsers,
            monthlyActiveUsers: day.monthlyActiveUsers,
            interactions: day.interactions,
            generations: day.generations,
            acceptances: day.acceptances,
            locAdded: day.locAdded,
            locDeleted: day.locDeleted,
            locSuggestedAdd: day.locSuggestedAdd,
            locSuggestedDelete: day.locSuggestedDelete,
            chatMau: day.chatMau,
            agentMau: day.agentMau,
            codeReviewDau: day.codeReviewDau,
            codeReviewWau: day.codeReviewWau,
            codeReviewMau: day.codeReviewMau,
            codeReviewPassiveMau: day.codeReviewPassiveMau,
            cloudAgentDau: day.cloudAgentDau,
            cloudAgentWau: day.cloudAgentWau,
            cloudAgentMau: day.cloudAgentMau,
            prCreated: day.prCreated,
            prMerged: day.prMerged,
            prCreatedByCopilot: day.prCreatedByCopilot,
            prMergedCreatedByCopilot: day.prMergedCreatedByCopilot,
            prReviewedByCopilot: day.prReviewedByCopilot,
            prCopilotSuggestions: day.prCopilotSuggestions,
            prCopilotAppliedSuggestions: day.prCopilotAppliedSuggestions,
            syncedAt: new Date(),
          },
        });
    }

    // Breakdown and adoption rows are replaced per day, not table-wide — the key
    // set for a day can shrink between refreshes (a model or phase vanishing),
    // so each fetched day is fully deleted then reinserted to clear stale keys.
    // Days the fetch returned nothing for keep their previously stored rows,
    // so a report outage can't erase history the way a wholesale delete would.
    const breakdownDates = [...new Set(breakdownDaily.map((row) => row.date))];
    if (breakdownDates.length > 0) {
      await tx.delete(usageBreakdownDaily).where(inArray(usageBreakdownDaily.date, breakdownDates));
      await tx.insert(usageBreakdownDaily).values(breakdownDaily);
    }

    const adoptionDates = [...new Set(adoptionDaily.map((row) => row.date))];
    if (adoptionDates.length > 0) {
      await tx.delete(adoptionPhaseDaily).where(inArray(adoptionPhaseDaily.date, adoptionDates));
      await tx.insert(adoptionPhaseDaily).values(adoptionDaily);
    }

    for (const row of models) {
      await tx
        .insert(modelDaily)
        .values(row)
        .onConflictDoUpdate({
          target: [modelDaily.date, modelDaily.model],
          set: {
            generations: row.generations,
            acceptances: row.acceptances,
            locAdded: row.locAdded,
            locDeleted: row.locDeleted,
            syncedAt: new Date(),
          },
        });
    }
  });
}

/** Runs the sync and records the outcome on the job row. Never throws. */
async function run(jobId: string): Promise<void> {
  const client = createCopilotClient();

  try {
    await db.update(refreshJobs).set({ status: 'running' }).where(eq(refreshJobs.id, jobId));

    const snapshot = await client.fetchSnapshot(SERIES_DAYS);
    await persistSnapshot(snapshot);

    await db
      .update(refreshJobs)
      .set({ status: 'succeeded', finishedAt: new Date(), seatsSynced: snapshot.seats.length })
      .where(eq(refreshJobs.id, jobId));
  } catch (error) {
    await db
      .update(refreshJobs)
      .set({ status: 'failed', finishedAt: new Date(), error: errorMessage(error) })
      .where(eq(refreshJobs.id, jobId));
  }
}

/**
 * Starts a refresh and returns immediately with the job to poll.
 *
 * If one is already in flight its job is returned instead, so a double-click
 * on "Refresh" cannot start two concurrent syncs of the same table.
 */
export async function startRefresh(): Promise<RefreshJob> {
  // Fail any job left running past the stale threshold before we dedup, so a
  // crashed process can't block refreshes indefinitely.
  await db
    .update(refreshJobs)
    .set({ status: 'failed', finishedAt: new Date(), error: 'abandoned (stale)' })
    .where(
      and(
        inArray(refreshJobs.status, [...ACTIVE_STATUSES]),
        lt(refreshJobs.startedAt, new Date(Date.now() - STALE_JOB_MS)),
      ),
    );

  const [inFlight] = await db
    .select()
    .from(refreshJobs)
    .where(inArray(refreshJobs.status, [...ACTIVE_STATUSES]))
    .orderBy(desc(refreshJobs.startedAt))
    .limit(1);

  if (inFlight) return toJob(inFlight);

  const [job] = await db.insert(refreshJobs).values({ id: randomUUID() }).returning();
  if (!job) throw new Error('failed to create refresh job');

  // Deliberately not awaited — the request returns 202 while this runs.
  void run(job.id);

  return toJob(job);
}

export async function getRefreshJob(id: string): Promise<RefreshJob | null> {
  const [row] = await db.select().from(refreshJobs).where(eq(refreshJobs.id, id)).limit(1);
  return row ? toJob(row) : null;
}

/** The most recent job, whatever its state — drives the "synced 2h ago" note. */
export async function getLatestRefreshJob(): Promise<RefreshJob | null> {
  const [row] = await db.select().from(refreshJobs).orderBy(desc(refreshJobs.startedAt)).limit(1);
  return row ? toJob(row) : null;
}
