# GitHub org members sync — design

**Date:** 2026-08-03
**Status:** approved, ready for implementation plan

## Problem

`github_users` (login → `saml_name_id`) is populated only by a manual CSV upload. A human opens the
org's members page on github.com, clicks Export, waits for the export job, downloads the CSV, and
posts it to `POST /api/import/users`. Every identity-dependent read — the JIRA join in
`services/identity.ts`, the department and manager columns, the spend-by-cost-centre pages — is
therefore only as current as the last time somebody remembered to do that.

The pull must run daily on its own and be triggerable from the Data sources page, like every other
data source in the app.

## Source decision

The browser's Export button posts to `https://github.com/orgs/{org}/members/export` — the **dotcom web
UI**, not `api.github.com`. Replicating it requires browser session cookies (`user_session`,
`_gh_sess`) plus an `authenticity_token` CSRF value scraped from the members page, then polling an
export job and downloading the result. The contract is unpublished, and the cookies expire in weeks.

This design uses the **GraphQL API** instead:

```graphql
query ($org: String!, $after: String) {
  organization(login: $org) {
    samlIdentityProvider {
      externalIdentities(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          samlIdentity { nameId }
          user { login }
        }
      }
    }
  }
}
```

It returns exactly the two columns `github_users` stores, needs no cookies and no polling, and is a
published contract. Its one cost is coverage: `externalIdentities` lists **SAML-linked** identities
only, so an org member who never linked SSO has no row at all, where the CSV export lists them with a
blank `saml_name_id`. The manual upload therefore stays in place as the fallback for that population
(§7).

Requires a PAT with `read:org` that is **authorized for the org's SAML SSO**.

## 1. Source client — `apps/api/src/copilot/members.ts`

```ts
export interface OrgMember {
  login: string;
  samlNameId: string | null;
}

export interface OrgMemberFetch {
  members: OrgMember[];
  /** Identities with no member attached — deprovisioned, or invite never accepted. */
  unlinkedIdentities: number;
  /** nameIds longer than the 40-char column, skipped rather than truncated. */
  oversizedNameIds: number;
}

export interface MembersClient {
  /** For the job's log context, like the JIRA client's. */
  name: string;
  fetchMembers(): Promise<OrgMemberFetch>;
}

export function createMembersClient(): MembersClient | null;
```

Returns `null` when `GITHUB_ORG` or a token is missing, mirroring `createJiraClient()`.

`unlinkedIdentities` and `oversizedNameIds` are **logged only** — one structured log line at the end
of a sync. They are not written to the job row, not returned by any route, and not rendered on the
Data sources page.

Pages on `pageInfo.hasNextPage` at 100 nodes a request, capped at 200 pages so a broken cursor cannot
spin forever. `nameId` is trimmed; an empty string stores as null.

Four failure rules, because GraphQL answers `200` for most of them:

| Condition | Handling | Why |
|---|---|---|
| `samlIdentityProvider === null` | throw | Org has no SSO, or the token is not SSO-authorized. A successful sync of zero people would hide a config fault. |
| `errors[]` in a `200` body | throw, carrying the message | Where `INSUFFICIENT_SCOPES` and SAML-enforcement rejections land. |
| `node.user === null` | skip, count as `unlinkedIdentities` | Identity exists, no member attached. Nothing to key a row on. |
| `nameId.length > 40` | skip, count as `oversizedNameIds` | The column is `varchar(40)`. A truncated id silently joins to the wrong `jira_people` row — worse than absent. |

Retry and auth-header handling follow `apps/api/src/copilot/github.ts`.

## 2. Sync service — `apps/api/src/services/members-sync.ts`

A direct mirror of `services/jira-sync.ts`:

- `MembersSyncUnavailableError` — thrown when the client is `null`; the route maps it to `503`.
- `startMembersSync(): Promise<RefreshJob>` → `startJob('members', { action: 'members-sync', … })`.
  Single-flight per kind, concurrent with every other sync.
- Chunked upserts of 500 rows.
- Dedupe by login, last wins. Two identities can resolve to one login after an SSO re-link, and one
  upsert statement touching the same conflict target twice is a Postgres error (SQLSTATE 21000) —
  the same trap `jira-sync.ts` already documents.

### Upsert semantics

```sql
ON CONFLICT (login) DO UPDATE SET
  saml_name_id = coalesce(excluded.saml_name_id, github_users.saml_name_id),
  synced_at    = now()
```

Three rules, each load-bearing:

- **Nothing is ever deleted.** A login that stops appearing in the response left the org, unlinked
  SSO, or fell out of a partial page — three things one response cannot tell apart. Its row and its
  `saml_name_id` stay so historical billing spend remains joinable to a person.
- **`active` is untouched.** That flag means "seen in a billing report" and belongs to the billing
  import, per its schema comment. Membership is not activity.
