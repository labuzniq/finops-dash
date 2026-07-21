import { isNotNull, sql } from 'drizzle-orm';
import type { RefreshJob } from '@dash/shared';
import { db } from '../db/client.js';
import { githubUsers, jiraPeople } from '../db/schema.js';
import { createJiraClient } from '../jira/client.js';
import { moduleLogger } from '../log.js';
import { startJob } from './refresh.js';

const log = moduleLogger('services.jira-sync');

/** JIRA env is unset (and the mock source is not active) — the route answers 503. */
export class JiraSyncUnavailableError extends Error {
  constructor() {
    super('JIRA sync is not configured — set JIRA_BASE_URL and JIRA_TOKEN');
  }
}

/** Rows per multi-row upsert statement — 8 columns each, well under the param cap. */
const CHUNK_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Starts a JIRA identity sync (refresh_jobs kind `jira`) and returns the job
 * to poll — single-flight per kind, concurrent with a Copilot refresh.
 *
 * The sync resolves every distinct saml id in `github_users` against JIRA
 * Insight and upserts `jira_people`. Ids with no hit are simply left absent —
 * their logins render unmapped. On failure the job is marked `failed` and the
 * previously synced rows stay untouched: identity is stale-tolerant, the same
 * delete-nothing-on-failure spirit as the seat refresh.
 */
export async function startJiraSync(): Promise<RefreshJob> {
  const client = createJiraClient();
  if (client === null) throw new JiraSyncUnavailableError();

  return startJob('jira', {
    action: 'jira-sync',
    context: { jiraSource: client.name },
    run: async () => {
      const rows = await db
        .selectDistinct({ samlNameId: githubUsers.samlNameId })
        .from(githubUsers)
        .where(isNotNull(githubUsers.samlNameId));
      const samlIds = rows
        .map((row) => row.samlNameId)
        .filter((id): id is string => id !== null)
        .sort();

      log.debug({ dash: { samlIds: samlIds.length } }, 'resolving saml ids against JIRA');
      const people = await client.fetchPeople(samlIds);

      for (const batch of chunk(people, CHUNK_SIZE)) {
        await db
          .insert(jiraPeople)
          .values(batch)
          .onConflictDoUpdate({
            target: jiraPeople.samlNameId,
            set: {
              firstName: sql`excluded.first_name`,
              lastName: sql`excluded.last_name`,
              department: sql`excluded.department`,
              b1Manager: sql`excluded.b1_manager`,
              b2Manager: sql`excluded.b2_manager`,
              jiraUserId: sql`excluded.jira_user_id`,
              syncedAt: sql`now()`,
            },
          });
      }

      return people.length;
    },
  });
}
