import { and, asc, gte, lte } from 'drizzle-orm';
import { BILLING_SKUS } from '@dash/shared';
import type { BillingRow, ModelSpendRow, SpendPayload, SpendPerson } from '@dash/shared';
import { db } from '../db/client.js';
import { billingDaily, githubUsers, jiraPeople, modelSpendDaily } from '../db/schema.js';
import type { JiraPersonRow } from '../db/schema.js';
import { nanoToDollars } from '../lib/nano.js';

/**
 * The spend read model: everything `GET /api/spend` returns in one payload,
 * fetch-once like the rest of the app. Money and quantities leave their exact
 * bigint nano representation here — via `nanoToDollars`, nowhere else.
 */

/** "First Last" when the JIRA join hit, the raw login otherwise. */
function displayName(person: JiraPersonRow | undefined, login: string): string {
  const name = [person?.firstName, person?.lastName].filter(Boolean).join(' ');
  return name === '' ? login : name;
}

/**
 * The code-side identity join: one entry per login appearing in `github_users`
 * or in the fetched billing/model rows. SAML ids match `jira_people`
 * case-insensitively (the PK is stored uppercase). Logins without a saml id or
 * without a JIRA hit come back `mapped: false` with null org fields — they
 * still count in every total.
 */
function joinPeople(
  users: { login: string; samlNameId: string | null }[],
  jiraRows: JiraPersonRow[],
  billingLogins: Iterable<string>,
): SpendPerson[] {
  const jiraBySaml = new Map(jiraRows.map((row) => [row.samlNameId.toUpperCase(), row]));
  const samlByLogin = new Map(users.map((user) => [user.login, user.samlNameId]));

  const logins = new Set<string>(samlByLogin.keys());
  for (const login of billingLogins) logins.add(login);

  const people: SpendPerson[] = [];
  for (const login of [...logins].sort()) {
    const samlNameId = samlByLogin.get(login) ?? null;
    const person =
      samlNameId === null ? undefined : jiraBySaml.get(samlNameId.toUpperCase());
    people.push({
      login,
      samlNameId,
      displayName: displayName(person, login),
      department: person?.department ?? null,
      b1Manager: person?.b1Manager ?? null,
      b2Manager: person?.b2Manager ?? null,
      mapped: person !== undefined,
    });
  }
  return people;
}

/**
 * Billing rows, model rows and the identity join for an inclusive date range.
 * `billingRows` (Report 2) is the sole money source; `modelRows` (Report 1)
 * carries per-model stats and is never summed into money totals client-side.
 */
export async function getSpend(from: string, to: string): Promise<SpendPayload> {
  const [billing, models, users, jira] = await Promise.all([
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
    db.select({ login: githubUsers.login, samlNameId: githubUsers.samlNameId }).from(githubUsers),
    db.select().from(jiraPeople),
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

  const billingLogins = new Set<string>();
  for (const row of billingRows) billingLogins.add(row.login);
  for (const row of modelRows) billingLogins.add(row.login);

  return { billingRows, modelRows, people: joinPeople(users, jira, billingLogins) };
}
