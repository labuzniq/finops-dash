import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import { AI_CREDIT_SKU, BILLING_SKUS } from '@dash/shared';
import type { BillingImportResult, BillingSku, ImportSlot } from '@dash/shared';
import { db } from '../db/client.js';
import { billingDaily, githubUsers, modelSpendDaily } from '../db/schema.js';
import type { BillingDailyInsert, GithubUserInsert, ModelSpendDailyInsert } from '../db/schema.js';
import { parseCsvRows, stripBom } from '../lib/csv.js';
import type { CsvRow } from '../lib/csv.js';
import { parseNano } from '../lib/nano.js';
import { eventDuration, moduleLogger } from '../log.js';
import { recordImport } from './import-log.js';

const log = moduleLogger('services.billing-import');

/**
 * Billing report CSV import (spec §Import pipeline).
 *
 * Report 1 (`AIUsageReport_1.csv`, has a `model` column) → `model_spend_daily`,
 * per-model AI-credit statistics — never summed into money totals. Only
 * `copilot_ai_credit` rows land; other skus (request counts, not credits) are
 * skipped and counted, never merged.
 * Report 2 (`AIUsageReport_2.csv`, has a `workflow_path` column) →
 * `billing_daily`, the sole money authority, licences included.
 *
 * Money is parsed to bigint nano-dollars via string arithmetic (lib/nano.ts).
 * A file is all-or-nothing: any malformed row or unknown sku rejects the whole
 * upload with a 400 naming the line, and nothing is imported.
 */

/** Report 1 = `model`, Report 2 = `billing`. */
export type BillingReportType = BillingImportResult['reportType'];

/** A rejected upload — the route maps this to a 400 with the message. */
export class CsvImportError extends Error {}

// --- Pure parsing (no DB) ----------------------------------------------------

