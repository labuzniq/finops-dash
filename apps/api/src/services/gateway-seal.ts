import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { GATEWAY_PAYER_DIMENSIONS, diffSeals, resolveMonthSeal } from '@dash/shared';
import type {
  GatewayPayerDimension,
  GatewaySeal,
  GatewaySealCheck,
  GatewaySealHistory,
  GatewaySealLine,
  GatewaySealOrigin,
  GatewaySealRevisionDiff,
  GatewaySealedMonth,
} from '@dash/shared';
import { db } from '../db/client.js';
import { gatewayBreakdownDaily, gatewayDaily, gatewayMonth, gatewayMonthLine } from '../db/schema.js';
import type {
  GatewayMonthInsert,
  GatewayMonthLineInsert,
  GatewayMonthLineRow,
  GatewayMonthRow,
} from '../db/schema.js';
import { moduleLogger } from '../log.js';
import { nanoToDollars } from '../lib/nano.js';

const log = moduleLogger('services.gateway-seal');

/**
 * Month seals — the one place the gateway stops deriving and starts recording.
 *
 * Everything else under `services/gateway.ts` answers "what do the daily rows
 * say right now", which is the correct answer for every card on the page and
 * the wrong one for a bill. `gateway_daily` is rewritten by every sync that
 * touches a day: LiteLLM revises late-landing usage, a backfill repairs a gap,
 * and the aggregate a statement was cut from can move under it weeks later. A
 * seal takes the month once, when it can no longer legitimately change, and
 * keeps it.
 *
 * Two rules make that worth having rather than merely duplicative:
 *
 * - **A seal is taken exactly once.** The nightly sync seals whatever closed
 *   month is newly complete; nothing re-seals implicitly. Re-sealing is a
 *   separate, explicit request, because a statement that quietly agrees with
 *   the daily rows again has destroyed the only evidence that they moved.
 * - **A re-seal adds a revision, it does not overwrite one.** Every statement
 *   the month has ever carried stays in `gateway_month`, the replaced ones
 *   stamped with `superseded_at`, because a corrected bill is only auditable
 *   next to the bill it corrected — "we invoiced this, then this" is the whole
 *   question a revision raises, and an overwrite answers it with silence.
 * - **A seal is never read *instead of* the daily rows.** The chargeback card
 *   still derives its statement from `GET /api/gateway`; the seal is what it is
 *   compared against. That keeps one derivation on screen and turns the seal
 *   into an audit trail rather than a second, divergent source of truth.
 */

/** Rows per insert — well under the parameter cap at 13 columns each. */
const CHUNK_SIZE = 2_000;

export type GatewaySealErrorCode = 'invalid_month' | 'in_flight' | 'incomplete' | 'empty' | 'sealed';

