# GitHub Org Members Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual members-export CSV upload with a daily GraphQL pull of the org's SAML external identities, run by the in-process scheduler and triggerable from the Data sources page.

**Architecture:** A new `CopilotClient`-shaped source (`copilot/members.ts`) pages GitHub's GraphQL `externalIdentities` connection; a new sync service (`services/members-sync.ts`) upserts the result into `github_users` under a new `refresh_jobs` kind `members`. Route, scheduler entry, and Data sources row all follow the existing billing/JIRA patterns exactly.

**Tech Stack:** TypeScript (ESM, `verbatimModuleSyntax`), Fastify, Drizzle ORM + Postgres, zod, React + TanStack Query, tsx for scripts.

## Global Constraints

- **There is no test framework and no linter.** `pnpm typecheck` is the whole automated gate. Verification beyond it is a `tsx` harness script under `apps/api/scripts/`, following `verify-litellm-contract.ts`.
- **`packages/shared` is not watched by `pnpm dev`.** After any change to it run `pnpm --filter @dash/shared build` before `pnpm typecheck`, or both apps typecheck against a stale `dist/`.
- **Money and identity columns are never zero-filled.** Null means unknown.
- **Nothing outside `apps/api/src/copilot/` may know which data source is active.**
- **Strip `"public".` qualifiers from generated migration SQL** — `drizzle-kit` hardcodes them, and the dataset lives in the schema named by `DB_SCHEMA`.
- **Conventional commits** (`feat:`, `fix:`, `chore:`, `docs:`), one per task.
- Source of record: `docs/superpowers/specs/2026-08-03-github-members-sync-design.md`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/types.ts` (modify) | Add `'members'` to `REFRESH_KINDS`. Source of the `refresh_kind` pg enum. |
| `apps/api/drizzle/*.sql` (create, generated) | `ALTER TYPE refresh_kind ADD VALUE 'members'`. |
| `apps/api/src/copilot/members.ts` (create) | GraphQL client. Paging, envelope validation, the four failure rules. Knows nothing about the DB. |
| `apps/api/scripts/verify-members-contract.ts` (create) | Wire-level harness for the above against a throwaway HTTP server. The task's test. |
| `apps/api/src/services/members-sync.ts` (create) | Job wrapper + `github_users` upsert + import-log row. Knows nothing about HTTP. |
| `apps/api/src/routes/refresh.ts` (modify) | `POST /api/refresh/members`. |
| `apps/api/src/scheduler.ts` (modify) | One `SYNCS` entry. |
| `apps/api/src/env.ts` (modify) | `GITHUB_MEMBERS_TOKEN`. |
| `.env.example` (modify) | Document it. |
| `apps/web/src/lib/api.ts` (modify) | `startMembersSync()` POST helper. |
| `apps/web/src/hooks/useCopilotData.ts` (modify) | `SYNC_SOURCES.members` row. |
| `apps/web/src/App.tsx` (modify) | `useSyncJob('members')`, thread to the page. |
| `apps/web/src/components/sources/DataSourcesPage.tsx` (modify) | One `SourceRow`. |

---

### Task 1: Add the `members` refresh kind

**Files:**
- Modify: `packages/shared/src/types.ts:199`
- Create: `apps/api/drizzle/<generated>.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `RefreshKind` now includes `'members'`; the pg enum `refresh_kind` accepts it.

- [ ] **Step 1: Widen the const array**

`packages/shared/src/types.ts`:

```ts
export const REFRESH_KINDS = ['copilot', 'jira', 'billing', 'gateway', 'members'] as const;
```

- [ ] **Step 2: Run the typecheck to see it fail**

```bash
pnpm --filter @dash/shared build && pnpm typecheck
```

Expected: FAIL in `apps/web/src/hooks/useCopilotData.ts` — the `satisfies Record<RefreshKind, SyncSource>` on `SYNC_SOURCES` no longer holds because `members` has no row. This failure is the point: it proves the type gate catches an unwired kind. Task 6 closes it.

- [ ] **Step 3: Generate the enum migration**

```bash
pnpm --filter @dash/api db:generate
```

- [ ] **Step 4: Strip the schema qualifier**

Open the generated `apps/api/drizzle/*.sql` and remove every `"public".` prefix, so the statement reads:

```sql
ALTER TYPE "refresh_kind" ADD VALUE 'members';
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts apps/api/drizzle
git commit -m "feat(shared): add members refresh kind"
```

---

### Task 2: GraphQL members client

**Files:**
- Create: `apps/api/src/copilot/members.ts`
- Modify: `apps/api/src/env.ts` (after `GITHUB_BILLING_TOKEN`, ~line 62)
- Modify: `.env.example` (after `GITHUB_BILLING_TOKEN=`, line 59)
- Test: `apps/api/scripts/verify-members-contract.ts`

The env var lands here rather than with the scheduler because the client reads
`env.GITHUB_MEMBERS_TOKEN` — split across two tasks, this one would not typecheck.

**Interfaces:**
- Consumes: `fetchRetry` from `apps/api/src/copilot/reports.ts`, `env` from `apps/api/src/env.ts`, `moduleLogger` from `apps/api/src/log.ts`.
- Produces:
  ```ts
  export const MAX_NAME_ID_LENGTH = 40;
  export interface OrgMember { login: string; samlNameId: string | null }
  export interface OrgMemberFetch {
    members: OrgMember[];
    unlinkedIdentities: number;
    oversizedNameIds: number;
  }
  export interface MembersClient { name: string; fetchMembers(): Promise<OrgMemberFetch> }
  export function createMembersClient(baseUrl?: string): MembersClient | null;
  ```
  `baseUrl` defaults to `https://api.github.com` and exists so the harness can point the real client at a local server.

- [ ] **Step 1: Add the env var the client reads**

In `apps/api/src/env.ts`, after `GITHUB_BILLING_TOKEN`:

```ts
    /**
     * Token for the org members GraphQL pull. Falls back to GITHUB_TOKEN.
     * Kept separate for the same reason billing is: this one must be
     * authorized for the org's SAML SSO and carry `read:org`, which the
     * enterprise billing PAT usually is not.
     */
    GITHUB_MEMBERS_TOKEN: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().optional(),
    ),
