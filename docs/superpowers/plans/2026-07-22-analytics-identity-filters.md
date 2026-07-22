# Analytics Identity Mapping + Spend-Parity Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seats resolve identity (display name, department, managers) through the
`github_users` → `jira_people` saml join spend already uses, and the analytics
page gains spend-style cascading org filters that also drive the filtered
activity charts.

**Architecture:** Read-time join in the API (`services/identity.ts`, shared by
`listSeats` and `getSpend`); `CopilotSeat` carries the resolved fields; the web
app reuses `spendFilter.ts`'s `SpendFilters`/`personMatches` on seats (they are
structurally `SpendPerson`s after the join) and the spend cascade/combobox UI.

**Tech Stack:** TypeScript strict, Drizzle/Postgres, React 18, CSS Modules. No
test framework — `pnpm typecheck` plus scripted verification against the live
local API.

## Global Constraints

- No test framework, no linter: `pnpm --filter @dash/shared build` then `pnpm typecheck` is the gate.
- `pnpm dev` does not watch `packages/shared` — rebuild it after type changes.
- Every colour/radius/font from `apps/web/src/styles/tokens.css`; CSS Modules only.
- Nothing outside `apps/api/src/copilot/` may know the data source; identity join stays in `services/`.
- Null means "unknown", never zero; unmapped identity renders login fallback, not fake data.
- Conventional commits; work on `feat/analytics-identity-filters`; PR via `gh`.

---

### Task 1: Identity resolver in the API + `CopilotSeat` fields

**Files:**
- Modify: `packages/shared/src/types.ts` (CopilotSeat)
- Create: `apps/api/src/services/identity.ts`
- Modify: `apps/api/src/services/spend.ts` (use the helper, output unchanged)
- Modify: `apps/api/src/services/dashboard.ts:50-85` (`toSeat`/`listSeats`)

**Interfaces:**
- Produces: `loadIdentity(): Promise<{ activeLogins: Set<string>; resolve(login: string): ResolvedIdentity }>` where `ResolvedIdentity = { samlNameId, displayName, department, b1Manager, b2Manager, mapped }`.
- Produces: `CopilotSeat` gains those six fields (non-optional; `displayName: string`, `mapped: boolean`, rest `string | null`).

- [ ] **Step 1: Extend `CopilotSeat`** — after `name: string;` add:

```ts
  /**
   * Identity resolved at read time via `github_users` (login → saml_name_id)
   * and `jira_people` — the same join the spend page uses. `displayName`
   * falls back to the login and `mapped` is false when either hop misses.
   */
  samlNameId: string | null;
  displayName: string;
  department: string | null;
  b1Manager: string | null;
  b2Manager: string | null;
  mapped: boolean;
```

- [ ] **Step 2: Create `apps/api/src/services/identity.ts`**:

```ts
import { db } from '../db/client.js';
import { githubUsers, jiraPeople } from '../db/schema.js';
import type { JiraPersonRow } from '../db/schema.js';

/** Login-keyed identity resolution shared by the seats and spend read paths. */

export interface ResolvedIdentity {
  samlNameId: string | null;
  displayName: string;
  department: string | null;
  b1Manager: string | null;
  b2Manager: string | null;
  mapped: boolean;
}

function displayName(person: JiraPersonRow | undefined, login: string): string {
  const name = [person?.firstName, person?.lastName].filter(Boolean).join(' ');
  return name === '' ? login : name;
}

/**
 * Load both identity tables once and return a resolver. All `github_users`
 * rows participate — the `active` flag only means "seen in a billing report"
 * and must not gate seat identity; callers that need it get `activeLogins`.
 * SAML ids match `jira_people` case-insensitively (the PK is stored uppercase).
 */
export async function loadIdentity(): Promise<{
  activeLogins: Set<string>;
  resolve: (login: string) => ResolvedIdentity;
}> {
  const [users, jiraRows] = await Promise.all([
    db
      .select({
        login: githubUsers.login,
        samlNameId: githubUsers.samlNameId,
        active: githubUsers.active,
      })
      .from(githubUsers),
    db.select().from(jiraPeople),
  ]);

  const jiraBySaml = new Map(jiraRows.map((row) => [row.samlNameId.toUpperCase(), row]));
  const samlByLogin = new Map(users.map((user) => [user.login, user.samlNameId]));
  const activeLogins = new Set(users.filter((user) => user.active).map((user) => user.login));

  const resolve = (login: string): ResolvedIdentity => {
    const samlNameId = samlByLogin.get(login) ?? null;
    const person = samlNameId === null ? undefined : jiraBySaml.get(samlNameId.toUpperCase());
    return {
      samlNameId,
      displayName: displayName(person, login),
      department: person?.department ?? null,
      b1Manager: person?.b1Manager ?? null,
      b2Manager: person?.b2Manager ?? null,
      mapped: person !== undefined,
    };
  };

  return { activeLogins, resolve };
}
```

- [ ] **Step 3: Refactor `spend.ts`** — delete its `displayName`/`joinPeople` and the two identity queries; `getSpend` calls `loadIdentity()`, then builds `people` from `activeLogins ∪ billingLogins`, sorted, each `{ login, ...resolve(login) }`. Output identical to today.

- [ ] **Step 4: Join in `listSeats`** — `const { resolve } = await loadIdentity();` and `toSeat(row, now, resolve(row.login))` spreading the resolution into the returned seat.