/** A seal was asked for and refused, with the reason a caller can act on. */
export class GatewaySealError extends Error {
  constructor(
    message: string,
    readonly code: GatewaySealErrorCode,
  ) {
    super(message);
  }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function toSeal(row: GatewayMonthRow): GatewaySeal {
  return {
    month: row.month,
    monthStart: row.monthStart,
    monthEnd: row.monthEnd,
    days: row.days,
    sealedAt: row.sealedAt.toISOString(),
    revision: row.revision,
    supersededAt: row.supersededAt === null ? null : row.supersededAt.toISOString(),
    // The column is a varchar rather than an enum (one fewer migration-time
    // type to keep in step with @dash/shared); anything the service did not
    // write reads as a manual seal, which is the conservative label.
    sealedBy: row.sealedBy === 'scheduler' ? 'scheduler' : 'manual',
    total: {
      spend: nanoToDollars(row.spendNano),
      requests: row.requests,
      successfulRequests: row.successfulRequests,
      failedRequests: row.failedRequests,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.totalTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheCreationTokens: row.cacheCreationTokens,
    },
  };
}

function toLine(row: GatewayMonthLineRow): GatewaySealLine | null {
  const dimension = GATEWAY_PAYER_DIMENSIONS.find(
    (candidate): candidate is GatewayPayerDimension => candidate === row.dimension,
  );
  if (dimension === undefined) return null;
  return {
    dimension,
    key: row.key,
    label: row.label,
    spend: nanoToDollars(row.spendNano),
    requests: row.requests,
    successfulRequests: row.successfulRequests,
    failedRequests: row.failedRequests,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheCreationTokens,
  };
}

/**
 * Every sealed month, newest first — the *current* statement of each.
 *
 * Superseded revisions are deliberately not in this list: it answers "what is
 * the bill for each month", and a month has one of those at a time. The
 * statements it replaced are one route down, under the month's history.
 */
export async function listGatewaySeals(): Promise<GatewaySeal[]> {
  const rows = await db
    .select()
    .from(gatewayMonth)
    .where(isNull(gatewayMonth.supersededAt))
    .orderBy(desc(gatewayMonth.month));
  return rows.map(toSeal);
}

/**
 * One sealed month with its lines, or null when the month was never sealed.
 *
 * `revision` quotes an *older* statement — the one a recipient is holding —
 * rather than the current bill. Omitted, it answers with the current one.
 */
export async function getGatewaySeal(
  month: string,
  revision?: number,
): Promise<GatewaySealedMonth | null> {
  if (!MONTH_RE.test(month)) {
    throw new GatewaySealError(`"${month}" is not a month — expected YYYY-MM`, 'invalid_month');
  }

  const [header] = await db
    .select()
    .from(gatewayMonth)
    .where(
      revision === undefined
        ? and(eq(gatewayMonth.month, month), isNull(gatewayMonth.supersededAt))
        : and(eq(gatewayMonth.month, month), eq(gatewayMonth.revision, revision)),
    );
  if (header === undefined) return null;

  const lineRows = await db
    .select()
    .from(gatewayMonthLine)
    .where(
      and(eq(gatewayMonthLine.month, month), eq(gatewayMonthLine.revision, header.revision)),
    )
    .orderBy(asc(gatewayMonthLine.dimension), desc(gatewayMonthLine.spendNano));

  const lines: GatewaySealLine[] = [];
  for (const row of lineRows) {
    const line = toLine(row);
    if (line !== null) lines.push(line);
  }

  return { ...toSeal(header), lines };
}

/**
 * Every revision of one month, newest first, with what each re-seal changed.
 *
 * The diffs are computed here rather than stored, and they are pure: both
 * sides are recorded statements, so unlike `sealDrift` — which compares a seal
 * against daily rows that move — this answer cannot change once the two
 * revisions exist. Storing it would only be a second copy of a subtraction.
 *
 * Returns null for a month that was never sealed, which is the same absence
 * `getGatewaySeal` reports; a month sealed once returns its single revision
 * and no diffs.
 */
export async function getGatewaySealHistory(month: string): Promise<GatewaySealHistory | null> {
  if (!MONTH_RE.test(month)) {
    throw new GatewaySealError(`"${month}" is not a month — expected YYYY-MM`, 'invalid_month');
  }

  const headers = await db
    .select()
    .from(gatewayMonth)
    .where(eq(gatewayMonth.month, month))
    .orderBy(desc(gatewayMonth.revision));
  if (headers.length === 0) return null;

  const lineRows = await db
    .select()
    .from(gatewayMonthLine)
    .where(eq(gatewayMonthLine.month, month))
    .orderBy(asc(gatewayMonthLine.dimension), desc(gatewayMonthLine.spendNano));

  const linesByRevision = new Map<number, GatewaySealLine[]>();
  for (const row of lineRows) {
    const line = toLine(row);
    if (line === null) continue;
    const bucket = linesByRevision.get(row.revision);
    if (bucket === undefined) linesByRevision.set(row.revision, [line]);
    else bucket.push(line);
  }

  const sealed: GatewaySealedMonth[] = headers.map((header) => ({
    ...toSeal(header),
    lines: linesByRevision.get(header.revision) ?? [],
  }));

  // Newest first, so each pair is (this revision, the one it replaced).
  const diffs: GatewaySealRevisionDiff[] = [];
  for (let index = 0; index + 1 < sealed.length; index += 1) {
    const current = sealed[index];
    const previous = sealed[index + 1];
    if (current === undefined || previous === undefined) continue;
    diffs.push(diffSeals(previous, current));
  }

  return { month, revisions: sealed.map(({ lines: _lines, ...seal }) => seal), diffs };
}

/**
 * Whether a month is ready to be sealed, read against the table as it stands.
 *
 * Exposed on its own because the refusal is the useful part: an `incomplete`
 * month names the days that are missing, which is exactly the range
 * `POST /api/refresh/gateway?from=&to=` takes.
 */
export async function checkMonthSeal(month: string): Promise<GatewaySealCheck> {
  if (!MONTH_RE.test(month)) {
    throw new GatewaySealError(`"${month}" is not a month — expected YYYY-MM`, 'invalid_month');
  }
  const monthEnd = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
  )
    .toISOString()
    .slice(0, 10);