```

No `.refine()` — an unset token disables the sync rather than refusing boot, matching JIRA and the
gateway rather than `COPILOT_SOURCE=github`.

In `.env.example`, after the `GITHUB_BILLING_TOKEN=` line:

```
# Org members sync (login -> saml_name_id). Falls back to GITHUB_TOKEN.
# Needs `read:org` AND the PAT authorized for the org's SAML SSO.
GITHUB_MEMBERS_TOKEN=
```

- [ ] **Step 2: Write the failing harness**

Create `apps/api/scripts/verify-members-contract.ts`. It stands up a throwaway HTTP server answering GitHub's documented GraphQL envelope and drives the real client at it — the same shape as `verify-litellm-contract.ts`, which it should be read alongside.

```ts
/**
 * Contract check for the live members source, `createMembersClient`.
 *
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-members-contract.ts
 *
 * Stands up a throwaway HTTP server answering GitHub's documented GraphQL
 * envelope for `organization.samlIdentityProvider.externalIdentities` and
 * points the real client at it, so the wire-level behaviour — cursor
 * pagination, the auth header, a null identity provider, a null user, an
 * `errors[]` array inside a 200, and the 40-character nameId ceiling — is
 * checked against a server rather than against a reading of the docs.
 *
 * It cannot confirm that GitHub *sends* these shapes. It is also the harness
 * to replay a real captured response through: drop the JSON into a handler
 * and the assertions below become a conformance test of the API.
 *
 * Sits outside apps/api's tsconfig `include`, like its siblings.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMembersClient } from '../src/copilot/members.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
};

interface Captured {
  authorization: string | undefined;
  body: { query: string; variables: Record<string, unknown> };
}

type Handler = (captured: Captured, callIndex: number) => unknown;

interface Fake {
  baseUrl: string;
  calls: Captured[];
  close: () => Promise<void>;
}

async function startFake(handler: Handler): Promise<Fake> {
  const calls: Captured[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const captured: Captured = {
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Captured['body'],
      };
      calls.push(captured);
      const reply = handler(captured, calls.length - 1);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** One `externalIdentities` page. */
function page(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
): unknown {
  return {
    data: {
      organization: { samlIdentityProvider: { externalIdentities: { pageInfo, nodes } } },
    },
  };
}

function identity(login: string | null, nameId: string | null): unknown {
  return {
    samlIdentity: nameId === null ? null : { nameId },
    user: login === null ? null : { login },
  };
}

process.env['GITHUB_ORG'] ??= 'RBCZ-copilots';
process.env['GITHUB_MEMBERS_TOKEN'] ??= 'test-token';

