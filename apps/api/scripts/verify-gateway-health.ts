/**
 * Ad-hoc check of the LLM gateway's deployment health — the router's own view of
 * the individual Azure/Bedrock endpoints behind each alias. Not a test suite
 * (the repo has none) — run it by hand, with the API's env loaded:
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-health.ts
 *
 * `verify-litellm-contract.ts` covers the *wire* — the two-list envelope, the
 * details-stripped form, the id fallback, the flapping duplicate — and the pure
 * up/degraded/down rule over constructed rows. This script covers the three
 * things a fake proxy cannot answer:
 *
 *  - **The join.** `/health` reports routing strings and `/model/info` reports
 *    public aliases, and the sync is the only place both exist. A deployment
 *    filed under the wrong alias would name the wrong model as degraded, which
 *    is worse than naming none.
 *  - **The reading nothing else can make.** The whole argument for this table is
 *    that a *degraded* alias is invisible in spend and in failures alike. That
 *    is checkable rather than assertable: the mock's degraded alias must carry
 *    ordinary spend and an ordinary failure rate on the same day its PTU pool is
 *    refusing.
 *  - **The blast radius.** Health is the third current-state table, and a ranged
 *    backfill must leave it exactly as it found it — the same rule
 *    `gateway_budget` and `gateway_model` are held to.
 *
 * The Postgres half runs a real full sync and then a ranged one, so it needs a
 * database. It restores nothing: a full sync replaces this table wholesale by
 * construction, so the next one undoes anything this leaves behind.
 */
import { eq } from 'drizzle-orm';
import { summarizeDeploymentHealth, resolveDeploymentModel } from '@dash/shared';
import type { GatewayDeployment } from '@dash/shared';
import { db } from '../src/db/client.js';
import { gatewayDeploymentHealth, refreshJobs } from '../src/db/schema.js';
import { MockGatewayClient } from '../src/gateway/mock.js';
import { getGatewayHealth } from '../src/services/gateway.js';
import { startGatewaySync } from '../src/services/gateway-sync.js';

/** Poll a job row until it settles — `startJob` runs the work in the background. */
async function waitForJob(id: string) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const [row] = await db.select().from(refreshJobs).where(eq(refreshJobs.id, id));
    if (row && (row.status === 'succeeded' || row.status === 'failed')) return row;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};

const client = new MockGatewayClient();

// =====================================================================
// 1 · What the source reports
// =====================================================================

console.log('\n1 · the mock deployment list');

const snapshot = await client.fetchHealth();
const catalogue = await client.fetchModels();

check(snapshot.length > 0, `the source reports deployments (${snapshot.length})`);
check(
  new Set(snapshot.map((row) => row.id)).size === snapshot.length,
  'every deployment id is distinct — two rows sharing one would be one deployment counted twice',
);
check(
  snapshot.every((row) => row.backend !== ''),
  'every row names the deployment it is about',
);
check(
  snapshot.every((row) => (row.healthy ? row.error === null : true)),
  'a healthy deployment carries no error text',
);
check(
  snapshot.filter((row) => !row.healthy).every((row) => row.error !== null),
  'and every failing one explains itself',
);
check(
  snapshot.some((row) => row.provider === 'bedrock' && row.apiBase === null),
  'a Bedrock deployment has no api_base — null there is a fact about the backend, not a gap',
);

// More deployments than aliases is the property that makes the table worth
// having: it is the resolution `gateway_daily` does not have.
const backends = new Set(snapshot.map((row) => row.backend));
check(
  snapshot.length > backends.size,
  `at least one alias is served by more than one deployment (${snapshot.length} deployments, ${backends.size} routing strings)`,
);

// =====================================================================
// 2 · The join to the catalogue
// =====================================================================

console.log('\n2 · resolving deployments to aliases');

const resolved = snapshot.map((row) => ({
  ...row,
  model: resolveDeploymentModel(catalogue, row.backend),
}));