  const rows = await db
    .select({ date: gatewayDaily.date })
    .from(gatewayDaily)
    .where(and(gte(gatewayDaily.date, `${month}-01`), lte(gatewayDaily.date, monthEnd)))
    .orderBy(asc(gatewayDaily.date));

  return resolveMonthSeal(
    month,
    rows.map((row) => row.date),
    todayIso(),
  );
}

/**
 * Seal one closed month.
 *
 * The aggregation runs in JS rather than in SQL on purpose: a month is at most
 * 31 daily rows and a few thousand breakdown rows, and summing money as
 * `bigint` here keeps the seal in the exact nano representation the daily rows
 * hold. A `sum()` over a bigint column comes back through the driver as a
 * string and would have to be re-parsed anyway.
 *
 * `force` re-seals a month that already carries one. It is never taken
 * implicitly — see the module note: the whole value of a seal is that it can
 * disagree with the daily rows.
 */
export async function sealGatewayMonth(
  month: string,
  options: { force?: boolean; sealedBy?: GatewaySealOrigin } = {},
): Promise<GatewaySealedMonth> {
  const check = await checkMonthSeal(month);
  if (!check.sealable) {
    // `blocker` is non-null whenever `sealable` is false; the fallback keeps
    // the narrow honest without a non-null assertion.
    throw new GatewaySealError(check.reason ?? `${month} cannot be sealed`, check.blocker ?? 'empty');
  }

  const existing = await db
    .select({
      month: gatewayMonth.month,
      revision: gatewayMonth.revision,
      sealedAt: gatewayMonth.sealedAt,
    })
    .from(gatewayMonth)
    .where(and(eq(gatewayMonth.month, month), isNull(gatewayMonth.supersededAt)));
  const priorSeal = existing[0];
  if (priorSeal !== undefined && options.force !== true) {
    throw new GatewaySealError(
      `${month} was already sealed at ${priorSeal.sealedAt.toISOString()} (revision ${priorSeal.revision}) — re-sealing issues a new revision beside the statement already sent out`,
      'sealed',
    );
  }
  // The next revision counts every statement this month has ever carried, not
  // just the current one, so a number can never be re-used: a recipient
  // quoting "June revision 2" must always mean the same document.
  const [highest] = await db
    .select({ revision: sql<number>`coalesce(max(${gatewayMonth.revision}), 0)` })
    .from(gatewayMonth)
    .where(eq(gatewayMonth.month, month));
  const revision = Number(highest?.revision ?? 0) + 1;

  const sealedBy: GatewaySealOrigin = options.sealedBy ?? 'manual';
  const [days, breakdownRows] = await Promise.all([
    db
      .select()
      .from(gatewayDaily)
      .where(
        and(gte(gatewayDaily.date, check.monthStart), lte(gatewayDaily.date, check.monthEnd)),
      ),
    db
      .select()
      .from(gatewayBreakdownDaily)
      .where(
        and(
          gte(gatewayBreakdownDaily.date, check.monthStart),
          lte(gatewayBreakdownDaily.date, check.monthEnd),
          inArray(gatewayBreakdownDaily.dimension, [...GATEWAY_PAYER_DIMENSIONS]),
        ),
      ),
  ]);

  const header: GatewayMonthInsert = {
    month,
    revision,
    supersededAt: null,
    monthStart: check.monthStart,
    monthEnd: check.monthEnd,
    days: days.length,
    sealedAt: new Date(),
    sealedBy,
    spendNano: days.reduce((sum, day) => sum + day.spendNano, 0n),
    requests: days.reduce((sum, day) => sum + day.requests, 0),
    successfulRequests: days.reduce((sum, day) => sum + day.successfulRequests, 0),
    failedRequests: days.reduce((sum, day) => sum + day.failedRequests, 0),
    promptTokens: days.reduce((sum, day) => sum + day.promptTokens, 0),
    completionTokens: days.reduce((sum, day) => sum + day.completionTokens, 0),
    totalTokens: days.reduce((sum, day) => sum + day.totalTokens, 0),
    cacheReadTokens: days.reduce((sum, day) => sum + day.cacheReadTokens, 0),
    cacheCreationTokens: days.reduce((sum, day) => sum + day.cacheCreationTokens, 0),
  };

  const buckets = new Map<string, GatewayMonthLineInsert>();
  for (const row of breakdownRows) {
    const id = `${row.dimension} ${row.key}`;
    const bucket = buckets.get(id);
    if (bucket === undefined) {
      buckets.set(id, {
        month,
        revision,
        dimension: row.dimension,
        key: row.key,
        label: row.label,
        spendNano: row.spendNano,
        requests: row.requests,
        successfulRequests: row.successfulRequests,
        failedRequests: row.failedRequests,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheCreationTokens: row.cacheCreationTokens,
      });
      continue;
    }
    bucket.spendNano += row.spendNano;
    bucket.requests += row.requests;
    bucket.successfulRequests += row.successfulRequests;
    bucket.failedRequests += row.failedRequests;
    bucket.promptTokens += row.promptTokens;
    bucket.completionTokens += row.completionTokens;
    bucket.totalTokens += row.totalTokens;
    bucket.cacheReadTokens += row.cacheReadTokens;
    bucket.cacheCreationTokens += row.cacheCreationTokens;
    // A key's alias can be resolved on some days and not others; the first
    // non-null one wins, the same rule the chargeback derivation applies.
    if (bucket.label === null || bucket.label === undefined) bucket.label = row.label;
  }
  const lines = [...buckets.values()];

  // Supersede-then-insert inside one transaction, scoped to this month: the
  // statement that was already issued is kept, marked as replaced, and the new
  // revision goes in beside it. Nothing is deleted and no other month is
  // touched — the partial unique index is what guarantees exactly one of the
  // month's revisions is left current.
  const supersededAt = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(gatewayMonth)
      .set({ supersededAt })
      .where(and(eq(gatewayMonth.month, month), isNull(gatewayMonth.supersededAt)));
    await tx.insert(gatewayMonth).values(header);
    for (const rows of chunk(lines, CHUNK_SIZE)) {
      await tx.insert(gatewayMonthLine).values(rows);
    }
  });

  log.info(
    {
      'event.action': 'gateway-month-sealed',
      dash: {
        month,
        revision,
        days: header.days,
        lines: lines.length,
        sealedBy,
        resealed: priorSeal !== undefined,
      },
    },
    'gateway month sealed',
  );

  const sealed = await getGatewaySeal(month);
  if (sealed === null) throw new Error(`seal for ${month} vanished immediately after writing`);
  return sealed;
}