async function main(): Promise<void> {
  console.log('\npagination, auth header, and the happy path');
  {
    const fake = await startFake((_captured, index) =>
      index === 0
        ? page([identity('alice', 'ICZAA001'), identity('bob', 'ICZBB002')], {
            hasNextPage: true,
            endCursor: 'CURSOR-1',
          })
        : page([identity('carol', 'ICZCC003')], { hasNextPage: false, endCursor: null }),
    );
    const client = createMembersClient(fake.baseUrl);
    check(client !== null, 'client is constructed when org and token are set');
    const result = await client!.fetchMembers();
    check(result.members.length === 3, 'both pages are collected');
    check(fake.calls.length === 2, 'paged exactly twice');
    check(
      fake.calls[1]?.body.variables['after'] === 'CURSOR-1',
      'the second request carries the first page endCursor',
    );
    check(
      fake.calls[0]?.authorization === 'Bearer test-token',
      'the token travels as a bearer header',
    );
    check(
      result.members[0]?.login === 'alice' && result.members[0]?.samlNameId === 'ICZAA001',
      'login and nameId map onto OrgMember',
    );
    await fake.close();
  }

  console.log('\na null identity provider is a failure, not an empty org');
  {
    const fake = await startFake(() => ({ data: { organization: { samlIdentityProvider: null } } }));
    const client = createMembersClient(fake.baseUrl);
    let threw = false;
    try {
      await client!.fetchMembers();
    } catch {
      threw = true;
    }
    check(threw, 'samlIdentityProvider: null throws rather than reporting zero members');
    await fake.close();
  }

  console.log('\nan errors[] array inside a 200 is a failure');
  {
    const fake = await startFake(() => ({
      data: { organization: null },
      errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'requires read:org' }],
    }));
    const client = createMembersClient(fake.baseUrl);
    let message = '';
    try {
      await client!.fetchMembers();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check(message.includes('read:org'), "the GraphQL error message is carried, not swallowed");
    await fake.close();
  }

  console.log('\nper-node tolerance');
  {
    const longId = 'X'.repeat(41);
    const fake = await startFake(() =>
      page(
        [
          identity('alice', 'ICZAA001'),
          identity(null, 'ICZZZ999'),
          identity('dave', longId),
          identity('erin', ''),
        ],
        { hasNextPage: false, endCursor: null },
      ),
    );
    const result = await createMembersClient(fake.baseUrl)!.fetchMembers();
    check(result.members.length === 2, 'only the keyable, storable nodes are returned');
    check(result.unlinkedIdentities === 1, 'an identity with no user is counted, not thrown');
    check(result.oversizedNameIds === 1, 'a nameId over 40 chars is counted, never truncated');
    check(
      result.members.some((member) => member.login === 'erin' && member.samlNameId === null),
      'an empty nameId stores as null rather than an empty string',
    );
    await fake.close();
  }

  console.log(failures.length === 0 ? '\nall checks passed' : `\n${failures.length} FAILED`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
```

- [ ] **Step 3: Run it to verify it fails**

```bash
node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-members-contract.ts
```

Expected: FAIL — cannot resolve `../src/copilot/members.js`.

- [ ] **Step 4: Implement the client**

Create `apps/api/src/copilot/members.ts`:

```ts
import { env } from '../env.js';
import { moduleLogger } from '../log.js';
import { fetchRetry } from './reports.js';

/**
 * GitHub org members, read from the GraphQL SAML external-identity connection.
 *
 * The browser's Export button on the org members page posts to the *dotcom*
 * endpoint `github.com/orgs/{org}/members/export`, which needs session cookies
 * and a scraped CSRF token and has no published contract. This reads the
 * supported API instead and returns the same two columns `github_users`
 * stores.
 *
 * Coverage is the trade: `externalIdentities` lists SAML-*linked* identities
 * only, so a member who never linked SSO has no row here at all. The manual
 * CSV import (`POST /api/import/users`) remains the way to load them.
 */

const API_ROOT = 'https://api.github.com';
/** GitHub caps a connection page at 100. */
const PAGE_SIZE = 100;
/** Enough for 20k members; a broken cursor stops here instead of spinning. */
const MAX_PAGES = 200;
/** `github_users.saml_name_id` is varchar(40). */
export const MAX_NAME_ID_LENGTH = 40;

const log = moduleLogger('copilot.members');

const QUERY = `
query ($org: String!, $first: Int!, $after: String) {
  organization(login: $org) {
    samlIdentityProvider {
      externalIdentities(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          samlIdentity { nameId }
          user { login }
        }
      }
    }
  }
}`;

export interface OrgMember {
  login: string;
  /** Null when the identity carries no nameId — unknown, never empty string. */
  samlNameId: string | null;
}

export interface OrgMemberFetch {
  members: OrgMember[];
  /** Identities with no member attached — deprovisioned, or invite never accepted. */
  unlinkedIdentities: number;
  /** nameIds past the column width, skipped rather than truncated. */
  oversizedNameIds: number;
}

export interface MembersClient {
  /** For the job's log context. */
  name: string;
  fetchMembers(): Promise<OrgMemberFetch>;
}

// --- Raw envelope (only the fields we read) --------------------------------

interface RawNode {
  samlIdentity?: { nameId?: string | null } | null;
  user?: { login?: string | null } | null;
}

interface RawResponse {
  data?: {
    organization?: {
      samlIdentityProvider?: {
        externalIdentities?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: (RawNode | null)[];
        };
      } | null;
    } | null;
  };
  errors?: { message?: string; type?: string }[];
}

