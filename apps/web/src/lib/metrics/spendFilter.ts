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

/** The four single-value scope filters — the ones cascading options reason about. */
export type SpendScopeField = 'department' | 'b1Manager' | 'b2Manager' | 'login';

/**
 * Whether one person survives the filters. `ignore` exempts a single field —
 * that is what makes a combobox's option list cascade: options for field X
 * come from the people who pass every filter *except* X.
 */
export function personMatches(
  person: SpendPerson,
  f: SpendFilters,
  ignore?: SpendScopeField,
): boolean {
  if (ignore !== 'department' && f.department !== null && person.department !== f.department) {
    return false;
  }
  if (ignore !== 'b1Manager' && f.b1Manager !== null && person.b1Manager !== f.b1Manager) {
    return false;
  }
  if (ignore !== 'b2Manager' && f.b2Manager !== null && person.b2Manager !== f.b2Manager) {
    return false;
  }
  if (ignore !== 'login' && f.login !== null && person.login !== f.login) return false;
  if (f.unmappedOnly && person.mapped) return false;
  return true;
}

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
    if (personMatches(person, f)) logins.add(person.login);
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
