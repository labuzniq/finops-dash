# Analytics identity mapping + spend-parity filters

**Date:** 2026-07-22
**Status:** Approved (approach A, full parity)

## Problem

The analytics page identifies seats by raw GitHub login only. On live GitHub the
roster's `assignee.name` is almost always absent, so seats render and search as
bare logins. The spend page already resolves identity properly — `github_users`
(login → `saml_name_id`) joined to `jira_people` (person, department, managers)
— and filters by org structure with cascading comboboxes. Analytics should use
the same identity and offer the same filters.

## Decision

Server-side identity join on the seats read path (approach A):

1. **`apps/api/src/services/identity.ts` (new).** Extract the login →
   person resolution from `services/spend.ts:joinPeople` into a shared helper:
   fetches `github_users` (all rows — spend's `active` flag only means "seen in
   a billing report" and must not gate seat identity) and `jira_people`, returns
   a resolver `login → { samlNameId, displayName, department, b1Manager,
   b2Manager, mapped }`. JIRA match stays case-insensitive via uppercased saml
   id. Unresolved logins: `displayName = login`, null org fields,
   `mapped: false`. `spend.ts` keeps its exact output but computes it through
   the helper.

2. **`CopilotSeat` (packages/shared) gains the identity fields**:
   `samlNameId`, `displayName`, `department`, `b1Manager`, `b2Manager`,
   `mapped`. Filled at read time in `services/dashboard.ts:listSeats` — nothing
   stored, `copilot_seats` schema unchanged, `apps/api/src/copilot/` stays
   identity-free. Mock and live both flow through the same join (locally the
   tables fill via the user-export import and JIRA sync, same as spend).

3. **Web filters (spend parity).** `dashboardState` gains `department`,
   `b1Manager`, `b2Manager`, `user` (single login), `unmappedOnly` — same
   semantics as `SpendFilters`. `lib/metrics/filter.ts` extends `SeatFilters`
   and `filterSeats`; search also matches `displayName` (case-insensitive).
   Cascading option lists use the same ignore-one-field pattern as
   `spendFilter.personMatches`. The analytics `FilterBar` adds four
   `FilterCombobox`es (Department, B1, B2, User by display name) plus the
   Unmapped toggle, keeping Editor, Language, search, and the range picker.
   `CopilotAnalyticsPage.filterActive` includes the new fields, so the
   filtered-activity charts respond to them too.

4. **Seat table.** `UserTable` shows `displayName` with login as secondary
   text; name sorting sorts on `displayName`.

## Alternatives rejected

- **Client-side join** (new `/api/people` + web merge): second query,
  duplicated join logic, table/search still need the merged shape anyway.
- **Reusing `/api/spend`**: drags full billing/model rows in for identity, and
  couples pages the architecture keeps apart.

## Error handling

- Empty `github_users` / `jira_people`: every seat comes back
  `displayName = login`, `mapped: false` — page fully usable, comboboxes offer
  only "Unmapped"-style empties. No hard failures.
- Duplicate logins in `github_users`: last row wins (map semantics), same as
  spend today.

## Verification

No test framework (repo rule): `pnpm --filter @dash/shared build` then
`pnpm typecheck`; boot the worktree API on a spare port against local Postgres
and assert `/api/seats` carries the identity fields; replay the web filter
pipeline with a node script against the live payload.