/**
 * Live client, or null when unconfigured — the same shape as
 * `createJiraClient()`, so the scheduler and the route share one test.
 *
 * `baseUrl` exists for the contract harness in `scripts/`; production callers
 * pass nothing.
 */
export function createMembersClient(baseUrl: string = API_ROOT): MembersClient | null {
  const org = env.GITHUB_ORG;
  const token = env.GITHUB_MEMBERS_TOKEN ?? env.GITHUB_TOKEN;
  if (!org || !token) return null;

  return {
    name: `github-graphql:${org}`,
    fetchMembers: () => fetchMembers(baseUrl, org, token),
  };
}

async function fetchMembers(
  baseUrl: string,
  org: string,
  token: string,
): Promise<OrgMemberFetch> {
  const members: OrgMember[] = [];
  let unlinkedIdentities = 0;
  let oversizedNameIds = 0;
  let after: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body: RawResponse = await post(baseUrl, token, {
      org,
      first: PAGE_SIZE,
      after,
    });

    // GraphQL answers 200 with an `errors` array for auth and scope problems —
    // INSUFFICIENT_SCOPES and SAML enforcement both land here.
    if (body.errors && body.errors.length > 0) {
      throw new Error(
        `GitHub GraphQL error: ${body.errors.map((error) => error.message ?? error.type).join('; ')}`,
      );
    }

    const provider = body.data?.organization?.samlIdentityProvider;
    if (provider === null || provider === undefined) {
      // Either the org has no SSO configured or this token is not authorized
      // for it. Reporting zero members would log a clean sync over a fault.
      throw new Error(
        `GitHub returned no SAML identity provider for ${org} — the org has no SSO configured, or the token is not SSO-authorized`,
      );
    }

    const connection = provider.externalIdentities;
    for (const node of connection?.nodes ?? []) {
      if (!node) continue;
      const login = node.user?.login?.trim();
      if (!login) {
        unlinkedIdentities++;
        continue;
      }
      const rawNameId = node.samlIdentity?.nameId?.trim() ?? '';
      if (rawNameId.length > MAX_NAME_ID_LENGTH) {
        // Truncating would forge an id that joins to the wrong jira_people row.
        oversizedNameIds++;
        continue;
      }
      members.push({ login, samlNameId: rawNameId === '' ? null : rawNameId });
    }

    if (connection?.pageInfo?.hasNextPage !== true) {
      return { members, unlinkedIdentities, oversizedNameIds };
    }
    after = connection.pageInfo.endCursor ?? null;
    if (after === null) {
      log.warn({ dash: { org, page } }, 'hasNextPage without an endCursor — stopping');
      return { members, unlinkedIdentities, oversizedNameIds };
    }
  }

  throw new Error(`GitHub member paging exceeded ${MAX_PAGES} pages for ${org}`);
}