- [ ] **Step 5: Verify** — `pnpm --filter @dash/shared build && pnpm typecheck` (expect web errors only where seats are constructed, none expected), fix fallout, commit `feat(api): resolve seat identity through the saml/jira join`.

### Task 2: Web filter model — scope filters on seats

**Files:**
- Modify: `apps/web/src/lib/metrics/filter.ts` (SeatFilters + filterSeats + search over displayName)
- Modify: `apps/web/src/lib/metrics/spendFilter.ts` (generalise doc note; add `scopeOptions` + `cascadeScopeChange` extracted from `SpendFilterBar`)
- Modify: `apps/web/src/components/spend/SpendFilterBar.tsx` (use the extracted helpers)
- Modify: `apps/web/src/state/dashboardState.ts` (add `seatScope: SpendFilters` + `setSeatScope`)
- Modify: `apps/web/src/hooks/useDashboardMetrics.ts` (pass scope into filterSeats)

**Interfaces:**
- Consumes: `personMatches`, `SpendFilters`, `EMPTY_SPEND_FILTERS` from `spendFilter.ts`; `CopilotSeat` identity fields from Task 1.
- Produces: `SeatFilters` gains `scope: SpendFilters`; `filterSeats(seats, filters)` applies `personMatches(seat, filters.scope)`; `scopeOptions(people, field, filters): FilterOption-shaped {value,label}[]`; `cascadeScopeChange(people, filters, patch): Partial<SpendFilters>`; reducer action `{ type: 'setSeatScope'; filters: Partial<SpendFilters> }` (resets `page`).

- [ ] **Step 1: filter.ts** — `SeatFilters` gains `scope: SpendFilters`; `matchesSearch` also checks `seat.displayName.toLowerCase()`; `filterSeats` adds `personMatches(seat, filters.scope)` to the predicate.
- [ ] **Step 2: spendFilter.ts** — move `SpendFilterBar.options` in as `scopeOptions` and `changeScope`'s reconciliation in as `cascadeScopeChange` (pure: returns the patch, caller dispatches). `SpendFilterBar` keeps only UI.
- [ ] **Step 3: dashboardState.ts** — `seatScope: EMPTY_SPEND_FILTERS` in initial state; `setSeatScope` merges partial patch, resets `page: 0`.
- [ ] **Step 4: useDashboardMetrics.ts** — filter call becomes `filterSeats(seats, { editor, language, search, scope: state.seatScope })` with `state.seatScope` in the memo deps.
- [ ] **Step 5: Verify** — `pnpm typecheck`, commit `feat(web): seat filters gain spend-style org scope`.

### Task 3: FilterBar UI + page wiring

**Files:**
- Modify: `apps/web/src/components/FilterBar.tsx` (+ its module.css) — four `FilterCombobox`es + Unmapped toggle
- Modify: `apps/web/src/components/copilot/CopilotAnalyticsPage.tsx` — wire props, extend `filterActive`

**Interfaces:**
- Consumes: `FilterCombobox` (`components/spend/FilterCombobox.tsx`), `scopeOptions`, `cascadeScopeChange`, `personMatches` from Task 2.
- Produces: `FilterBar` new props `{ seats: readonly CopilotSeat[]; scope: SpendFilters; onScopeChange(patch: Partial<SpendFilters>): void }`.

- [ ] **Step 1: FilterBar** — compute department/B-1/B-2 options via `scopeOptions(seats, field, scope)`, user options via `personMatches(seat, scope, 'login')` cascade with `displayName (login)` labels + keywords, all changes routed through `cascadeScopeChange(seats, scope, patch)`; Unmapped toggle mirrors `SpendFilterBar` (reuse its class styling approach in FilterBar.module.css with existing tokens).
- [ ] **Step 2: CopilotAnalyticsPage** — pass `seats={seatsQuery.data ?? EMPTY_SEATS}`, `scope={state.seatScope}`, `onScopeChange` dispatching `setSeatScope`; `filterActive` also true when any scope field is set (`department/b1Manager/b2Manager/login !== null || unmappedOnly`).
- [ ] **Step 3: Verify** — `pnpm typecheck`, commit `feat(web): analytics filter bar gains org-structure comboboxes`.

### Task 4: Seat table shows resolved names

**Files:**
- Modify: `apps/web/src/components/UserTable.tsx:73-78`

- [ ] **Step 1** — `Avatar name={seat.displayName}`; primary line `seat.displayName`; secondary line stays `seat.login` (skip duplicating when they are equal: render the login row only when `seat.displayName !== seat.login`).
- [ ] **Step 2: Verify** — `pnpm typecheck`, commit `feat(web): seat table shows saml-mapped display names`.

### Task 5: End-to-end verification + PR

- [ ] **Step 1** — boot worktree API on a spare port (`PORT=4100 node --env-file=.env apps/api/dist/index.js` after `pnpm --filter @dash/api build`), login, assert `/api/seats` rows carry `displayName`/`mapped`.
- [ ] **Step 2** — node script replaying `filterSeats` + `filteredActivity` against the live payload with a scope filter, assert non-empty where expected and `/api/spend` people output unchanged shape.
- [ ] **Step 3** — `pnpm build`; push; PR via `gh pr create` (business-focused description).
