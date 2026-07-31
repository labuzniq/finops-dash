/**
 * Ad-hoc check of the web app's deployment-health view — the card and the
 * digest rows it feeds. Not a test suite (the repo has none) — run it by hand,
 * with the API's env loaded for the Postgres section:
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-health-view.ts
 *
 * `verify-litellm-contract.ts` covers the `/health` wire and the pure
 * up/degraded/down rule; `verify-gateway-health.ts` covers the alias join, the
 * blast radius and the claim that a degraded alias is invisible on every other
 * card. What is left, and what this script is for, is what the page does with
 * the stored reading:
 *
 *  - **The reading's age is a fact about the sync, not about the gateway.**
 *    `/health` issues a live test call per deployment, so it is taken nightly
 *    and stored. A card that renders a two-day-old reading as current is the
 *    one way this feature can mislead, so `stale` is checked on both sides of
 *    its boundary and lands as a *blind spot* rather than as a finding — a late
 *    sync says nothing about which deployments are answering.
 *  - **Silence is not health, twice over.** An unanswered query and a reading
 *    that has never been taken both produce an empty alias list, identical to a
 *    gateway where everything is up. Both must be named.
 *  - **The digest repeats and never re-decides.** `down` and `degraded` are
 *    mapped to a severity and nothing else: every finding must trace back to an
 *    alias in that state, and every alias in that state must produce exactly one
 *    finding. The same two-directional rule `verify-gateway-alerts.ts` holds the
 *    other five sources to.
 *
 * The Postgres half runs the same derivation over what a sync actually stored,
 * which is what proves a null alias (a deployment the catalogue could not name)
 * survives the round trip as its own bucket rather than collapsing into a
 * string some model could one day be called.
 */
import { resolveDeploymentModel, summarizeDeploymentHealth } from '@dash/shared';
import type { GatewayDeployment, GatewayHealth } from '@dash/shared';
import { db } from '../src/db/client.js';
import { gatewayDeploymentHealth } from '../src/db/schema.js';
import { MockGatewayClient } from '../src/gateway/mock.js';
import { getGatewayHealth } from '../src/services/gateway.js';
import { startGatewaySync } from '../src/services/gateway-sync.js';
import {
  buildGatewayAlerts,
  KIND_ORDER,
  KIND_SEVERITY,
} from '../../web/src/lib/metrics/gatewayAlerts.js';
import type { AlertInputs } from '../../web/src/lib/metrics/gatewayAlerts.js';
import { deriveBudgetHistory } from '../../web/src/lib/metrics/gatewayBudgetHistory.js';
import { deriveBudgets } from '../../web/src/lib/metrics/gatewayBudgets.js';
import { deriveGatewayCache } from '../../web/src/lib/metrics/gatewayCache.js';
import {
  deploymentsOf,
  deriveGatewayHealth,
  HEALTH_STALE_HOURS,
} from '../../web/src/lib/metrics/gatewayHealth.js';
import { deriveReliability } from '../../web/src/lib/metrics/gatewayReliability.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};

const HOUR = 3_600_000;
const now = new Date('2026-07-31T09:00:00.000Z');
const client = new MockGatewayClient();

/** The sync's own join, reproduced: `/health` names routing strings only. */
async function readMockHealth(checkedAt: Date): Promise<GatewayHealth> {
  const [snapshot, catalogue] = await Promise.all([client.fetchHealth(), client.fetchModels()]);
  return {
    checkedAt: checkedAt.toISOString(),
    deployments: snapshot.map(
      (row): GatewayDeployment => ({
        id: row.id,
        backend: row.backend,
        model: resolveDeploymentModel(catalogue, row.backend),
        provider: row.provider,
        apiBase: row.apiBase,
        healthy: row.healthy,
        error: row.error,
        errorStatus: row.errorStatus,
        checkedAt: checkedAt.toISOString(),
      }),
    ),
  };
}