async function post(
  baseUrl: string,
  token: string,
  variables: Record<string, unknown>,
): Promise<RawResponse> {
  const response = await fetchRetry(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: QUERY, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    log.error(
      {
        'event.outcome': 'failure',
        'url.domain': 'api.github.com',
        'url.path': '/graphql',
        'http.response.status_code': response.status,
        dash: {
          githubSso: response.headers.get('x-github-sso'),
          body: text.slice(0, 200),
        },
      },
      'github graphql request rejected',
    );
    throw new Error(`GitHub ${response.status} on /graphql: ${text.slice(0, 200)}`);
  }

  return (await response.json()) as RawResponse;
}
```

- [ ] **Step 5: Run the harness to verify it passes**

```bash
node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-members-contract.ts
pnpm --filter @dash/api typecheck
```

Expected: `all checks passed`, exit 0; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/copilot/members.ts apps/api/scripts/verify-members-contract.ts apps/api/src/env.ts .env.example
git commit -m "feat(api): read org members from the GitHub GraphQL SAML identity connection"
```

---

### Task 3: Members sync service

**Files:**
- Create: `apps/api/src/services/members-sync.ts`
- Reference: `apps/api/src/services/jira-sync.ts` (the pattern this mirrors)

**Interfaces:**
- Consumes: `createMembersClient`, `OrgMember` from Task 2; `startJob` from `services/refresh.js`; `recordImport` from `services/import-log.js`; `githubUsers` from `db/schema.js`.
- Produces:
  ```ts
  export class MembersSyncUnavailableError extends Error {}
  export function startMembersSync(): Promise<RefreshJob>;
  ```

- [ ] **Step 1: Write the service**

```ts
import { sql } from 'drizzle-orm';
import type { RefreshJob } from '@dash/shared';
import { createMembersClient } from '../copilot/members.js';
import type { OrgMember } from '../copilot/members.js';
import { db } from '../db/client.js';
import { githubUsers } from '../db/schema.js';
import { eventDuration, moduleLogger } from '../log.js';
import { recordImport } from './import-log.js';
import { startJob } from './refresh.js';

const log = moduleLogger('services.members-sync');

/** GitHub org/token env is unset — the route answers 503. */
export class MembersSyncUnavailableError extends Error {
  constructor() {
    super('Member sync is not configured — set GITHUB_ORG and GITHUB_MEMBERS_TOKEN');
  }
}

/** Rows per multi-row upsert statement — 2 columns each, well under the param cap. */
const CHUNK_SIZE = 500;

/**
 * Distinguishes a pulled run from an uploaded file on the Imports page.
 * `recordImport` defaults an absent filename to `upload.csv`, which would make
 * the two indistinguishable.
 */
const SYNC_FILENAME = 'github-graphql-sync';

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Starts an org member sync (refresh_jobs kind `members`) and returns the job
 * to poll — single-flight per kind, concurrent with every other sync.
 *
 * Rows are only ever upserted. A login that stops appearing left the org,
 * unlinked SSO, or fell out of a partial page, and one response cannot tell
 * those apart — so its row and its saml id stay, and historical billing spend
 * remains attributable to a person. `active` is left alone: it means "seen in
 * a billing report" and belongs to the billing import, not to membership.
 *
 * On failure the job is marked `failed` and every existing row is untouched,
 * the same delete-nothing-on-failure spirit as the seat refresh.
 */
export async function startMembersSync(): Promise<RefreshJob> {
  const client = createMembersClient();
  if (client === null) throw new MembersSyncUnavailableError();

  return startJob('members', {
    action: 'members-sync',
    context: { membersSource: client.name },
    run: async () => {
      const startedAt = Date.now();
      let fetched;
      try {
        fetched = await client.fetchMembers();
      } catch (error) {
        await recordImport({
          slot: 'users',
          filename: SYNC_FILENAME,
          rowCount: 0,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // Two identities can resolve to one login after an SSO re-link, and one
      // upsert statement touching the same conflict target twice is a Postgres
      // error (SQLSTATE 21000). Last wins, matching upsert semantics.
      const members: OrgMember[] = [
        ...new Map(fetched.members.map((member) => [member.login, member])).values(),
      ];

      for (const batch of chunk(members, CHUNK_SIZE)) {
        await db
          .insert(githubUsers)
          .values(batch)
          .onConflictDoUpdate({
            target: githubUsers.login,
            set: {
              // A member with no linked identity means *unknown*, and unknown
              // must not erase a value the CSV import already established.
              samlNameId: sql`coalesce(excluded.saml_name_id, ${githubUsers.samlNameId})`,
              syncedAt: sql`now()`,
            },
          });
      }

      log.info(
        {
          'event.action': 'members-sync',
          'event.outcome': 'success',
          'event.duration': eventDuration(startedAt),
          dash: {
            members: members.length,
            unlinkedIdentities: fetched.unlinkedIdentities,
            oversizedNameIds: fetched.oversizedNameIds,
          },
        },
        'org member sync finished',
      );

      await recordImport({
        slot: 'users',
        filename: SYNC_FILENAME,
        rowCount: members.length,
        status: 'succeeded',
        error: null,
      });

      return members.length;
    },
  });
}
```

