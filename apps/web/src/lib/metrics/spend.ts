import { LICENCE_SKU } from '@dash/shared';
import type { BillingRow, ModelSpendRow, SpendPerson } from '@dash/shared';

/**
 * Spend derivations over the billing-report rows.
 *
 * `billingRows` (Report 2) is the sole money authority; `modelRows` (Report 1)
 * only ever contributes per-model statistics and credit counts — it is never
 * summed into money totals. Net always means non-licence skus only: what the
 * org paid for usage beyond the enterprise pool. Licence money is its own
 * value, part of Gross but never added to it a second time.
 *
 * All functions are pure and memo-friendly; callers pass rows already narrowed
 * by `applySpendFilter`, so every derivation recomputes under the filters.
 */

/** Four separate dollar values for the range — never summed with each other. */
export interface SpendKpis {
  gross: number;
  discount: number;
  /** Non-licence skus only. */
  net: number;
  /** Sum of the daily licence rows in range — included in Gross. */
  licence: number;
}

export interface SpendTrendDay {
  date: string; // YYYY-MM-DD
  gross: number;
  discount: number;
  net: number;
  licence: number;
}

export interface ModelBreakdownRow {
  model: string;
  credits: number;
  gross: number;
  /** Share of credit gross across all models, 0..1. */
  share: number;
}

export interface SpendUserRow {
  login: string;
  displayName: string;
  mapped: boolean;
  department: string | null;
  b1Manager: string | null;
  b2Manager: string | null;
  credits: number;
  gross: number;
  discount: number;
  net: number;
  licence: number;
}

/** Sortable numeric columns of the spend user table. */
export type SpendSortKey = 'credits' | 'gross' | 'discount' | 'net';

/** -1 = descending (the default on every column), 1 = ascending. */
export type SpendSortDirection = -1 | 1;

export function sortSpendUserRows(
  rows: readonly SpendUserRow[],
  key: SpendSortKey,
  direction: SpendSortDirection,
): SpendUserRow[] {
  return [...rows].sort((a, b) => {
    const left = a[key];
    const right = b[key];
    // Equal values fall back to login so paging stays deterministic.
    if (left === right) return a.login.localeCompare(b.login);
    return (left < right ? -1 : 1) * direction;
  });
}

/** Every ISO date from `from` to `to` inclusive — the trend's zero-fill spine. */
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

export function spendKpis(rows: BillingRow[]): SpendKpis {
  let gross = 0;
  let discount = 0;
  let net = 0;
  let licence = 0;

  for (const row of rows) {
    gross += row.gross;
    discount += row.discount;
    // Licence rows accrue with discount 0, so gross == net there; the split
    // keeps the daily accrual out of the usage-beyond-pool Net.
    if (row.sku === LICENCE_SKU) licence += row.gross;
    else net += row.net;
  }

  return { gross, discount, net, licence };
}

/** Daily totals, zero-filled across every calendar day in the range. */
export function spendTrend(rows: BillingRow[], from: string, to: string): SpendTrendDay[] {
  const byDate = new Map<string, SpendTrendDay>();
  for (const iso of isoDatesBetween(from, to)) {
    byDate.set(iso, { date: iso, gross: 0, discount: 0, net: 0, licence: 0 });
  }

  for (const row of rows) {
    const day = byDate.get(row.date);
    if (day === undefined) continue;
    day.gross += row.gross;
    day.discount += row.discount;
    if (row.sku === LICENCE_SKU) day.licence += row.gross;
    else day.net += row.net;
  }

  return [...byDate.values()];
}

/** AI-credit spend by model — statistics from Report 1, biggest gross first. */
export function modelBreakdown(rows: ModelSpendRow[]): ModelBreakdownRow[] {
  const byModel = new Map<string, { credits: number; gross: number }>();
  let totalGross = 0;

  for (const row of rows) {
    const acc = byModel.get(row.model) ?? { credits: 0, gross: 0 };
    acc.credits += row.credits;
    acc.gross += row.gross;
    byModel.set(row.model, acc);
    totalGross += row.gross;
  }

  return [...byModel.entries()]
    .map(([model, { credits, gross }]) => ({
      model,
      credits,
      gross,
      share: totalGross > 0 ? gross / totalGross : 0,
    }))
    .sort((a, b) => b.gross - a.gross || a.model.localeCompare(b.model));
}

/**
 * Per-user totals joined with identity. One row per login appearing in either
 * report; a login without a `SpendPerson` entry renders as itself, unmapped.
 * Credits come from Report 1; every dollar comes from Report 2.
 */
export function spendUserRows(
  billing: BillingRow[],
  models: ModelSpendRow[],
  people: SpendPerson[],
): SpendUserRow[] {
  const personByLogin = new Map(people.map((person) => [person.login, person]));
  const byLogin = new Map<string, SpendUserRow>();

  const rowFor = (login: string): SpendUserRow => {
    const existing = byLogin.get(login);
    if (existing !== undefined) return existing;

    const person = personByLogin.get(login);
    const row: SpendUserRow = {
      login,
      displayName: person?.displayName ?? login,
      mapped: person?.mapped ?? false,
      department: person?.department ?? null,
      b1Manager: person?.b1Manager ?? null,
      b2Manager: person?.b2Manager ?? null,
      credits: 0,
      gross: 0,
      discount: 0,
      net: 0,
      licence: 0,
    };
    byLogin.set(login, row);
    return row;
  };

  for (const row of billing) {
    const user = rowFor(row.login);
    user.gross += row.gross;
    user.discount += row.discount;
    if (row.sku === LICENCE_SKU) user.licence += row.gross;
    else user.net += row.net;
  }

  for (const row of models) {
    rowFor(row.login).credits += row.credits;
  }

  return [...byLogin.values()].sort((a, b) => b.gross - a.gross || a.login.localeCompare(b.login));
}
