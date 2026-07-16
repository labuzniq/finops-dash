import { inArray } from 'drizzle-orm';
import { EDITORS, PLANS } from '@dash/shared';
import type { Editor, ImportResult, Plan } from '@dash/shared';
import { db } from '../db/client.js';
import { copilotSeats } from '../db/schema.js';
import type { SeatInsert } from '../db/schema.js';

/**
 * Manual CSV / JSON / NDJSON import — the fallback path for seats or fields the
 * GitHub sync can't provide (a partner org, a correction, offline data).
 *
 * Accepted columns (case-insensitive; only `user_login` is required):
 *   user_login | login   — the seat identity (required)
 *   name                 — display name (defaults to the login)
 *   plan                 — Business | Enterprise (defaults to Business)
 *   ai_credits_used | premium_requests_28d — 28-day premium usage
 *   acceptance_rate      — percent, 0–100
 *   last_activity_at     — ISO date/timestamp
 *   editor               — VS Code | JetBrains | Visual Studio | Neovim | Xcode
 *   language             — free-form
 *   top_model | model    — e.g. claude-sonnet-5
 *   used_agent, used_chat — true/false
 *
 * A partial row only overwrites the columns it carries; omitted fields keep
 * their current value. Documented in docs/import-format.md.
 */

/** A row after parsing — only present keys are written. */
interface ParsedRow {
  login: string;
  name?: string;
  plan?: Plan;
  premiumRequests28d?: number;
  acceptanceRate?: number;
  lastActivityAt?: Date | null;
  editor?: Editor | null;
  language?: string | null;
  topModel?: string | null;
  usedAgent?: boolean;
  usedChat?: boolean;
}

const HEADER_ALIASES: Record<string, keyof ParsedRow> = {
  user_login: 'login',
  login: 'login',
  name: 'name',
  plan: 'plan',
  ai_credits_used: 'premiumRequests28d',
  premium_requests_28d: 'premiumRequests28d',
  acceptance_rate: 'acceptanceRate',
  last_activity_at: 'lastActivityAt',
  editor: 'editor',
  language: 'language',
  top_model: 'topModel',
  model: 'topModel',
  used_agent: 'usedAgent',
  used_chat: 'usedChat',
};

function parsePlan(raw: string): Plan | undefined {
  const match = PLANS.find((p) => p.toLowerCase() === raw.trim().toLowerCase());
  return match;
}

function parseEditor(raw: string): Editor | null {
  return EDITORS.find((e) => e.toLowerCase() === raw.trim().toLowerCase()) ?? null;
}

function parseBool(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(v)) return true;
  if (['false', '0', 'no', 'n'].includes(v)) return false;
  return undefined;
}

function parseNumber(raw: string): number | undefined {
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : undefined;
}

/** Turn one loosely-typed record into a ParsedRow, or throw with a reason. */
function normalise(record: Record<string, unknown>): ParsedRow {
  const get = (key: keyof ParsedRow): string | undefined => {
    for (const [header, target] of Object.entries(HEADER_ALIASES)) {
      if (target !== key) continue;
      const value = record[header];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return String(value);
      }
    }
    return undefined;
  };

  const login = get('login')?.trim();
  if (!login) throw new Error('missing user_login');

  const row: ParsedRow = { login };

  const name = get('name');
  if (name) row.name = name.trim();

  const plan = get('plan');
  if (plan) {
    const parsed = parsePlan(plan);
    if (!parsed) throw new Error(`invalid plan "${plan}"`);
    row.plan = parsed;
  }

  const credits = get('premiumRequests28d');
  if (credits !== undefined) {
    const n = parseNumber(credits);
    if (n === undefined) throw new Error(`invalid ai_credits_used "${credits}"`);
    row.premiumRequests28d = Math.round(n);
  }

  const accept = get('acceptanceRate');
  if (accept !== undefined) {
    const n = parseNumber(accept);
    if (n === undefined) throw new Error(`invalid acceptance_rate "${accept}"`);
    row.acceptanceRate = Math.round(n);
  }

  const activity = get('lastActivityAt');
  if (activity !== undefined) {
    const date = new Date(activity);
    if (Number.isNaN(date.getTime())) throw new Error(`invalid last_activity_at "${activity}"`);
    row.lastActivityAt = date;
  }

  const editor = get('editor');
  if (editor) row.editor = parseEditor(editor);

  const language = get('language');
  if (language) row.language = language.trim();

  const model = get('topModel');
  if (model) row.topModel = model.trim();

  const agent = get('usedAgent');
  const agentBool = agent !== undefined ? parseBool(agent) : undefined;
  if (agentBool !== undefined) row.usedAgent = agentBool;

  const chat = get('usedChat');
  const chatBool = chat !== undefined ? parseBool(chat) : undefined;
  if (chatBool !== undefined) row.usedChat = chatBool;

  return row;
}

