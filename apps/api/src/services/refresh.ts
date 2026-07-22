import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { RefreshJob, RefreshKind } from '@dash/shared';
import { db } from '../db/client.js';
import {
  adoptionPhaseDaily,
  copilotSeats,
  modelDaily,
  orgDaily,
  refreshJobs,
  usageBreakdownDaily,
  userDaily,
} from '../db/schema.js';
import type { RefreshJobRow } from '../db/schema.js';
import { createCopilotClient } from '../copilot/index.js';
import type { CopilotSnapshot } from '../copilot/index.js';
import { eventDuration, moduleLogger } from '../log.js';

const log = moduleLogger('services.refresh');

/** How much history a refresh pulls — the widest range the dashboard offers. */
const SERIES_DAYS = 90;

const ACTIVE_STATUSES = ['pending', 'running'] as const;

/**
 * A refresh takes seconds; anything still "running" after this was abandoned by
 * a crashed or restarted process. Reaping it stops one dead job from wedging
 * every future refresh via the in-flight dedup below.
 */
const STALE_JOB_MS = 5 * 60_000;

export function toJob(row: RefreshJobRow): RefreshJob {
  return {
    id: row.id,
    kind: row.kind,
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

/** Postgres unique-violation SQLSTATE — the single-flight index rejecting a duplicate. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

/** `excluded.<col>` — the value the failed insert would have written. */
function incoming(col: AnyPgColumn) {
  return sql`excluded.${sql.identifier(col.name)}`;
}

/**
 * `coalesce(excluded.<col>, <col>)` — take the incoming value only when it is
 * non-null, otherwise keep what's already stored. GitHub leaves these metrics
 * null on live orgs; a CSV import may have enriched them, and a sync must not
 * blank that back out.
 */
function keepIfNull(col: AnyPgColumn) {
  return sql`coalesce(${incoming(col)}, ${col})`;
}

/**
 * Reconciles the seat table with a fresh snapshot and upserts the daily series.
 *
 * Seats are upserted by login inside a transaction, then any login missing from
 * the snapshot is deleted: a refresh represents the org as it is now, so a seat
 * that vanished upstream must vanish here. On conflict the GitHub-authoritative
 * columns (name, plan, lastActivityAt, team) always overwrite, but the nullable
 * metric columns only overwrite when the incoming value is non-null — so
 * CSV-imported enrichment survives a sync that reports those metrics as null.
 * The daily tables are upserted, since past days are settled and only the most
 * recent ones move. Spend is not derived here — real money comes from the
 * billing report import (billing_daily), never from seat data.
 */
export async function persistSnapshot(snapshot: CopilotSnapshot): Promise<void> {
  const {
    seats,
    orgDaily: org,
    modelDaily: models,
    breakdownDaily,
    adoptionDaily,
    userDaily: userRows,
  } = snapshot;

  log.debug(
    {
      dash: {
        seats: seats.length,
        orgDays: org.length,
        modelRows: models.length,
        breakdownRows: breakdownDaily.length,
        adoptionRows: adoptionDaily.length,
        userDailyRows: userRows.length,
      },
    },
    'persisting snapshot',
  );

  await db.transaction(async (tx) => {
    if (seats.length > 0) {
      await tx
        .insert(copilotSeats)
        .values(
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
        )
        .onConflictDoUpdate({
          target: copilotSeats.login,
          set: {
            name: incoming(copilotSeats.name),
            plan: incoming(copilotSeats.plan),
            lastActivityAt: incoming(copilotSeats.lastActivityAt),
            team: incoming(copilotSeats.team),
            editor: keepIfNull(copilotSeats.editor),
            language: keepIfNull(copilotSeats.language),
            premiumRequests28d: keepIfNull(copilotSeats.premiumRequests28d),
            acceptanceRate: keepIfNull(copilotSeats.acceptanceRate),
            usedAgent: keepIfNull(copilotSeats.usedAgent),
            usedChat: keepIfNull(copilotSeats.usedChat),
            topModel: keepIfNull(copilotSeats.topModel),
            syncedAt: new Date(),
          },
        });
    }

    // Anything not in this snapshot has vanished upstream — an empty snapshot
    // clears the table (notInArray of an empty set matches every row).
    await tx.delete(copilotSeats).where(
      notInArray(
        copilotSeats.login,
        seats.map((seat) => seat.login),
      ),
    );

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

    // user_daily gets the per-day replacement treatment too, plus a purge of
    // logins that vanished from the roster (the seat delete above has no FK
    // here). Inserts are chunked: at ~1,000 seats a 90-day snapshot is tens of
    // thousands of rows, and one INSERT would blow Postgres's 65,535-parameter
    // cap.
    const userDates = [...new Set(userRows.map((row) => row.date))];
    if (userDates.length > 0) {
      await tx.delete(userDaily).where(inArray(userDaily.date, userDates));
      const CHUNK = 5_000;
      for (let i = 0; i < userRows.length; i += CHUNK) {
        await tx.insert(userDaily).values(userRows.slice(i, i + CHUNK));
      }
    }
    await tx.delete(userDaily).where(
      notInArray(
        userDaily.login,
        seats.map((seat) => seat.login),
      ),
    );

    // model_daily gets the same per-day replacement treatment: the set of models
    // reported for a day can shrink or re-bucket between refreshes, and a stale
    // (date, model) key would linger under an upsert and double-count in
    // listModels. Replace only the days this refresh fetched — leave the rest.
    if (models.length > 0) {
      const modelDates = [...new Set(models.map((row) => row.date))];
      await tx.delete(modelDaily).where(inArray(modelDaily.date, modelDates));
      await tx.insert(modelDaily).values(models);
    }
  });

  log.debug('snapshot persisted');
}

/** What one job runs: an ECS action name plus the work, returning a synced count. */
export interface JobRunner {
  /** ECS `event.action`, e.g. `copilot-refresh` / `jira-sync`. */
  action: string;
  /** Extra `dash.*` context for the job's log lines. */
  context?: Record<string, unknown>;
  /** Does the sync; the count lands in the job row's `seats_synced` column. */
  run(): Promise<number>;
}

/** Wraps the runner with status transitions and outcome logging. Never throws. */
async function runJob(jobId: string, runner: JobRunner): Promise<void> {
  const startedAt = Date.now();
  // Everything about the job rides in one `dash` object per line — pino does
  // not merge duplicate keys between child bindings and call payloads.
  const job = { jobId, ...runner.context };
  const jobLog = log.child({ 'event.action': runner.action });

  try {
    await db.update(refreshJobs).set({ status: 'running' }).where(eq(refreshJobs.id, jobId));
    jobLog.info({ dash: job }, 'refresh job running');

    const synced = await runner.run();

    await db
      .update(refreshJobs)
      .set({ status: 'succeeded', finishedAt: new Date(), seatsSynced: synced })
      .where(eq(refreshJobs.id, jobId));
    jobLog.info(
      {
        'event.outcome': 'success',
        'event.duration': eventDuration(startedAt),
        dash: { ...job, synced },
      },
      'refresh job succeeded',
    );
  } catch (error) {
    await db
      .update(refreshJobs)
      .set({ status: 'failed', finishedAt: new Date(), error: errorMessage(error) })
      .where(eq(refreshJobs.id, jobId));
    jobLog.error(
      {
        'event.outcome': 'failure',
        'event.duration': eventDuration(startedAt),
        err: error,
        dash: job,
      },
      'refresh job failed',
    );
  }
}

/** Active jobs of one kind — reap, dedup, and the loser's re-select all use this. */
function activeOfKind(kind: RefreshKind) {
  return and(eq(refreshJobs.kind, kind), inArray(refreshJobs.status, [...ACTIVE_STATUSES]));
}

/**
 * Starts a job of the given kind and returns immediately with the row to poll.
 *
 * If one of the same kind is already in flight its job is returned instead, so
 * a double-click on "Refresh" cannot start two concurrent syncs of the same
 * tables — while a Copilot refresh and a JIRA sync run side by side freely.
 * Single-flight is enforced by a partial unique index on `refresh_jobs` (one
 * active row per kind), so two concurrent callers race safely: the loser's
 * insert hits the index and is answered with the winner's in-flight job.
 */
export async function startJob(kind: RefreshKind, runner: JobRunner): Promise<RefreshJob> {
  // Fail any job of this kind left running past the stale threshold before we
  // dedup, so a crashed process can't block future syncs indefinitely.
  const reaped = await db
    .update(refreshJobs)
    .set({ status: 'failed', finishedAt: new Date(), error: 'abandoned (stale)' })
    .where(and(activeOfKind(kind), lt(refreshJobs.startedAt, new Date(Date.now() - STALE_JOB_MS))))
    .returning({ id: refreshJobs.id });
  if (reaped.length > 0) {
    log.warn(
      { dash: { kind, jobIds: reaped.map((row) => row.id) } },
      'reaped stale refresh jobs left behind by a dead process',
    );
  }

  const [existing] = await db
    .select()
    .from(refreshJobs)
    .where(activeOfKind(kind))
    .orderBy(desc(refreshJobs.startedAt))
    .limit(1);

  if (existing) {
    log.debug(
      { dash: { kind, jobId: existing.id } },
      'refresh already in flight — returning existing job',
    );
    return toJob(existing);
  }

  let job: RefreshJobRow | undefined;
  try {
    [job] = await db.insert(refreshJobs).values({ id: randomUUID(), kind }).returning();
  } catch (error) {
    // Lost the race to the single-flight index: another caller's job of this
    // kind is now active. Return it rather than surfacing the violation.
    if (isUniqueViolation(error)) {
      log.debug({ dash: { kind } }, 'lost the single-flight race — returning the winning job');
      const [inFlight] = await db
        .select()
        .from(refreshJobs)
        .where(activeOfKind(kind))
        .orderBy(desc(refreshJobs.startedAt))
        .limit(1);
      if (inFlight) return toJob(inFlight);
    }
    throw error;
  }
  if (!job) throw new Error('failed to create refresh job');

  log.info({ 'event.action': runner.action, dash: { kind, jobId: job.id } }, 'refresh job created');

  // Deliberately not awaited — the request returns 202 while this runs.
  void runJob(job.id, runner);

  return toJob(job);
}

/** Starts a Copilot refresh (kind `copilot`) and returns the job to poll. */
export async function startRefresh(): Promise<RefreshJob> {
  const client = createCopilotClient();
  return startJob('copilot', {
    action: 'copilot-refresh',
    context: { copilotSource: client.name, historyDays: SERIES_DAYS },
    run: async () => {
      const snapshot = await client.fetchSnapshot(SERIES_DAYS);
      await persistSnapshot(snapshot);
      return snapshot.seats.length;
    },
  });
}

export async function getRefreshJob(id: string): Promise<RefreshJob | null> {
  const [row] = await db.select().from(refreshJobs).where(eq(refreshJobs.id, id)).limit(1);
  return row ? toJob(row) : null;
}

/**
 * The most recent job of one kind, whatever its state — drives the header's
 * "synced 2h ago" note (`copilot`) and the JIRA sync status.
 */
export async function getLatestRefreshJob(kind: RefreshKind = 'copilot'): Promise<RefreshJob | null> {
  const [row] = await db
    .select()
    .from(refreshJobs)
    .where(eq(refreshJobs.kind, kind))
    .orderBy(desc(refreshJobs.startedAt))
    .limit(1);
  return row ? toJob(row) : null;
}