- [ ] **Step 2: Verify the `startJob` runner signature matches**

Read `apps/api/src/services/refresh.ts` around `startJob` and `JobRunner`, and `services/jira-sync.ts:41-46` for a working call site. If `context` or the `run` return type differ from the code above, match the existing signature rather than changing `refresh.ts`.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @dash/api typecheck
```

Expected: PASS (the web failure from Task 1 is in a different package and does not block this).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/members-sync.ts
git commit -m "feat(api): upsert GitHub org members into github_users on a members refresh job"
```

---

### Task 4: Refresh route

**Files:**
- Modify: `apps/api/src/routes/refresh.ts`

**Interfaces:**
- Consumes: `startMembersSync`, `MembersSyncUnavailableError` from Task 3.
- Produces: `POST /api/refresh/members` → `202 { job }` / `503 { error }`.

- [ ] **Step 1: Add the import**

```ts
import { MembersSyncUnavailableError, startMembersSync } from '../services/members-sync.js';
```

- [ ] **Step 2: Add the route, directly after the billing route**

```ts
  /**
   * Kick off an org member sync (kind `members`) — the scheduled 07:00 run
   * uses the same entry point. 503 while GITHUB_ORG or a token is unset.
   */
  app.post('/api/refresh/members', async (_request, reply) => {
    try {
      const job = await startMembersSync();
      return reply.code(202).send({ job });
    } catch (error) {
      if (error instanceof MembersSyncUnavailableError) {
        return reply.code(503).send({ error: error.message });
      }
      throw error;
    }
  });
```

`GET /api/refresh/latest?kind=members` needs no change — `latestQuery` already validates against `REFRESH_KINDS`.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @dash/api typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/refresh.ts
git commit -m "feat(api): expose POST /api/refresh/members"
```

---

### Task 5: Scheduler

**Files:**
- Modify: `apps/api/src/scheduler.ts:105-129`

**Interfaces:**
- Consumes: `startMembersSync` from Task 3; `env.GITHUB_MEMBERS_TOKEN` from Task 2.
- Produces: the daily 07:00 run fires the members sync.

- [ ] **Step 1: Add the scheduler entry**

In `apps/api/src/scheduler.ts`, import `startMembersSync` and insert this entry into `SYNCS` **before** the `jira-sync` entry:

```ts
  {
    name: 'members-sync',
    disabledReason: () =>
      env.GITHUB_ORG && (env.GITHUB_MEMBERS_TOKEN || env.GITHUB_TOKEN)
        ? null
        : 'GITHUB_ORG and GITHUB_MEMBERS_TOKEN (or GITHUB_TOKEN) are not set',
    start: startMembersSync,
  },
```

Also extend the module docstring's list of pulls to name the member sync. Ordering before `jira-sync` is intent only, not a guarantee: `startJob` returns once the job row is inserted and runs the body detached, so JIRA still resolves this morning's new logins tomorrow morning. That one-day lag is accepted — do not add cross-sync chaining.

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @dash/api typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/scheduler.ts
git commit -m "feat(api): run the org member sync on the daily 07:00 schedule"
```

---

### Task 6: Web wiring and Data sources row

**Files:**
- Modify: `apps/web/src/api/client.ts:207-210`
- Modify: `apps/web/src/hooks/useCopilotData.ts:195-204`
- Modify: `apps/web/src/App.tsx:52-55,78`
- Modify: `apps/web/src/components/sources/DataSourcesPage.tsx:136-143,225-250`

**Interfaces:**
- Consumes: `POST /api/refresh/members` from Task 4; `RefreshKind` including `'members'` from Task 1.
- Produces: closes the `satisfies Record<RefreshKind, SyncSource>` failure Task 1 opened.

- [ ] **Step 1: Add the API helper**

In `apps/web/src/api/client.ts`, directly after `startBillingSync`:

```ts
export async function startMembersSync(): Promise<RefreshJob> {
  const { job } = await request<{ job: RefreshJob }>('/refresh/members', { method: 'POST' });
  return job;
}
```

