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

/** "First Last" when the JIRA join hit, the raw login otherwise. */
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
