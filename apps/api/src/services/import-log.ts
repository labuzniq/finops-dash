import { randomUUID } from 'node:crypto';
import { desc } from 'drizzle-orm';
import type { ImportLogEntry, ImportLogStatus, ImportSlot } from '@dash/shared';
import { db } from '../db/client.js';
import { importLogs } from '../db/schema.js';
import type { ImportLogRow } from '../db/schema.js';
import { moduleLogger } from '../log.js';

const log = moduleLogger('services.import-log');

/**
 * The Imports page's history: one row per upload slot per run, written by the
 * import services themselves so every caller (route, script) is recorded.
 * Append-only — there is no retention policy, same as `refresh_jobs`.
 */

/** How many entries the history endpoint returns. */
const HISTORY_LIMIT = 50;

/** Shown when the caller supplied no filename — the endpoints take raw CSV. */
export const UNNAMED_FILE = 'upload.csv';

function toEntry(row: ImportLogRow): ImportLogEntry {
  return {
    id: row.id,
    slot: row.slot,
    filename: row.filename,
    rowCount: row.rowCount,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ImportOutcome {
  slot: ImportSlot;
  filename: string | undefined;
  /** Rows the run upserted; 0 on a rejected file. */
  rowCount: number;
  status: ImportLogStatus;
  error: string | null;
}

/**
 * Record one run. Never throws: the history is an audit trail, and failing to
 * write it must not turn an import that landed into an error for the client.
 */
export async function recordImport(outcome: ImportOutcome): Promise<void> {
  try {
    await db.insert(importLogs).values({
      id: randomUUID(),
      slot: outcome.slot,
      // Filename is stored, not parsed — truncated to the column width so a
      // pathological name can't reject the row the import already earned.
      filename: (outcome.filename?.trim() || UNNAMED_FILE).slice(0, 255),
      rowCount: outcome.rowCount,
      status: outcome.status,
      error: outcome.error,
    });
  } catch (error) {
    log.warn(
      { 'event.action': 'import-log', 'event.outcome': 'failure', err: error, dash: outcome },
      'could not record import history entry',
    );
  }
}

/** Recent runs, newest first. Feeds the Imports page's history list. */
export async function listImportLogs(): Promise<ImportLogEntry[]> {
  const rows = await db
    .select()
    .from(importLogs)
    .orderBy(desc(importLogs.createdAt))
    .limit(HISTORY_LIMIT);
  return rows.map(toEntry);
}
