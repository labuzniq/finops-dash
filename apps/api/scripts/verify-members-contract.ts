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
 * It cannot confirm that GitHub *sends* these shapes; that is the manual step
 * once a token exists. What it does confirm is that the client handles the
 * documented shape, and it is the harness to replay a real captured response
 * through: drop the JSON into a handler and the assertions below become a
 * conformance test of the API.
 *
 * It sits outside apps/api's tsconfig `include`, like its siblings — it is a
 * harness, not part of the API build.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// The client reads env at construction; set it before the module is loaded.
process.env['GITHUB_ORG'] ??= 'RBCZ-copilots';
process.env['GITHUB_MEMBERS_TOKEN'] ??= 'test-token';
process.env['DATABASE_URL'] ??= 'postgres://localhost:5432/dash';

const { createMembersClient } = await import('../src/copilot/members.js');

const failures: string[] = [];
const check = (ok: boolean, message: string): void => {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
};

// ------------------------------------------------------------- fake GitHub

interface Captured {
  authorization: string | undefined;
  contentType: string | undefined;
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
        contentType: req.headers['content-type'],
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

/** One `externalIdentities` page, in the documented envelope. */
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

async function errorMessageOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ------------------------------------------------------------------ checks

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
    check(client !== null, 'the client is constructed when org and token are set');
    const result = await client!.fetchMembers();

    check(result.members.length === 3, 'both pages are collected');
    check(fake.calls.length === 2, 'paged exactly twice — it stops on hasNextPage: false');
    check(
      fake.calls[0]?.body.variables['after'] === null,
      'the first request sends a null cursor',
    );
    check(
      fake.calls[1]?.body.variables['after'] === 'CURSOR-1',
      "the second request carries the first page's endCursor",
    );
    check(
      fake.calls[0]?.body.variables['org'] === 'RBCZ-copilots',
      'the org travels as a GraphQL variable, never interpolated into the query',
    );
    check(
      fake.calls[0]?.authorization === 'Bearer test-token',
      'the token travels as a bearer header',
    );
    check(
      fake.calls[0]?.contentType === 'application/json',
      'the request is posted as JSON',
    );
    check(
      result.members[0]?.login === 'alice' && result.members[0]?.samlNameId === 'ICZAA001',
      'login and nameId map onto OrgMember',
    );
    check(
      result.unlinkedIdentities === 0 && result.oversizedNameIds === 0,
      'a clean response counts no skips',
    );
    await fake.close();
  }

  console.log('\na null identity provider is a failure, not an empty org');
  {
    const fake = await startFake(() => ({
      data: { organization: { samlIdentityProvider: null } },
    }));
    const message = await errorMessageOf(() => createMembersClient(fake.baseUrl)!.fetchMembers());
    check(message !== null, 'samlIdentityProvider: null throws rather than reporting zero members');
    check(
      message?.includes('SSO') === true,
      'the message names SSO, so an unauthorised token is diagnosable from the job row',
    );
    await fake.close();
  }

  console.log('\nan errors[] array inside a 200 is a failure');
  {
    const fake = await startFake(() => ({
      data: { organization: null },
      errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'requires read:org' }],
    }));
    const message = await errorMessageOf(() => createMembersClient(fake.baseUrl)!.fetchMembers());
    check(
      message?.includes('read:org') === true,
      'the GraphQL error message is carried, not swallowed into an empty roster',
    );
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
          identity('frank', null),
          null,
        ],
        { hasNextPage: false, endCursor: null },
      ),
    );
    const result = await createMembersClient(fake.baseUrl)!.fetchMembers();

    check(result.members.length === 3, 'only the keyable, storable nodes are returned');
    check(result.unlinkedIdentities === 1, 'an identity with no user is counted, not thrown');
    check(result.oversizedNameIds === 1, 'a nameId over 40 chars is counted, never truncated');
    check(
      result.members.every((member) => member.login !== 'dave'),
      'the oversized row is dropped rather than stored truncated',
    );
    check(
      result.members.some((member) => member.login === 'erin' && member.samlNameId === null),
      'an empty nameId stores as null rather than an empty string',
    );
    check(
      result.members.some((member) => member.login === 'frank' && member.samlNameId === null),
      'an absent samlIdentity stores as null — unknown, not a dropped member',
    );
    await fake.close();
  }

  console.log('\nhasNextPage with no cursor stops instead of looping');
  {
    const fake = await startFake(() =>
      page([identity('alice', 'ICZAA001')], { hasNextPage: true, endCursor: null }),
    );
    const result = await createMembersClient(fake.baseUrl)!.fetchMembers();
    check(fake.calls.length === 1, 'a cursorless next page ends the walk');
    check(result.members.length === 1, 'what was collected before stopping is kept');
    await fake.close();
  }

  // The unconfigured case (`createMembersClient()` → null) is not checked here:
  // `env` is parsed once at module load, so it cannot be unset from inside this
  // process. The scheduler's `disabledReason` guard is the same test, and the
  // route's 503 is what a reader would see.

  console.log(failures.length === 0 ? '\nall checks passed' : `\n${failures.length} FAILED`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
