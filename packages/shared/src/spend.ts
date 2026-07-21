/**
 * The spend contract, mirroring the GitHub billing usage report CSVs.
 *
 * Report 2 (`BillingRow`) is the sole money authority — licences live only
 * there. Report 1 (`ModelSpendRow`) carries per-model AI-credit statistics and
 * is never summed into money totals. Money is stored as bigint nano-dollars in
 * Postgres; the numbers here are dollars, converted exactly once at the API
 * response edge.
 */

export const BILLING_SKUS = [
  'copilot_ai_credit',
  'copilot_for_business',
  'copilot_premium_request',
] as const;
export type BillingSku = (typeof BILLING_SKUS)[number];

/** The daily licence-accrual sku. Net KPIs exclude it; the licence KPI is only it. */
export const LICENCE_SKU = 'copilot_for_business' satisfies BillingSku;

/**
 * The AI-credit sku — the only sku whose Report-1 quantity is an AI-credit
 * count. Report 1 also carries `copilot_premium_request` rows (unit: requests),
 * which must never sum into credit statistics.
 */
export const AI_CREDIT_SKU = 'copilot_ai_credit' satisfies BillingSku;

/** Credits included in a $19 licence per month (`total_monthly_quota`, constant in the CSV). */
export const MONTHLY_CREDIT_QUOTA = 1900;

/** One Report-2 row, dollars (converted once, server-side). */
export interface BillingRow {
  date: string; // YYYY-MM-DD
  login: string;
  sku: BillingSku;
  quantity: number;
  gross: number;
  discount: number;
  net: number;
}

/** One Report-1 row, per-model AI-credit stats. Never summed into money totals. */
export interface ModelSpendRow {
  date: string;
  login: string;
  model: string;
  credits: number;
  gross: number;
  discount: number;
  net: number;
}

/**
 * One login's identity, the code-side join of `github_users` × `jira_people`.
 * Unmapped logins keep `mapped: false` and null org fields — they still count
 * in every total.
 */
export interface SpendPerson {
  login: string;
  samlNameId: string | null;
  displayName: string; // "First Last" when mapped, raw login otherwise
  department: string | null;
  b1Manager: string | null;
  b2Manager: string | null;
  mapped: boolean;
}

/** Everything `GET /api/spend` returns — fetched once, derived client-side. */
export interface SpendPayload {
  billingRows: BillingRow[];
  modelRows: ModelSpendRow[];
  people: SpendPerson[];
}