// --- Format detection & parsing ---------------------------------------------

/** Parse the payload into loose records. Supports JSON array, NDJSON, and CSV. */
function parseRecords(content: string): Record<string, unknown>[] {
  const trimmed = content.trim();
  if (trimmed === '') return [];

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('JSON body must be an array of rows');
    return parsed as Record<string, unknown>[];
  }

  // NDJSON: every non-empty line is its own JSON object.
  if (trimmed.startsWith('{')) {
    return trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  return parseCsv(trimmed);
}

/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF-tolerant. */
function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];
  const headers = rows[0]!.map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((cells) => {
    const record: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      record[header] = cells[index];
    });
    return record;
  });
}

/** How many raw fields a header row carries — used to reject empty CSV lines. */
function isEmptyRecord(record: Record<string, unknown>): boolean {
  return Object.values(record).every((v) => v === undefined || String(v).trim() === '');
}

// --- Persistence ------------------------------------------------------------

/** Parse and upsert an import payload. Never throws for row-level problems. */
export async function importSeats(content: string): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, updated: 0, skipped: 0, errors: [] };

  let records: Record<string, unknown>[];
  try {
    records = parseRecords(content);
  } catch (error) {
    result.errors.push(`could not parse payload: ${(error as Error).message}`);
    return result;
  }

  const parsed: ParsedRow[] = [];
  records.forEach((record, index) => {
    if (isEmptyRecord(record)) return;
    try {
      parsed.push(normalise(record));
    } catch (error) {
      result.skipped++;
      if (result.errors.length < 20) {
        result.errors.push(`row ${index + 1}: ${(error as Error).message}`);
      }
    }
  });

  if (parsed.length === 0) return result;

  // Classify insert vs update against the current roster.
  const logins = parsed.map((r) => r.login);
  const existingRows = await db
    .select({ login: copilotSeats.login })
    .from(copilotSeats)
    .where(inArray(copilotSeats.login, logins));
  const existing = new Set(existingRows.map((r) => r.login));

  await db.transaction(async (tx) => {
    for (const row of parsed) {
      const values: SeatInsert = {
        login: row.login,
        name: row.name ?? row.login,
        plan: row.plan ?? 'Business',
        editor: row.editor,
        language: row.language,
        lastActivityAt: row.lastActivityAt,
        premiumRequests28d: row.premiumRequests28d,
        acceptanceRate: row.acceptanceRate,
        usedAgent: row.usedAgent,
        usedChat: row.usedChat,
        topModel: row.topModel,
      };

      // Only overwrite columns the row actually carried — a partial import must
      // not blank out data the sync already populated.
      const set = updatableColumns(row);

      await tx.insert(copilotSeats).values(values).onConflictDoUpdate({
        target: copilotSeats.login,
        set,
      });

      if (existing.has(row.login)) result.updated++;
      else result.imported++;
    }
  });

  return result;
}

/** The `set` clause for a conflict — only the fields present on the row. */
function updatableColumns(row: ParsedRow): Partial<SeatInsert> {
  const set: Partial<SeatInsert> = { syncedAt: new Date() };
  if (row.name !== undefined) set.name = row.name;
  if (row.plan !== undefined) set.plan = row.plan;
  if (row.editor !== undefined) set.editor = row.editor;
  if (row.language !== undefined) set.language = row.language;
  if (row.lastActivityAt !== undefined) set.lastActivityAt = row.lastActivityAt;
  if (row.premiumRequests28d !== undefined) set.premiumRequests28d = row.premiumRequests28d;
  if (row.acceptanceRate !== undefined) set.acceptanceRate = row.acceptanceRate;
  if (row.usedAgent !== undefined) set.usedAgent = row.usedAgent;
  if (row.usedChat !== undefined) set.usedChat = row.usedChat;
  if (row.topModel !== undefined) set.topModel = row.topModel;
  return set;
}