(`request` prefixes the API base and `/api`, which is why the path here is `/refresh/members`.)

- [ ] **Step 2: Register the sync source**

In `apps/web/src/hooks/useCopilotData.ts`, import `startMembersSync` and add to `SYNC_SOURCES`:

```ts
  // Writes github_users — the identity join behind both the seat roster and
  // the spend payload's department and manager columns.
  members: { start: startMembersSync, invalidates: ['seats', 'spend'] },
```

- [ ] **Step 3: Thread it through `App.tsx`**

```ts
  const members = useSyncJob('members');
```

and

```tsx
  <DataSourcesPage
    copilot={copilot}
    billing={billing}
    jira={jira}
    gateway={gateway}
    members={members}
  />
```

- [ ] **Step 4: Render the row**

In `DataSourcesPage.tsx`, add `members: UseSyncJob` to `DataSourcesPageProps`, destructure it as the others are, add `const membersJobQuery = useLatestJob('members');` / `const membersJob = membersJobQuery.data ?? null;` / `const membersState = syncState(membersJob, isMembersSyncing);`, and add this `SourceRow` inside the `GITHUB COPILOT` group after the billing row:

```tsx
        <SourceRow
          name="GitHub org members"
          fields="login · saml_name_id"
          note="Runs on its own every day at 07:00; Sync pulls it now."
          state={membersState}
          status={statusText(membersState, membersJob)}
          error={errorFor(membersError, membersJob)}
          action={
            <button
              type="button"
              className={styles.connect}
              aria-label="Sync GitHub org members"
              onClick={() => syncMembers()}
              disabled={isMembersSyncing}
            >
              {isMembersSyncing ? 'Syncing…' : 'Sync'}
            </button>
          }
        />
```

- [ ] **Step 5: Full typecheck**

```bash
pnpm --filter @dash/shared build && pnpm typecheck
```

Expected: PASS across all three packages — this is the first point since Task 1 that the whole repo typechecks.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): add the GitHub org members source to the Data sources page"
```

---

### Task 7: Documentation and final gate

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md` (only if it carries an env table — check first)

- [ ] **Step 1: Record the source in `CLAUDE.md`**

Add to the Architecture section, near the refresh/job paragraph:

> **Org membership is a fifth data pull.** `apps/api/src/copilot/members.ts` reads GitHub's GraphQL
> `organization.samlIdentityProvider.externalIdentities` — the supported twin of the members page's
> Export button, which posts to the *dotcom* `orgs/{org}/members/export` and needs session cookies and a
> scraped CSRF token. `services/members-sync.ts` upserts it into `github_users` under `refresh_jobs`
> kind `members`. Rows are never deleted and `active` is never touched: a login that stops appearing
> left the org, unlinked SSO, or fell out of a partial page, and one response cannot tell those apart,
> so departed members stay joinable to their historical spend. The nameId is written through
> `coalesce(excluded, existing)` because a member with no linked identity is *unknown*, and unknown must
> not erase what the CSV import established. `externalIdentities` covers SAML-linked members only, which
> is why `POST /api/import/users` stays as the manual path for everyone else.

- [ ] **Step 2: Run the whole gate**

```bash
pnpm --filter @dash/shared build
pnpm typecheck
node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-members-contract.ts
```

Expected: typecheck clean, harness `all checks passed`.

- [ ] **Step 3: Commit and open the PR**

```bash
git add CLAUDE.md
git commit -m "docs: record the org members sync"
git push -u origin worktree-members-sync
gh pr create --title "feat: sync GitHub org members via the API" --body "..."
```

---

## Deferred to a live token

The harness proves the client handles the documented shape, not that GitHub sends it. Once a PAT with
`read:org` and SSO authorization for `RBCZ-copilots` exists:

1. `POST /api/refresh/members`, then `GET /api/refresh/latest?kind=members`.
2. Compare `select count(*) from github_users where saml_name_id is not null` against the row count of
   the most recent manual CSV export. A materially smaller number is the expected SSO-coverage gap, not
   a bug — check it against the org's "SSO not linked" member filter on github.com.
3. Read the sync's log line for `unlinkedIdentities` and `oversizedNameIds`. A non-zero
   `oversizedNameIds` means this org's nameIds are emails, and `saml_name_id` needs widening past
   `varchar(40)` in a follow-up.
