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

/** The daily licence-accrual sku. Inside Gross and Net; the licence KPI is only it, informational. */
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

/**
 * What `POST /api/import/billing` answers with. Report 1 (`model`) and Report 2
 * (`billing`) share the endpoint — the server detects which from the header, so
 * the client learns the type from the response. Named apart from the seat
 * `ImportResult` in `types.ts`, which is a different contract.
 */
export interface BillingImportResult {
  reportType: 'model' | 'billing';
  rowsUpserted: number;
  dateRange: { from: string; to: string };
  /** Distinct logins in the file with no `github_users` row — informational. */
  unknownLogins: string[];
}

/**
 * How far back the per-model report reaches, and when each login last spent a
 * credit *before* the selected range.
 *
 * The wasted-seat population is "licensed, zero credits in range", which by
 * construction says nothing about what happened before the range — so a seat
 * nobody has ever spent a credit on and one whose owner stopped three weeks ago
 * are the same row without this. Credits rather than seat activity, because
 * credits are the currency of the waste test itself.
 *
 * `floor` is what keeps "never" from being asserted: a login absent from
 * `lastCreditBefore` spent nothing *in the imported history*, and someone whose
 * last credit predates the first imported day is indistinguishable from someone
 * who never spent one. Consumers name the floor rather than claiming never.
 */
export interface CreditHistory {
  /** First day the per-model report covers. Null when nothing is imported. */
  floor: string | null;
  /**
   * login -> last day strictly before the range that recorded credits. A login
   * with no credit day in the imported history is absent rather than null: the
   * absence is the fact, and a null would invite zero-filling it.
   */
  lastCreditBefore: Record<string, string>;
}

/** Everything `GET /api/spend` returns — fetched once, derived client-side. */
export interface SpendPayload {
  billingRows: BillingRow[];
  modelRows: ModelSpendRow[];
  people: SpendPerson[];
  creditHistory: CreditHistory;
}
