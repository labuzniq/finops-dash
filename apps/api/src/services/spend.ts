import { and, asc, gte, lte } from 'drizzle-orm';
import { BILLING_SKUS } from '@dash/shared';
import type { BillingRow, ModelSpendRow, SpendPayload, SpendPerson } from '@dash/shared';
import { db } from '../db/client.js';
import { billingDaily, modelSpendDaily } from '../db/schema.js';
import { loadIdentity } from './identity.js';
import { nanoToDollars } from '../lib/nano.js';

/**
 * The spend read model: everything `GET /api/spend` returns in one payload,
 * fetch-once like the rest of the app. Money and quantities leave their exact
 * bigint nano representation here — via `nanoToDollars`, nowhere else.
 *
 * The identity join lives in `identity.ts` (shared with the seats read path).
 * The people list carries one entry per *active* login in `github_users` (ever
 * seen in a billing report — the flag is sticky, so once active a user stays
 * listed even when the selected range carries no rows for them) plus any login
 * in the fetched billing/model rows. Org members who never appear in a report
 * are excluded from the list but never deleted. Logins without a saml id or
 * without a JIRA hit come back `mapped: false` with null org fields — they
 * still count in every total.
 */

/**
 * Billing rows, model rows and the identity join for an inclusive date range.
 * `billingRows` (Report 2) is the sole money source; `modelRows` (Report 1)
 * carries per-model stats and is never summed into money totals client-side.
 */
export async function getSpend(from: string, to: string): Promise<SpendPayload> {
  const [billing, models, identity] = await Promise.all([
    db
      .select()
      .from(billingDaily)
      .where(and(gte(billingDaily.date, from), lte(billingDaily.date, to)))
      .orderBy(asc(billingDaily.date), asc(billingDaily.login), asc(billingDaily.sku)),
    db
      .select()
      .from(modelSpendDaily)
      .where(and(gte(modelSpendDaily.date, from), lte(modelSpendDaily.date, to)))
      .orderBy(asc(modelSpendDaily.date), asc(modelSpendDaily.login), asc(modelSpendDaily.model)),
    loadIdentity(),
  ]);

  const billingRows: BillingRow[] = [];
  for (const row of billing) {
    // The importer validates skus, so an unknown value cannot exist; the
    // narrow keeps the varchar column honest against the shared union anyway.
    const sku = BILLING_SKUS.find((candidate) => candidate === row.sku);
    if (sku === undefined) continue;
    billingRows.push({
      date: row.date,
      login: row.login,
      sku,
      quantity: nanoToDollars(row.quantityNano),
      gross: nanoToDollars(row.grossNano),
      discount: nanoToDollars(row.discountNano),
      net: nanoToDollars(row.netNano),
    });
  }

  const modelRows: ModelSpendRow[] = models.map((row) => ({
    date: row.date,
    login: row.login,
    model: row.model,
    credits: nanoToDollars(row.creditsNano),
    gross: nanoToDollars(row.grossNano),
    discount: nanoToDollars(row.discountNano),
    net: nanoToDollars(row.netNano),
  }));

  const logins = new Set<string>(identity.activeLogins);
  for (const row of billingRows) logins.add(row.login);
  for (const row of modelRows) logins.add(row.login);

  const people: SpendPerson[] = [...logins]
    .sort()
    .map((login) => ({ login, ...identity.resolve(login) }));

  return { billingRows, modelRows, people };
}
