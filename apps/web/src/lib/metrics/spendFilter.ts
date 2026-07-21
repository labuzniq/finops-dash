import type { SpendPerson } from '@dash/shared';

/**
 * Org-structure filters over the spend payload. Filters restrict the *login*
 * set; KPIs, trend, model breakdown and the user table all recompute from the
 * rows that survive `applySpendFilter` — nothing is ever pre-aggregated.
 */

export interface SpendFilters {
  department: string | null;
  b1Manager: string | null;
  b2Manager: string | null;
  /** A single login, or null for everyone. */
  login: string | null;
  /** The "Unmapped" group — logins without a JIRA identity. */
  unmappedOnly: boolean;
}

export const EMPTY_SPEND_FILTERS: SpendFilters = {
  department: null,
  b1Manager: null,
  b2Manager: null,
  login: null,
  unmappedOnly: false,
};

/**
 * The logins surviving the filters, or null when no filter is active — the
 * distinction lets callers skip row filtering entirely on the common path.
 */
export function filterLogins(people: SpendPerson[], f: SpendFilters): Set<string> | null {
  if (
    f.department === null &&
    f.b1Manager === null &&
    f.b2Manager === null &&
    f.login === null &&
    !f.unmappedOnly
  ) {
    return null;
  }

  const logins = new Set<string>();
  for (const person of people) {
    if (f.department !== null && person.department !== f.department) continue;
    if (f.b1Manager !== null && person.b1Manager !== f.b1Manager) continue;
    if (f.b2Manager !== null && person.b2Manager !== f.b2Manager) continue;
    if (f.login !== null && person.login !== f.login) continue;
    if (f.unmappedOnly && person.mapped) continue;
    logins.add(person.login);
  }
  return logins;
}

/** Rows whose login survived the filters; the identity pass-through when none did. */
export function applySpendFilter<T extends { login: string }>(
  rows: T[],
  logins: Set<string> | null,
): T[] {
  return logins === null ? rows : rows.filter((row) => logins.has(row.login));
}