- **`coalesce`, not `excluded`.** A member present with no linked identity means *unknown*, and
  unknown must not erase a value the CSV upload already established. The cost is that someone who
  genuinely unlinks SSO keeps a stale id until a new one replaces it — the correct trade under the
  repo's null-means-unknown invariant.

### Import-log row

On success the sync also writes an `import_log` row: `slot: 'users'`, `rowCount` = members upserted,
`status: 'succeeded'`. On failure it writes the same row with `status: 'failed'` and the error.

`filename` is passed explicitly as `github-graphql-sync` rather than left undefined — `recordImport`
defaults an absent filename to `upload.csv`, which would make a pull indistinguishable from an
upload on the Imports page.

This means `github_users` has two audit trails, deliberately: `refresh_jobs` answers "did the
scheduled sync run", and the Imports page answers "when did anything last change this table" without
a months-old upload sitting there as the most recent event.

## 3. Shared contract and migration

`REFRESH_KINDS` in `packages/shared/src/types.ts` gains `'members'`. That array is the source of the
Postgres `refresh_kind` enum, so `pnpm db:generate` emits an `ALTER TYPE … ADD VALUE`; the generated
`"public".` qualifier is stripped per the CLAUDE.md gotcha, since the dataset lives in the schema
named by `DB_SCHEMA`.

## 4. Route — `apps/api/src/routes/refresh.ts`

```
POST /api/refresh/members  →  202 { job }
                              503 { error } when unconfigured
```

Identical in shape to `POST /api/refresh/billing`. `GET /api/refresh/latest?kind=members` needs no
change — it already validates against `REFRESH_KINDS`.

## 5. Scheduler — `apps/api/src/scheduler.ts`

One new `SYNCS` entry:

```ts
{
  name: 'members-sync',
  disabledReason: () =>
    env.GITHUB_ORG && (env.GITHUB_MEMBERS_TOKEN || env.GITHUB_TOKEN)
      ? null
      : 'GITHUB_ORG and GITHUB_MEMBERS_TOKEN (or GITHUB_TOKEN) are not set',
  start: startMembersSync,
}
```

Placed **before** `jira-sync` in the array, which buys ordering in intent only and not in fact:
`startJob` returns once the job row is inserted and runs the body detached, so JIRA still resolves
this morning's new logins tomorrow morning. No cross-sync chaining is added — a one-day lag on a
newly-joined member's department is not worth coupling two independent syncs.

## 6. Web — `apps/web/src/components/sources/DataSourcesPage.tsx`

`useSyncJob('members')` and `useLatestJob('members')` in `App`, threaded through as a new
`DataSourcesPageProps` field, rendering one `SourceRow` inside the existing `GITHUB COPILOT` group:

- name: `GitHub org members`
- fields: `login · saml_name_id`
- note: `Runs on its own every day at 07:00; Sync pulls it now.`

Same `syncState` / `statusText` / `errorFor` plumbing as the billing row. No new component.

## 7. Manual CSV upload is unchanged

`POST /api/import/users`, `parseUserExport`, and the Imports page's users slot all stay exactly as
they are. They remain the only way to load the members GraphQL cannot see (never linked SSO) and the
fallback for a token outage or a revoked SSO authorization.

## 8. Environment

`GITHUB_MEMBERS_TOKEN` — optional, falling back to `GITHUB_TOKEN`, the same shape and the same
`z.preprocess` empty-string handling as `GITHUB_BILLING_TOKEN`. No `.refine()` is added: an unset
token disables the sync rather than refusing boot, matching JIRA and the gateway rather than
`COPILOT_SOURCE=github`.

`.env.example` gains the variable with a comment stating the requirement: `read:org`, and the PAT
authorized for the org's SAML SSO.

## 9. Verification

The repo has no test framework and no linter; `pnpm typecheck` is the gate, and `packages/shared`
must be rebuilt first for the new `REFRESH_KINDS` value to be visible to both apps.

Beyond that, `apps/api/scripts/verify-members-contract.ts`, following the
`verify-litellm-contract.ts` precedent: drives the client against a throwaway HTTP server serving
the documented GraphQL envelope and covering

- cursor pagination across more than one page,
- `samlIdentityProvider: null`,
- a node with `user: null`,
- an `errors[]` array in a `200` body,
- a `nameId` longer than 40 characters,
- an empty-string `nameId` storing as null.

As with the LiteLLM harness, this proves the client handles the documented shape, not that GitHub
sends it. Validation against the live `RBCZ-copilots` org is a manual step once the token exists.

## Out of scope

- Any use of the dotcom `members/export` endpoint, cookies, or CSRF tokens.
- Listing members who have not linked SSO (would need `GET /orgs/{org}/members` as a second source).
- Detecting or recording departures — explicitly rejected; rows persist so historical spend stays
  attributable.
- Changing what `active` means or who writes it.