/** Parsed + aggregated report, before persistence. */
export interface ParsedBillingReport {
  reportType: BillingReportType;
  /** Populated when reportType === 'billing', keyed-unique by (date, login, sku). */
  billingRows: BillingDailyInsert[];
  /** Populated when reportType === 'model', keyed-unique by (date, login, model). */
  modelRows: ModelSpendDailyInsert[];
  dateRange: { from: string; to: string };
  /** Distinct logins appearing in the file. */
  logins: string[];
  /**
   * Report 1 rows skipped because their sku is not `copilot_ai_credit` —
   * `copilot_premium_request` quantities are request counts, not credits, and
   * must never sum into the credit statistics. Always 0 for Report 2.
   */
  skippedNonCreditRows: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Aggregation-key separator — NUL never appears in dates, logins, or models. */
const KEY_SEP = '\u0000';

/** Header → cell index map, lowercased. Throws when a required column is missing. */
function headerIndex(header: CsvRow, required: string[]): Map<string, number> {
  const map = new Map<string, number>();
  header.cells.forEach((cell, i) => map.set(cell.trim().toLowerCase(), i));
  for (const column of required) {
    if (!map.has(column)) throw new CsvImportError(`missing required column "${column}"`);
  }
  return map;
}

function cellAt(row: CsvRow, index: number | undefined): string {
  return index === undefined ? '' : (row.cells[index] ?? '');
}

function isEmptyRow(row: CsvRow): boolean {
  return row.cells.every((cell) => cell.trim() === '');
}

/** Shared fields of both report types, validated with line-numbered errors. */
interface ParsedLine {
  date: string;
  login: string;
  sku: BillingSku;
  quantityNano: bigint;
  grossNano: bigint;
  discountNano: bigint;
  netNano: bigint;
}

function parseLine(row: CsvRow, columns: Map<string, number>): ParsedLine {
  const fail = (reason: string): never => {
    throw new CsvImportError(`line ${row.line}: ${reason}`);
  };

  const date = cellAt(row, columns.get('date')).trim();
  if (!DATE_RE.test(date)) fail(`invalid date "${date}" (expected YYYY-MM-DD)`);

  const login = cellAt(row, columns.get('username')).trim();
  if (login === '') fail('missing username');

  const rawSku = cellAt(row, columns.get('sku')).trim();
  const sku = BILLING_SKUS.find((s) => s === rawSku);
  if (sku === undefined) throw new CsvImportError(`line ${row.line}: unknown sku "${rawSku}"`);

  const money = (column: string): bigint => {
    const raw = cellAt(row, columns.get(column));
    try {
      return parseNano(raw);
    } catch (error) {
      return fail(`invalid ${column}: ${(error as Error).message}`);
    }
  };

  return {
    date,
    login,
    sku,
    quantityNano: money('quantity'),
    grossNano: money('gross_amount'),
    discountNano: money('discount_amount'),
    netNano: money('net_amount'),
  };
}

const REQUIRED_COLUMNS = ['date', 'username', 'sku', 'quantity', 'gross_amount', 'discount_amount', 'net_amount'];

/**
 * Parse one billing report CSV: detect the report type from the header
 * (`model` ⇒ Report 1, `workflow_path` ⇒ Report 2, neither or both ⇒ reject),
 * validate every row, and aggregate by the target table's primary key —
 * the raw files repeat a key across cost centers / repositories, which the
 * spec ignores, so those rows sum into one.
 */
export function parseBillingReport(csv: string): ParsedBillingReport {
  const rows = parseCsvRows(stripBom(csv));
  const header = rows[0];
  if (!header) throw new CsvImportError('empty CSV');

  const headerCells = new Set(header.cells.map((c) => c.trim().toLowerCase()));
  const hasModel = headerCells.has('model');
  const hasWorkflowPath = headerCells.has('workflow_path');
  if (hasModel === hasWorkflowPath) {
    throw new CsvImportError(
      'cannot identify report type: expected exactly one of a "model" column (Report 1) or a "workflow_path" column (Report 2)',
    );
  }
  const reportType: BillingReportType = hasModel ? 'model' : 'billing';

  const columns = headerIndex(header, hasModel ? [...REQUIRED_COLUMNS, 'model'] : REQUIRED_COLUMNS);

  interface Totals {
    quantityNano: bigint;
    grossNano: bigint;
    discountNano: bigint;
    netNano: bigint;
  }
  /** date SEP login SEP (sku | model) → summed nanos. */
  const aggregated = new Map<string, Totals>();
  const logins = new Set<string>();
  let from = '';
  let to = '';
  let skippedNonCreditRows = 0;

  for (const row of rows.slice(1)) {
    if (isEmptyRow(row)) continue;
    const parsed = parseLine(row, columns);

    let third: string = parsed.sku;
    if (reportType === 'model') {
      // model_spend_daily stores AI-credit quantities. Report 1 also carries
      // `copilot_premium_request` rows whose quantity is a *request* count at a
      // different unit price — summing those into credits_nano would silently
      // mix units, so any non-credit sku is skipped explicitly.
      if (parsed.sku !== AI_CREDIT_SKU) {
        skippedNonCreditRows += 1;
        continue;
      }
      third = cellAt(row, columns.get('model')).trim();
      if (third === '') throw new CsvImportError(`line ${row.line}: missing model`);
    }

    const key = [parsed.date, parsed.login, third].join(KEY_SEP);
    const totals = aggregated.get(key);
    if (totals) {
      totals.quantityNano += parsed.quantityNano;
      totals.grossNano += parsed.grossNano;
      totals.discountNano += parsed.discountNano;
      totals.netNano += parsed.netNano;
    } else {
      aggregated.set(key, {
        quantityNano: parsed.quantityNano,
        grossNano: parsed.grossNano,
        discountNano: parsed.discountNano,
        netNano: parsed.netNano,
      });
    }

    logins.add(parsed.login);
    if (from === '' || parsed.date < from) from = parsed.date;
    if (to === '' || parsed.date > to) to = parsed.date;
  }

  if (aggregated.size === 0) {
    throw new CsvImportError(
      skippedNonCreditRows > 0
        ? `CSV contains no ${AI_CREDIT_SKU} rows`
        : 'CSV contains no data rows',
    );
  }

  const billingRows: BillingDailyInsert[] = [];
  const modelRows: ModelSpendDailyInsert[] = [];
  for (const [key, totals] of aggregated) {
    const [date, login, third] = key.split(KEY_SEP) as [string, string, string];
    if (reportType === 'billing') {
      billingRows.push({ date, login, sku: third, ...totals });
    } else {
      modelRows.push({
        date,
        login,
        model: third,
        creditsNano: totals.quantityNano,
        grossNano: totals.grossNano,
        discountNano: totals.discountNano,
        netNano: totals.netNano,
      });
    }
  }

  return {
    reportType,
    billingRows,
    modelRows,
    dateRange: { from, to },
    logins: [...logins],
    skippedNonCreditRows,
  };
}

/** Parse user-export.csv → github_users rows. Blank saml_name_id becomes null. */
export function parseUserExport(csv: string): GithubUserInsert[] {
  const rows = parseCsvRows(stripBom(csv));
  const header = rows[0];
  if (!header) throw new CsvImportError('empty CSV');
  const columns = headerIndex(header, ['login', 'saml_name_id']);

  // Last occurrence of a login wins, mirroring upsert semantics.
  const byLogin = new Map<string, GithubUserInsert>();
  for (const row of rows.slice(1)) {
    if (isEmptyRow(row)) continue;
    const login = cellAt(row, columns.get('login')).trim();
    if (login === '') throw new CsvImportError(`line ${row.line}: missing login`);
    const samlNameId = cellAt(row, columns.get('saml_name_id')).trim();
    byLogin.set(login, { login, samlNameId: samlNameId === '' ? null : samlNameId });
  }

  if (byLogin.size === 0) throw new CsvImportError('CSV contains no data rows');
  return [...byLogin.values()];
}

// --- Persistence -------------------------------------------------------------

/** Report 1 is the Imports page's Model usage slot, Report 2 its Cost report slot. */
const SLOT_BY_REPORT: Record<BillingReportType, ImportSlot> = { model: 'model', billing: 'cost' };

/**
 * Which slot a *rejected* file belongs to. The report type is only known once
 * the file parses, so fall back to the same `model`-column test the parser
 * uses; a header too broken even for that is filed under the cost report.
 */
function sniffSlot(csv: string): ImportSlot {
  const [header] = parseCsvRows(stripBom(csv).split('\n', 1)[0] ?? '');
  const hasModel = header?.cells.some((cell) => cell.trim().toLowerCase() === 'model') ?? false;
  return hasModel ? 'model' : 'cost';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rows per multi-row upsert statement — 7 columns each, well under the param cap. */
const CHUNK_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Import one billing report CSV. All-or-nothing: parse errors throw
 * `CsvImportError` before any write; the upsert runs in a single transaction.
 * Re-importing the same or an overlapping file is idempotent (upsert by PK).
 *
 * Both outcomes land in the import log — a rejected upload is exactly what the
 * Imports page's history has to explain. `filename` is what the upload was
 * called upstream; the request body itself is bare CSV and carries no name.
 */
export async function importBillingCsv(
  csv: string,
  filename?: string,
): Promise<BillingImportResult> {
  const startedAt = Date.now();

  // Only the parse and the transaction can fail with nothing written, so only
  // they are covered by the failure record. Past the commit the rows are in —
  // logging a failure there would have the history deny an import that landed.
  let parsed: ParsedBillingReport;
  try {
    parsed = parseBillingReport(csv);
    await writeBillingReport(parsed);
  } catch (error) {
    await recordImport({
      slot: sniffSlot(csv),
      filename,
      rowCount: 0,
      status: 'failed',
      error: errorMessage(error),
    });
    throw error;
  }

  const rowsUpserted =
    parsed.reportType === 'billing' ? parsed.billingRows.length : parsed.modelRows.length;

  // Recorded before the unknown-login lookup, which reads outside the
  // transaction and is the one remaining thing that can still throw.
  await recordImport({
    slot: SLOT_BY_REPORT[parsed.reportType],
    filename,
    rowCount: rowsUpserted,
    status: 'succeeded',
    error: null,
  });

  const unknownLogins = await findUnknownLogins(parsed.logins);

  log.info(
    {
      'event.action': 'billing-import',
      'event.outcome': 'success',
      'event.duration': eventDuration(startedAt),
      dash: {
        reportType: parsed.reportType,
        rowsUpserted,
        unknownLogins: unknownLogins.length,
        skippedNonCreditRows: parsed.skippedNonCreditRows,
        ...parsed.dateRange,
      },
    },
    'billing report import finished',
  );

  return { reportType: parsed.reportType, rowsUpserted, dateRange: parsed.dateRange, unknownLogins };
}

async function writeBillingReport(parsed: ParsedBillingReport): Promise<void> {
  await db.transaction(async (tx) => {
    if (parsed.reportType === 'billing') {
      for (const rows of chunk(parsed.billingRows, CHUNK_SIZE)) {
        await tx
          .insert(billingDaily)
          .values(rows)
          .onConflictDoUpdate({
            target: [billingDaily.date, billingDaily.login, billingDaily.sku],
            set: {
              quantityNano: sql`excluded.quantity_nano`,
              grossNano: sql`excluded.gross_nano`,
              discountNano: sql`excluded.discount_nano`,
              netNano: sql`excluded.net_nano`,
              syncedAt: sql`now()`,
            },
          });
      }
    } else {
      for (const rows of chunk(parsed.modelRows, CHUNK_SIZE)) {
        await tx
          .insert(modelSpendDaily)
          .values(rows)
          .onConflictDoUpdate({
            target: [modelSpendDaily.date, modelSpendDaily.login, modelSpendDaily.model],
            set: {
              creditsNano: sql`excluded.credits_nano`,
              grossNano: sql`excluded.gross_nano`,
              discountNano: sql`excluded.discount_nano`,
              netNano: sql`excluded.net_nano`,
              syncedAt: sql`now()`,
            },
          });
      }
    }

    // Sticky activity flag: every login in the report gets a github_users row
    // with active = true. Insert-or-flag only — never cleared, never deleted —
    // so a user who was active at any point stays in the user filter forever,
    // even when later reports no longer mention them.
    for (const logins of chunk(parsed.logins, CHUNK_SIZE)) {
      await tx
        .insert(githubUsers)
        .values(logins.map((login) => ({ login, active: true })))
        .onConflictDoUpdate({
          target: githubUsers.login,
          set: { active: sql`true` },
        });
    }
  });
}

/**
 * Distinct logins with no SAML mapping in github_users — surfaced, never
 * blocking. The billing import itself inserts bare active rows for report
 * logins, so "row exists" no longer means "identity known"; a login counts as
 * known only once the user export supplied its saml_name_id.
 */
async function findUnknownLogins(logins: string[]): Promise<string[]> {
  const known = new Set<string>();
  for (const batch of chunk(logins, CHUNK_SIZE)) {
    const rows = await db
      .select({ login: githubUsers.login })
      .from(githubUsers)
      .where(and(inArray(githubUsers.login, batch), isNotNull(githubUsers.samlNameId)));
    for (const row of rows) known.add(row.login);
  }
  return logins.filter((login) => !known.has(login)).sort();
}

/** Import user-export.csv into github_users. Upsert by login, idempotent. */
export async function importUserExportCsv(
  csv: string,
  filename?: string,
): Promise<{ rowsUpserted: number }> {
  const startedAt = Date.now();
  try {
    return await runUserExportImport(csv, filename, startedAt);
  } catch (error) {
    await recordImport({
      slot: 'users',
      filename,
      rowCount: 0,
      status: 'failed',
      error: errorMessage(error),
    });
    throw error;
  }
}

async function runUserExportImport(
  csv: string,
  filename: string | undefined,
  startedAt: number,
): Promise<{ rowsUpserted: number }> {
  const users = parseUserExport(csv);

  await db.transaction(async (tx) => {
    for (const rows of chunk(users, CHUNK_SIZE)) {
      await tx
        .insert(githubUsers)
        .values(rows)
        .onConflictDoUpdate({
          target: githubUsers.login,
          set: {
            samlNameId: sql`excluded.saml_name_id`,
            syncedAt: sql`now()`,
          },
        });
    }
  });

  log.info(
    {
      'event.action': 'user-export-import',
      'event.outcome': 'success',
      'event.duration': eventDuration(startedAt),
      dash: { rowsUpserted: users.length },
    },
    'user export import finished',
  );

  await recordImport({
    slot: 'users',
    filename,
    rowCount: users.length,
    status: 'succeeded',
    error: null,
  });

  return { rowsUpserted: users.length };
}
