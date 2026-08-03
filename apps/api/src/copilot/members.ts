import { env } from '../env.js';
import { moduleLogger } from '../log.js';
import { fetchRetry } from './reports.js';

/**
 * GitHub org members, read from the GraphQL SAML external-identity connection.
 *
 * The Export button on the org members page posts to the *dotcom* endpoint
 * `github.com/orgs/{org}/members/export`, which needs browser session cookies
 * and a scraped CSRF token, polls an export job, and has no published
 * contract. This reads the supported API instead and returns the same two
 * columns `github_users` stores.
 *
 * Coverage is the trade: `externalIdentities` lists SAML-*linked* identities
 * only, so an org member who never linked SSO has no row here at all, where
 * the CSV export lists them with a blank saml id. `POST /api/import/users`
 * remains the way to load that population.
 *
 * Needs a PAT carrying `read:org` that is authorised for the org's SAML SSO.
 */

const API_ROOT = 'https://api.github.com';
/** GitHub caps a connection page at 100. */
const PAGE_SIZE = 100;
/** Enough for 20k members; a broken cursor stops here rather than spinning. */
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
  /** Null when the identity carries no nameId — unknown, never an empty string. */
  samlNameId: string | null;
}

export interface OrgMemberFetch {
  members: OrgMember[];
  /** Identities with no member attached — deprovisioned, or an invite never accepted. */
  unlinkedIdentities: number;
  /** nameIds past the column width, skipped rather than truncated. */
  oversizedNameIds: number;
}

export interface MembersClient {
  /** For the job's log context. */
  name: string;
  fetchMembers(): Promise<OrgMemberFetch>;
}

// --- Raw envelope (only the fields we read) ---------------------------------

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
 * The live client, or null when unconfigured — the same shape as
 * `createJiraClient()`, so the scheduler's skip and the route's 503 share one
 * test.
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
    const body = await post(baseUrl, token, { org, first: PAGE_SIZE, after });

    // GraphQL answers 200 with an `errors` array for auth and scope problems —
    // INSUFFICIENT_SCOPES and SAML enforcement both land here, not in a 4xx.
    if (body.errors && body.errors.length > 0) {
      const detail = body.errors
        .map((error) => error.message ?? error.type ?? 'unknown error')
        .join('; ');
      throw new Error(`GitHub GraphQL error: ${detail}`);
    }

    const provider = body.data?.organization?.samlIdentityProvider;
    if (provider === null || provider === undefined) {
      // Either the org has no SSO configured or this token is not authorised
      // for it. Reporting zero members would file a clean sync over a fault.
      throw new Error(
        `GitHub returned no SAML identity provider for ${org} — the org has no SSO configured, or the token is not SSO-authorised`,
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

      const nameId = node.samlIdentity?.nameId?.trim() ?? '';
      if (nameId.length > MAX_NAME_ID_LENGTH) {
        // Truncating would forge an id that joins to the wrong jira_people row,
        // which is worse than the member being absent.
        oversizedNameIds++;
        continue;
      }

      members.push({ login, samlNameId: nameId === '' ? null : nameId });
    }

    if (connection?.pageInfo?.hasNextPage !== true) {
      return { members, unlinkedIdentities, oversizedNameIds };
    }

    after = connection.pageInfo.endCursor ?? null;
    if (after === null) {
      log.warn(
        { dash: { org, page, members: members.length } },
        'hasNextPage without an endCursor — stopping the walk',
      );
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