/**
 * A digest built over one health view and nothing else.
 *
 * Every other source is handed its empty derivation, so any finding on the list
 * came from health and any blind spot other than the four constant ones did
 * too. The budget summary is deliberately `budgetsLoaded: true` with no rows —
 * "the proxy governs nothing" is a blind spot the digest already owns and this
 * script is not re-checking it, it just has to stay constant across the cases.
 */
function digestOver(health: ReturnType<typeof deriveGatewayHealth>) {
  const inputs: AlertInputs = {
    budgets: deriveBudgets([], now),
    budgetsLoaded: true,
    history: deriveBudgetHistory(undefined),
    anomalies: [],
    reliability: deriveReliability([], [], 'model'),
    cache: deriveGatewayCache([], [], 'api_key'),
    coverage: null,
    health,
  };
  return buildGatewayAlerts(inputs, { maxAlerts: 10_000 });
}

// =====================================================================
// 1 · A fresh reading
// =====================================================================

console.log('\n1 · a reading taken an hour ago');

const fresh = await readMockHealth(new Date(now.getTime() - HOUR));
const view = deriveGatewayHealth(fresh, now);
const reference = summarizeDeploymentHealth(fresh.deployments, fresh.checkedAt);

check(view.answered, 'an answered query reads as answered');
check(!view.neverChecked && !view.isEmpty, 'a reading that exists is neither never-checked nor empty');
check(
  JSON.stringify(view.summary) === JSON.stringify(reference),
  'the view adds no rule of its own — its summary is summarizeDeploymentHealth verbatim',
);
check(
  view.ageHours !== null && Math.abs(view.ageHours - 1) < 0.001,
  `the reading is an hour old (${view.ageHours?.toFixed(2)}h)`,
);
check(!view.stale, 'an hour-old reading is not stale');

check(
  view.summary.down.length === 1 && view.summary.down[0]?.model === 'bedrock/amazon.nova-pro-v1:0',
  'the planted down alias is the one alias with every deployment failing',
);
check(
  view.summary.degraded.length === 1 && view.summary.degraded[0]?.model === 'azure/gpt-4o',
  'the planted degraded alias is the multi-deployment one, still answering on its other deployment',
);
check(
  view.summary.unnamed === 1,
  `the retired deployment the catalogue cannot name is its own bucket (${view.summary.unnamed})`,
);

// The alias table is a partition of the deployment list: every deployment is
// under exactly one alias, including the null one. A card that dropped a row
// here would under-report a failure and look tidier for it.
const listed = view.summary.models.reduce(
  (total, model) => total + deploymentsOf(view, model.model).length,
  0,
);
check(
  listed === view.summary.deployments && listed === fresh.deployments.length,
  `the rendered rows account for every deployment (${listed} of ${fresh.deployments.length})`,
);
const degradedRows = deploymentsOf(view, 'azure/gpt-4o');
check(
  degradedRows.length === 2 && degradedRows[0]?.healthy === false,
  'a degraded alias lists its failing deployment first, where the error text is',
);
check(
  degradedRows[0]?.error !== null && degradedRows[0]?.errorStatus === 429,
  'and that row carries the proxy error the card renders',
);

// =====================================================================
// 2 · The staleness boundary
// =====================================================================

console.log('\n2 · the staleness boundary');

const onTime = deriveGatewayHealth(
  await readMockHealth(new Date(now.getTime() - HEALTH_STALE_HOURS * HOUR)),
  now,
);
const late = deriveGatewayHealth(
  await readMockHealth(new Date(now.getTime() - (HEALTH_STALE_HOURS * HOUR + 60_000))),
  now,
);

check(!onTime.stale, `a reading exactly ${HEALTH_STALE_HOURS}h old is not yet stale`);
check(late.stale, `a minute older than ${HEALTH_STALE_HOURS}h is`);
check(
  JSON.stringify(onTime.summary.models) === JSON.stringify(late.summary.models),
  'staleness changes nothing about what the reading says — only whether it can be trusted as current',
);

// A reading dated in the future (clock skew between the API host and this
// browser) must not read as negative hours old, which would render as "in 3h".
const skewed = deriveGatewayHealth(await readMockHealth(new Date(now.getTime() + 2 * HOUR)), now);
check(skewed.ageHours === 0 && !skewed.stale, 'a reading dated ahead of us clamps to zero age');

