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

/** Rows per multi-row upsert statement — 2 columns each, far under the param cap. */
const CHUNK_SIZE = 500;

/**
 * Distinguishes a pulled run from an uploaded file on the Imports page:
 * `recordImport` defaults an absent filename to `upload.csv`, which would make
 * the two indistinguishable in the history.
 */
const SYNC_FILENAME = 'github-graphql-sync';

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts an org member sync (refresh_jobs kind `members`) and returns the job
 * to poll — single-flight per kind, concurrent with every other sync. This is
 * what replaced the manual members-export CSV upload; `POST /api/import/users`
 * stays as the path for the members GraphQL cannot see (never linked SSO).
 *
 * Rows are only ever upserted. A login that stops appearing left the org,
 * unlinked SSO, or fell out of a partial page, and one response cannot tell
 * those apart — so its row and its saml id stay, and historical billing spend
 * remains attributable to a person. `active` is left alone: that flag means
 * "seen in a billing report" and belongs to the billing import; membership is
 * not activity.
 *
 * On failure the job is marked `failed` and every existing row is untouched —
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
          error: errorMessage(error),
        });
        throw error;
      }

      // Two identities can resolve to one login after an SSO re-link, and a
      // single upsert statement touching the same conflict target twice is a
      // Postgres error (SQLSTATE 21000). Last wins, matching upsert semantics.
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
            // Logged and nowhere else: a non-zero oversizedNameIds means this
            // org's nameIds are emails and the column needs widening.
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
