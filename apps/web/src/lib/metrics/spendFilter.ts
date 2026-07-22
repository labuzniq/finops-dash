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

/** True when any scope filter is set — both pages' "is anything filtered?" check. */
export function scopeActive(f: SpendFilters): boolean {
  return (
    f.department !== null ||
    f.b1Manager !== null ||
    f.b2Manager !== null ||
    f.login !== null ||
    f.unmappedOnly
  );
}

/**
 * The logins surviving the filters, or null when no filter is active — the
 * distinction lets callers skip row filtering entirely on the common path.
 */
export function filterLogins(people: SpendPerson[], f: SpendFilters): Set<string> | null {
  if (!scopeActive(f)) {
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

/**
 * Distinct non-null values of one identity field, sorted, as combobox options —
 * drawn only from the people who pass every *other* active filter, so each
 * list shows just the combinations that exist. Shared by the spend and
 * analytics filter bars (seats carry the identity fields too).
 */
export function scopeOptions(
  people: readonly SpendPerson[],
  field: 'department' | 'b1Manager' | 'b2Manager',
  filters: SpendFilters,
): Array<{ value: string; label: string }> {
  const values = new Set<string>();
  for (const person of people) {
    if (!personMatches(person, filters, field)) continue;
    const value = person[field];
    if (value !== null && value !== '') values.add(value);
  }
  return [...values].sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value }));
}

/**
 * Reconcile a scope change: changing one filter can orphan another — pick a
 * department the selected B-1 manager doesn't sit under and the combination
 * matches nobody. The just-changed field wins: every other selection must
 * still be able to coexist with it (and with each other), or it is dropped.
 * Pure — returns the patch to dispatch, nulled fields included.
 */
export function cascadeScopeChange(
  people: readonly SpendPerson[],
  filters: SpendFilters,
  patch: Partial<SpendFilters>,
): Partial<SpendFilters> {
  const next = { ...filters, ...patch };
  const result: Partial<SpendFilters> = { ...patch };
  const kept: SpendScopeField[] = (
    ['department', 'b1Manager', 'b2Manager', 'login'] as const
  ).filter((field) => !(field in patch) && next[field] !== null);

  // First pass: each kept selection must coexist with the changed fields alone.
  const changed: SpendFilters = { ...EMPTY_SPEND_FILTERS, ...patch, unmappedOnly: next.unmappedOnly };
  for (const field of kept) {
    const pair: SpendFilters = { ...changed, [field]: next[field] };
    if (!people.some((person) => personMatches(person, pair))) {
      next[field] = null;
      result[field] = null;
    }
  }

  // Second pass: survivors can be pairwise-valid yet jointly empty — thin
  // from the most specific selection up until somebody matches everything.
  for (const field of [...kept].reverse()) {
    if (next[field] === null) continue;
    if (people.some((person) => personMatches(person, next))) break;
    next[field] = null;
    result[field] = null;
  }

  return result;
}