const unnamed = resolved.filter((row) => row.model === null);
check(
  unnamed.length === 1 && unnamed[0]?.backend === 'azure/gpt-35-turbo',
  `exactly the retired deployment fails to resolve (${unnamed.map((row) => row.backend).join(', ')})`,
);
check(
  resolved
    .filter((row) => row.model !== null)
    .every((row) => catalogue.some((entry) => entry.model === row.model)),
  'every resolved alias is one the catalogue actually carries',
);
check(
  resolved
    .filter((row) => row.model !== null)
    .every((row) => row.model === row.backend || row.backend.endsWith(row.model ?? '')),
  'and no deployment is filed under an alias unrelated to its routing string',
);

// =====================================================================
// 3 · The alias reading
// =====================================================================

console.log('\n3 · up, degraded, down');

const summary = summarizeDeploymentHealth(resolved as GatewayDeployment[], null);
const alias = (name: string) => summary.models.find((row) => row.model === name);

check(
  summary.degraded.length === 1 && summary.degraded[0]?.model === 'azure/gpt-4o',
  `exactly one alias is degraded (${summary.degraded.map((row) => row.model).join(', ')})`,
);
check(
  alias('azure/gpt-4o')?.deployments === 2 && alias('azure/gpt-4o')?.unhealthy === 1,
  'the degraded alias has one of its two deployments failing',
);
check(
  summary.down.length === 1 && summary.down[0]?.model === 'bedrock/amazon.nova-pro-v1:0',
  `exactly one alias is down (${summary.down.map((row) => row.model).join(', ')})`,
);
check(
  summary.down.every((row) => row.deployments === row.unhealthy),
  'a down alias is one with nothing left to fail over to — that is the definition, not a coincidence',
);
check(
  summary.unhealthy === summary.models.reduce((sum, row) => sum + row.unhealthy, 0),
  'the per-alias failures reconcile to the gateway-wide count',
);
check(
  summary.deployments === summary.models.reduce((sum, row) => sum + row.deployments, 0),
  'and so do the deployment counts — every deployment is in exactly one bucket',
);
check(
  summary.providers.reduce((sum, row) => sum + row.deployments, 0) === summary.deployments,
  'the provider rollup partitions the same set',
);
check(summary.unnamed === 1, 'the unresolved deployment is counted, not dropped');

// =====================================================================
// 4 · The finding no other card can make
// =====================================================================
//
// A degraded alias is the whole argument for this table. If the usage payload
// could see it, the table would be a duplicate — so this checks that it cannot:
// the alias whose PTU pool is refusing must look entirely ordinary in spend and
// in failures, because the router failed every call over to its other
// deployment and billed it normally.

console.log('\n4 · what spend and failures say about the same alias');

const to = new Date();
to.setUTCDate(to.getUTCDate() - 1);
const from = new Date(to);
from.setUTCDate(from.getUTCDate() - 13);
const iso = (date: Date) => date.toISOString().slice(0, 10);

const usage = await client.fetchUsage(iso(from), iso(to));
const modelRows = usage.breakdowns.filter((row) => row.dimension === 'model');
const perModel = new Map<string, { requests: number; failed: number; spend: bigint }>();
for (const row of modelRows) {
  const entry = perModel.get(row.key) ?? { requests: 0, failed: 0, spend: 0n };
  entry.requests += row.requests;
  entry.failed += row.failedRequests;
  entry.spend += row.spendNano;
  perModel.set(row.key, entry);
}

const degradedKey = summary.degraded[0]?.model ?? '';
const degradedUsage = perModel.get(degradedKey);
const gatewayRequests = [...perModel.values()].reduce((sum, row) => sum + row.requests, 0);
const gatewayFailed = [...perModel.values()].reduce((sum, row) => sum + row.failed, 0);
const gatewayRate = gatewayRequests === 0 ? 0 : gatewayFailed / gatewayRequests;
const degradedRate =
  degradedUsage === undefined || degradedUsage.requests === 0
    ? 0
    : degradedUsage.failed / degradedUsage.requests;