/**
 * Seal every closed month the table now covers in full and has not sealed yet.
 *
 * Called at the end of a full gateway sync, which is the moment the answer can
 * change: the sync that stores the last day of a month is the one that makes it
 * sealable. Never re-seals — a month that already carries a seal is skipped
 * even if the daily rows have since moved, because that divergence is precisely
 * what the seal exists to record.
 *
 * Failures are returned rather than thrown: a seal is a bookkeeping step after
 * the data has already landed, and failing the sync over it would leave the
 * usage unsynced tomorrow too.
 */
export async function sealClosedMonths(
  sealedBy: GatewaySealOrigin = 'scheduler',
): Promise<{ sealed: string[]; skipped: Array<{ month: string; reason: string }> }> {
  const [firstRow] = await db
    .select({ date: gatewayDaily.date })
    .from(gatewayDaily)
    .orderBy(asc(gatewayDaily.date))
    .limit(1);
  if (firstRow === undefined) return { sealed: [], skipped: [] };

  const sealedRows = await db.select({ month: gatewayMonth.month }).from(gatewayMonth);
  const alreadySealed = new Set(sealedRows.map((row) => row.month));

  const today = todayIso();
  const sealed: string[] = [];
  const skipped: Array<{ month: string; reason: string }> = [];

  for (
    let month = firstRow.date.slice(0, 7);
    `${month}-01` < today;
    month = nextMonth(month)
  ) {
    if (alreadySealed.has(month)) continue;
    const check = await checkMonthSeal(month);
    if (!check.sealable) {
      if (check.blocker !== 'in_flight' && check.reason !== null) {
        skipped.push({ month, reason: check.reason });
      }
      continue;
    }
    try {
      await sealGatewayMonth(month, { sealedBy });
      sealed.push(month);
    } catch (error) {
      skipped.push({ month, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  if (sealed.length > 0 || skipped.length > 0) {
    log.info({ dash: { sealed, skipped } }, 'closed months reviewed for sealing');
  }
  return { sealed, skipped };
}

/** `2026-12` → `2027-01`. */
function nextMonth(month: string): string {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1))
    .toISOString()
    .slice(0, 7);
}
