import { env } from '../env.js';
import { buildMockIdentity } from '../copilot/mock.js';
import { moduleLogger } from '../log.js';

/**
 * JIRA Insight (Assets) client — the identity source behind the spend view.
 *
 * People are fetched in batches via IQL over the Person object type and parsed
 * into flat rows keyed by SAML name id. The app only ever calls this from the
 * on-demand sync job (services/jira-sync.ts); reads always hit Postgres.
 */

const log = moduleLogger('jira.client');

/** One parsed Person entry. `samlNameId` is uppercased — it is the jira_people PK. */
export interface JiraPerson {
  samlNameId: string;
  firstName: string | null;
  lastName: string | null;
  department: string | null;
  b1Manager: string | null;
  b2Manager: string | null;
  jiraUserId: string | null;
}

/** A source of JIRA people. Implemented by the live Insight API and the mock. */
export interface JiraClient {
  readonly name: string;
  /** Fetch people for the given SAML ids (matched case-insensitively). */
  fetchPeople(samlIds: string[]): Promise<JiraPerson[]>;
}

// --- IQL response parsing ----------------------------------------------------

/**
 * Insight object-type attribute ids for the Person schema. Confirmed against
 * the sample response (docs/reports/jira-iql.json): 9010824 is Department Name,
 * not Last Name as an earlier draft of the request had it.
 */
const ATTR = {
  firstName: 9010057,
  lastName: 9010056,
  department: 9010824,
  userId: 9010054,
  b1Manager: 9015211,
  b2Manager: 9015212,
  /** The `icza` attribute — the SAML name id, lowercase in JIRA. */
  saml: 9010917,
} as const;

interface RawAttributeValue {
  value?: unknown;
  referencedObject?: { label?: unknown };
}

interface RawAttribute {
  objectTypeAttributeId?: unknown;
  objectAttributeValues?: RawAttributeValue[];
}

interface RawEntry {
  attributes?: RawAttribute[];
}

interface RawIqlResponse {
  objectEntries?: RawEntry[];
}

function firstValue(attribute: RawAttribute | undefined): string | null {
  const value = attribute?.objectAttributeValues?.[0]?.value;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Managers are references — the person's display label, verbatim. */
function firstLabel(attribute: RawAttribute | undefined): string | null {
  const label = attribute?.objectAttributeValues?.[0]?.referencedObject?.label;
  return typeof label === 'string' && label !== '' ? label : null;
}

/**
 * Parse one IQL response page into people. Entries without a SAML id are
 * skipped — there is nothing to key them on. Pure; exported for verification
 * and reuse.
 */
export function parseIqlResponse(payload: unknown): JiraPerson[] {
  const entries = (payload as RawIqlResponse).objectEntries ?? [];
  const people: JiraPerson[] = [];

  for (const entry of entries) {
    const byId = new Map<number, RawAttribute>();
    for (const attribute of entry.attributes ?? []) {
      if (typeof attribute.objectTypeAttributeId === 'number') {
        byId.set(attribute.objectTypeAttributeId, attribute);
      }
    }

    const saml = firstValue(byId.get(ATTR.saml));
    if (saml === null) continue;

    people.push({
      samlNameId: saml.toUpperCase(),
      firstName: firstValue(byId.get(ATTR.firstName)),
      lastName: firstValue(byId.get(ATTR.lastName)),
      department: firstValue(byId.get(ATTR.department)),
      b1Manager: firstLabel(byId.get(ATTR.b1Manager)),
      b2Manager: firstLabel(byId.get(ATTR.b2Manager)),
      jiraUserId: firstValue(byId.get(ATTR.userId)),
    });
  }

  return people;
}

// --- Live client -------------------------------------------------------------

/** Ids per IQL `IN (…)` call. */
const CHUNK_SIZE = 50;
/** Comfortably above CHUNK_SIZE so an IQL page never truncates a chunk. */
const RESULTS_PER_PAGE = 100;

const OBJECT_SCHEMA_ID = 9_000_001;
const PERSON_OBJECT_TYPE_ID = 9_000_005;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export class InsightJiraClient implements JiraClient {
  readonly name = 'insight';

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async query(iqlCondition: string): Promise<JiraPerson[]> {
    const iql = `ObjectTypeId=${PERSON_OBJECT_TYPE_ID} AND Status=Active AND ${iqlCondition}`;
    const url =
      `${this.baseUrl.replace(/\/$/, '')}/rest/insight/1.0/iql/objects` +
      `?objectSchemaId=${OBJECT_SCHEMA_ID}&includeAttributesDeep=1` +
      `&resultPerPage=${RESULTS_PER_PAGE}&iql=${encodeURIComponent(iql)}`;

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
    });
    if (!response.ok) {
      throw new JiraRequestError(response.status, `JIRA IQL request failed with ${response.status}`);
    }
    return parseIqlResponse(await response.json());
  }

  async fetchPeople(samlIds: string[]): Promise<JiraPerson[]> {
    const people: JiraPerson[] = [];
    // Some Insight versions reject `IN` — detected on the first 400, after
    // which every remaining chunk goes one id at a time.
    let useIn = true;

    for (const ids of chunk(samlIds, CHUNK_SIZE)) {
      if (useIn) {
        try {
          people.push(...(await this.query(`icza IN (${ids.join(',')})`)));
          continue;
        } catch (error) {
          if (!(error instanceof JiraRequestError) || error.status !== 400) throw error;
          useIn = false;
          log.warn(
            { dash: { chunkSize: ids.length } },
            'JIRA rejected IQL IN — falling back to one call per id',
          );
        }
      }
      for (const id of ids) {
        people.push(...(await this.query(`icza=${id}`)));
      }
    }

    return people;
  }
}

export class JiraRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- Mock client -------------------------------------------------------------

/**
 * Deterministic people for the mock roster — the JIRA leg of
 * `COPILOT_SOURCE=mock`. Only ids actually asked for are returned, matching
 * how a live sync resolves the distinct saml ids found in github_users.
 */
export class MockJiraClient implements JiraClient {
  readonly name = 'mock';

  async fetchPeople(samlIds: string[]): Promise<JiraPerson[]> {
    const byId = new Map(buildMockIdentity().people.map((p) => [p.samlNameId, p]));
    const people: JiraPerson[] = [];
    for (const id of samlIds) {
      const person = byId.get(id.toUpperCase());
      if (person) people.push(person);
    }
    return people;
  }
}

/**
 * Picks the identity source: the live Insight API when JIRA env is set, the
 * seeded mock when the app runs on the mock Copilot source, otherwise null —
 * the sync route answers 503.
 */
export function createJiraClient(): JiraClient | null {
  if (env.JIRA_BASE_URL && env.JIRA_TOKEN) {
    return new InsightJiraClient(env.JIRA_BASE_URL, env.JIRA_TOKEN);
  }
  if (env.COPILOT_SOURCE === 'mock') return new MockJiraClient();
  return null;
}