check(
  degradedUsage !== undefined && degradedUsage.spend > 0n,
  'the degraded alias is still billing — the router failed its calls over',
);
check(
  // The reliability card's own materiality gate: a key only earns the
  // `elevated` badge at 1.5x the gateway rate. Anything under that is a row
  // nobody would look at twice, which is precisely the claim being made here.
  degradedRate < gatewayRate * 1.5,
  `and its failure rate would not even earn the reliability card's badge (${(degradedRate * 100).toFixed(2)}% vs ${(gatewayRate * 100).toFixed(2)}% gateway-wide)`,
);
check(
  [...perModel.keys()].every((key) => key !== 'azure/gpt-35-turbo'),
  'the retired deployment carries no usage at all, which is why nothing else would report it',
);

// The down alias is the opposite case and must not be claimed as invisible: it
// is the state the usage payload *will* see, as failures, once traffic hits it.
const downKey = summary.down[0]?.model ?? '';
check(
  perModel.has(downKey),
  'the down alias is a model the gateway does route to, so its outage matters',
);

// =====================================================================
// 5 · Through Postgres
// =====================================================================

console.log('\n5 · the round trip and the blast radius');

const settled = await waitForJob((await startGatewaySync()).id);
check(settled?.status === 'succeeded', `a full sync ran (${settled?.status}: ${settled?.error})`);

const stored = await getGatewayHealth();
check(
  stored.deployments.length === snapshot.length,
  `the sync stored every deployment (${stored.deployments.length}/${snapshot.length})`,
);
check(stored.checkedAt !== null, 'and stamped the reading with when it was taken');
check(
  stored.deployments.filter((row) => !row.healthy).length ===
    snapshot.filter((row) => !row.healthy).length,
  'the unhealthy count survives the round trip',
);
check(
  stored.deployments.find((row) => row.backend === 'azure/gpt-35-turbo')?.model === null,
  'an unresolved alias is stored as null rather than as the routing string',
);
check(
  stored.deployments.find((row) => row.provider === 'bedrock' && row.apiBase === null) !== undefined,
  'and a null api_base is still null after Postgres',
);
check(
  stored.deployments[0]?.healthy === false,
  'the read orders failing deployments first',
);

const storedSummary = summarizeDeploymentHealth(stored.deployments, stored.checkedAt);
check(
  storedSummary.degraded.length === summary.degraded.length &&
    storedSummary.down.length === summary.down.length,
  'the stored rows summarise to the same alias states the source did',
);

// A backfill must not touch the table. Same sentinel shape the range-sync
// script uses for budgets and the catalogue: plant a row a full sync could
// never have produced, run a ranged sync, and require it to still be there.
const SENTINEL_ID = 'sentinel-not-from-a-sync';

await db.insert(gatewayDeploymentHealth).values({
  id: SENTINEL_ID,
  backend: 'azure/sentinel',
  model: null,
  provider: 'azure',
  apiBase: null,
  healthy: false,
  error: 'planted by verify-gateway-health.ts',
  errorStatus: 599,
  checkedAt: new Date(),
});

const yesterday = iso(to);
const rangedJob = await waitForJob((await startGatewaySync({ from: yesterday, to: yesterday })).id);
check(
  rangedJob?.status === 'succeeded',
  `a ranged sync ran (${rangedJob?.status}: ${rangedJob?.error})`,
);

const afterRanged = await db.select().from(gatewayDeploymentHealth);
check(
  afterRanged.some((row) => row.id === SENTINEL_ID),
  'a ranged backfill leaves deployment health exactly as it found it',
);

// Only the sentinel goes; the real reading stays, because the next full sync
// replaces it anyway and a dev database with an empty health table looks like a
// proxy that refused the route.
await db.delete(gatewayDeploymentHealth).where(eq(gatewayDeploymentHealth.id, SENTINEL_ID));

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('gateway deployment health: all checks passed');
process.exit(0);