// =====================================================================
// 3 · The two kinds of silence
// =====================================================================

console.log('\n3 · unanswered, and never taken');

const pending = deriveGatewayHealth(null, now);
check(!pending.answered, 'a query in flight has not answered');
check(pending.summary.deployments === 0 && pending.summary.models.length === 0, 'and shows nothing');
check(pending.ageHours === null && !pending.stale, 'an unanswered query has no age and is not stale');

const neverChecked = deriveGatewayHealth({ deployments: [], checkedAt: null }, now);
check(neverChecked.answered && neverChecked.neverChecked, 'an empty stored reading reads as never checked');
check(neverChecked.isEmpty, 'and as empty — the card stands itself down on it');

const pendingDigest = digestOver(pending);
const neverDigest = digestOver(neverChecked);
const freshDigest = digestOver(view);

check(
  pendingDigest.alerts.every((entry) => entry.source !== 'health'),
  'an unanswered health query produces no health finding',
);
check(
  pendingDigest.blindSpots.some((spot) => spot.includes('Deployment health has not answered')),
  'and is named as a blind spot instead',
);
check(
  neverDigest.alerts.every((entry) => entry.source !== 'health'),
  'a never-taken reading produces no health finding either',
);
check(
  neverDigest.blindSpots.some((spot) => spot.includes('/health')),
  'and names the route that was never read',
);

const staleDigest = digestOver(late);
check(
  staleDigest.alerts.filter((entry) => entry.source === 'health').length ===
    freshDigest.alerts.filter((entry) => entry.source === 'health').length,
  'a stale reading still reports the findings it holds — the data is old, not absent',
);
check(
  staleDigest.blindSpots.some((spot) => spot.includes(`${HEALTH_STALE_HOURS}h`)),
  'and adds the age as a blind spot, because a deployment that failed since is not on it',
);
check(
  !freshDigest.blindSpots.some((spot) => spot.toLowerCase().includes('deployment')),
  'while a fresh reading adds no health blind spot at all',
);

// =====================================================================
// 4 · The digest repeats the card and never re-decides
// =====================================================================

console.log('\n4 · the digest against the summary');

const healthAlerts = freshDigest.alerts.filter((entry) => entry.source === 'health');
const downAlerts = healthAlerts.filter((entry) => entry.kind === 'deployment-down');
const degradedAlerts = healthAlerts.filter((entry) => entry.kind === 'deployment-degraded');

check(
  downAlerts.length === view.summary.down.length,
  `every down alias is reported exactly once (${downAlerts.length} of ${view.summary.down.length})`,
);
check(
  degradedAlerts.length === view.summary.degraded.length,
  `every degraded alias is reported exactly once (${degradedAlerts.length} of ${view.summary.degraded.length})`,
);
check(
  healthAlerts.length === view.summary.down.length + view.summary.degraded.length,
  'and nothing else is reported — an `up` alias is not a finding',
);

// Nothing invented: each subject names an alias the summary holds in that state.
const stateOf = (subject: string) => {
  const name = subject.slice('model:'.length);
  return view.summary.models.find((model) => (model.model ?? 'unnamed deployments') === name)?.state;
};
check(
  downAlerts.every((entry) => stateOf(entry.subject) === 'down'),
  'a down finding names an alias the summary calls down',
);
check(
  degradedAlerts.every((entry) => stateOf(entry.subject) === 'degraded'),
  'a degraded finding names an alias the summary calls degraded',
);
check(
  healthAlerts.every((entry) => entry.detail.includes('failing')),
  'and every finding carries the summary’s own counts rather than a restatement',
);

check(
  KIND_SEVERITY['deployment-down'] === 'critical',
  'a down alias is critical — nothing routed to it can succeed right now',
);
check(
  KIND_SEVERITY['deployment-degraded'] === 'warning',
  'a degraded alias is a warning — it still answers, and somebody has to decide about the capacity',
);
check(
  KIND_ORDER.includes('deployment-down') && KIND_ORDER.includes('deployment-degraded'),
  'both kinds have a place in the editorial order — a kind missing from it sorts to the front',
);
const downIndex = freshDigest.alerts.findIndex((entry) => entry.kind === 'deployment-down');
const degradedIndex = freshDigest.alerts.findIndex((entry) => entry.kind === 'deployment-degraded');
check(
  downIndex >= 0 && degradedIndex > downIndex,
  'and the down finding sorts above the degraded one',
);

// The unnamed bucket is eligible: a deployment nobody could name is still a
// deployment that can fail, and the mock's is healthy today — so the finding
// must appear when it is not.
const brokenUnnamed = await readMockHealth(new Date(now.getTime() - HOUR));
const unnamedView = deriveGatewayHealth(
  {
    ...brokenUnnamed,
    deployments: brokenUnnamed.deployments.map((deployment) =>
      deployment.model === null
        ? { ...deployment, healthy: false, error: 'planted', errorStatus: 500 }
        : deployment,
    ),
  },
  now,
);
const unnamedAlerts = digestOver(unnamedView).alerts.filter(
  (entry) => entry.subject === 'model:unnamed deployments',
);
check(
  unnamedAlerts.length === 1 && unnamedAlerts[0]?.kind === 'deployment-down',
  'a failing deployment the catalogue cannot name is still reported, under its own bucket',
);

// A gateway with everything up is the one case that must produce nothing at
// all — no finding and no blind spot.
const allUp = await readMockHealth(new Date(now.getTime() - HOUR));
const healthyView = deriveGatewayHealth(
  { ...allUp, deployments: allUp.deployments.map((row) => ({ ...row, healthy: true, error: null })) },
  now,
);
const healthyDigest = digestOver(healthyView);
check(
  healthyDigest.alerts.every((entry) => entry.source !== 'health'),
  'a gateway with every deployment answering produces no health finding',
);
check(
  !healthyDigest.blindSpots.some((spot) => spot.toLowerCase().includes('deployment')),
  'and no health blind spot either',
);

// =====================================================================
// 5 · Through Postgres, over what a sync actually stored
// =====================================================================

console.log('\n5 · through Postgres');

const storedRows = await db.select({ id: gatewayDeploymentHealth.id }).from(gatewayDeploymentHealth);
if (storedRows.length === 0) {
  console.log('      no health reading stored yet — running a full sync first');
  await startGatewaySync();
  for (let attempt = 0; attempt < 120; attempt++) {
    const rows = await db
      .select({ id: gatewayDeploymentHealth.id })
      .from(gatewayDeploymentHealth);
    if (rows.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const stored = await getGatewayHealth();
const storedView = deriveGatewayHealth(stored, new Date());

check(storedView.answered && !storedView.neverChecked, 'the stored reading answers with a date on it');
check(
  storedView.summary.deployments === fresh.deployments.length,
  `every deployment survived the round trip (${storedView.summary.deployments} of ${fresh.deployments.length})`,
);
check(
  storedView.summary.down.length === 1 && storedView.summary.degraded.length === 1,
  'and both planted states read the same out of Postgres as out of the client',
);
check(
  storedView.summary.unnamed === 1 &&
    storedView.summary.models.some((model) => model.model === null),
  'a null alias is still null — the unnamed bucket did not collapse into a string',
);
check(
  storedView.summary.models
    .filter((model) => model.state !== 'up')
    .every((model) => model.errors.length > 0),
  'the proxy error text survived, which is the only thing the card can say about why',
);
check(
  !storedView.stale,
  `a reading a sync just took is not stale (${storedView.ageHours?.toFixed(2)}h old)`,
);

console.log(
  `\n      ${storedView.summary.deployments} deployments · ${storedView.summary.unhealthy} failing · ${storedView.summary.down.length} down · ${storedView.summary.degraded.length} degraded · ${storedView.summary.providers.length} backends`,
);

console.log(
  failures.length === 0
    ? '\nAll health-view checks passed.\n'
    : `\n${failures.length} FAILED:\n${failures.map((message) => `  - ${message}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
