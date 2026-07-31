/**
 * Ad-hoc check of the LLM gateway's **catalogue view** — the web derivation
 * that reads the stored price list next to the spend it priced. Not a test
 * suite (the repo has none) — run it by hand, with the API's env loaded:
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-catalog-view.ts
 *
 * `verify-litellm-contract.ts` covers the `/model/info` wire and
 * `verify-gateway-catalog.ts` covers the join and the Postgres round trip.
 * What is left, and what this script is for, is the thing the page actually
 * renders: `lib/metrics/gatewayCatalog.ts` turning a catalogue plus a window's
 * `model` rows into an estimate, a coverage figure and a list-vs-bill ratio.
 *
 * The load-bearing checks are the ones that keep the card's three labels
 * honest, because every one of them is a claim that can quietly become false:
 *
 *  - **Coverage is measured against the whole bill**, so a model the catalogue
 *    cannot price must *reduce* it rather than be priced at zero. The mock
 *    plants exactly one such model, and its spend is real.
 *  - **A floor is never a disagreement.** The multi-deployment alias re-prices
 *    below what it billed by construction, so it must classify as `floor`, must
 *    not appear in `drifting`, and must not enter the aggregate ratio — folding
 *    it in would report a discount the gateway does not have.
 *  - **A firm rate reproduces the bill.** The mock bills off the same table it
 *    quotes, so every single-deployment model must re-price to within rounding.
 *    Anything else means the four-rate split (uncached input, cache read, cache
 *    write, output) is wrong, and that split is the whole reason the catalogue
 *    is worth storing.
 *
 * Drift itself cannot be planted in the mock without making the generator lie
 * about its own bill, so it is checked over *constructed* rows instead — the
 * same shape iterations 22 and 23 used for seal diffs and budget history.
 *
 * The Postgres half runs the same derivation over what a sync actually stored,
 * which is what proves the nullable price columns survive the round trip into
 * the shape the card reads (a `$0.00/M` coming back where a null went in would
 * price a model's traffic at free and read as a 100% discount).
 */
import { resolveModelPrice } from '@dash/shared';
import type { GatewayMetrics, GatewayModelPrice } from '@dash/shared';
import { db } from '../src/db/client.js';
import { gatewayModel } from '../src/db/schema.js';
import { MockGatewayClient } from '../src/gateway/mock.js';
import { getGatewayModels, getGatewayUsage } from '../src/services/gateway.js';
import { startGatewaySync } from '../src/services/gateway-sync.js';
import { nanoToDollars } from '../src/lib/nano.js';
import { deriveGateway } from '../../web/src/lib/metrics/gateway.js';
import type { GatewayBreakdownRow } from '../../web/src/lib/metrics/gateway.js';
import {
  CATALOG_DRIFT_TOLERANCE,
  deriveCatalog,
  hasCatalog,
  repriceMetrics,
} from '../../web/src/lib/metrics/gatewayCatalog.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};

const client = new MockGatewayClient();

/** The same nano → dollars conversion `getGatewayModels` does. */
const toPrice = (row: Awaited<ReturnType<MockGatewayClient['fetchModels']>>[number]): GatewayModelPrice => ({
  model: row.model,
  backend: row.backend,
  provider: row.provider,
  mode: row.mode,
  inputPerMillion: row.inputPerMillionNano === null ? null : nanoToDollars(row.inputPerMillionNano),
  outputPerMillion:
    row.outputPerMillionNano === null ? null : nanoToDollars(row.outputPerMillionNano),
  cacheReadPerMillion:
    row.cacheReadPerMillionNano === null ? null : nanoToDollars(row.cacheReadPerMillionNano),
  cacheWritePerMillion:
    row.cacheWritePerMillionNano === null ? null : nanoToDollars(row.cacheWritePerMillionNano),
  maxInputTokens: row.maxInputTokens,
  maxOutputTokens: row.maxOutputTokens,
  deployments: row.deployments,
  priceVaries: row.priceVaries,
});

const today = new Date();
const to = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
const from = new Date(today.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);

const catalogue = (await client.fetchModels()).map(toPrice);
const usage = await client.fetchUsage(from, to);

// The exact payload the API serves: nano integers become dollars at the edge.
const payload = {
  daily: usage.daily.map((day) => ({
    date: day.date,
    spend: nanoToDollars(day.spendNano),
    requests: day.requests,
    successfulRequests: day.successfulRequests,
    failedRequests: day.failedRequests,
    promptTokens: day.promptTokens,
    completionTokens: day.completionTokens,
    totalTokens: day.totalTokens,
    cacheReadTokens: day.cacheReadTokens,
    cacheCreationTokens: day.cacheCreationTokens,
  })),
  breakdowns: usage.breakdowns.map((row) => ({
    date: row.date,
    dimension: row.dimension,
    key: row.key,
    label: row.label,
    spend: nanoToDollars(row.spendNano),
    requests: row.requests,
    successfulRequests: row.successfulRequests,
    failedRequests: row.failedRequests,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheCreationTokens,
  })),
};

const summary = deriveGateway(payload, from, to);
const catalog = deriveCatalog(summary.breakdowns.model, catalogue, summary.totals.spend);

// =====================================================================
// 1 · Coverage — the number the card leads with
// =====================================================================

console.log('\n1 · coverage');

check(hasCatalog(catalog), `the card renders at all (${catalog.rows.length} models priced against)`);
check(
  catalog.rows.length === summary.breakdowns.model.length,
  'one row per model the window billed — the catalogue adds no rows and drops none',
);
check(
  catalog.rows.every((row, index) =>
    index === 0 ? true : row.metrics.spend <= (catalog.rows[index - 1]?.metrics.spend ?? 0),
  ),
  'rows keep the breakdown table\'s own ranking by spend, so the two cards cannot disagree',
);
check(
  Math.abs(catalog.coverage - catalog.pricedSpend / catalog.gatewaySpend) < 1e-9,
  'coverage is priced spend over gateway spend, not over the model dimension',
);
check(
  catalog.unpriced.length === 1 && catalog.unpriced[0]?.key === 'azure_ai/phi-4',
  `exactly the planted unpriceable model has no rate (${catalog.unpriced.map((row) => row.key).join(', ') || 'none'})`,
);
check(
  (catalog.unpriced[0]?.metrics.spend ?? 0) > 0 && catalog.coverage < 1,
  `an unpriceable model with real spend pulls coverage below 100% (${(catalog.coverage * 100).toFixed(1)}%)`,
);
check(
  catalog.unlisted.length === 0,
  'every model the mock billed resolves to a catalogue entry — a miss here would be a join bug',
);
check(
  Math.abs(catalog.pricedSpend + (catalog.unpriced[0]?.metrics.spend ?? 0) - catalog.modelSpend) <
    0.01,
  'priced spend plus the unpriceable rows is the whole model dimension — nothing is silently dropped',
);
check(
  catalog.rows.every((row) => (row.gap === null) === (row.estimate !== null)),
  'a gap and an estimate are exactly the two states — a row has one or the other, never both or neither',
);

// =====================================================================
// 2 · The estimate against the bill
// =====================================================================
//
// The mock bills off the same table it quotes, so a firm rate must reproduce
// the bill to rounding. That is a check on the four-rate split rather than on
// the generator: pricing the whole prompt at the input rate (the obvious bug)
// would overstate every cache-heavy model, and pricing cache reads at zero
// would understate them.

console.log('\n2 · the estimate against the bill');

const firm = catalog.rows.filter((row) => row.estimate !== null && row.price?.priceVaries === false);
const floors = catalog.rows.filter((row) => row.state === 'floor');

check(firm.length > 0 && floors.length === 1, `${firm.length} firm-rate models and one floor`);
check(
  catalog.firmRatio !== null && Math.abs(catalog.firmRatio - 1) < 0.002,
  `firm rates re-price to the bill in aggregate (${catalog.firmRatio?.toFixed(4)}×)`,
);
check(
  firm.every((row) => row.state === 'matches'),
  'and every firm-rate row individually, so no model is flagged on a mock that cannot drift',
);
check(catalog.drifting.length === 0, 'nothing is flagged as disagreeing with the catalogue');
check(
  floors[0]?.ratio !== null && (floors[0]?.ratio ?? 0) > 1 + CATALOG_DRIFT_TOLERANCE,
  `the multi-deployment model bills materially above its own quoted floor (${floors[0]?.ratio?.toFixed(3)}×)`,
);
check(
  !catalog.drifting.includes(floors[0] as (typeof catalog.rows)[number]),
  'and is still not reported as a disagreement — a floor coming in low is the documented behaviour, not a finding',
);
check(
  catalog.firmBilled > 0 && catalog.firmBilled < catalog.pricedSpend,
  'the aggregate ratio is measured over firm rows only — the floor is excluded from both sides',
);
check(
  firm.every(
    (row) =>
      row.effectivePerMillion !== null &&
      row.listPerMillion !== null &&
      Math.abs(row.effectivePerMillion - row.listPerMillion) / row.listPerMillion < 0.002,
  ),
  'the blended effective rate matches the blended list rate on a firm row — same token mix, so the mix cancels',
);

// =====================================================================
// 3 · The re-pricing itself, over constructed tokens
// =====================================================================
//
// The mock cannot exercise a wrong price (it bills what it quotes), so the
// arithmetic is checked against rows built by hand — one token kind at a time,
// which is the only way to prove the four rates land on the four counters.

console.log('\n3 · re-pricing, token kind by token kind');

const metrics = (parts: Partial<GatewayMetrics>): GatewayMetrics => ({
  spend: 0,
  requests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  ...parts,
});

const priced: GatewayModelPrice = {
  model: 'test/model',
  backend: 'azure/test',
  provider: 'azure',
  mode: 'chat',
  inputPerMillion: 10,
  outputPerMillion: 40,
  cacheReadPerMillion: 1,
  cacheWritePerMillion: 12.5,
  maxInputTokens: 128_000,
  maxOutputTokens: 16_384,
  deployments: 1,
  priceVaries: false,
};

check(
  repriceMetrics(metrics({ promptTokens: 1_000_000 }), priced) === 10,
  'a million plain input tokens price at the input rate',
);
check(
  repriceMetrics(metrics({ completionTokens: 1_000_000 }), priced) === 40,
  'a million output tokens price at the output rate',
);
check(
  repriceMetrics(metrics({ promptTokens: 1_000_000, cacheReadTokens: 1_000_000 }), priced) === 1,
  'a fully cached prompt prices at the cache-read rate, not at input — LiteLLM counts cache reads inside promptTokens',
);
check(
  repriceMetrics(metrics({ promptTokens: 1_000_000, cacheReadTokens: 250_000 }), priced) === 7.75,
  'a partly cached prompt splits: 750k at $10/M plus 250k at $1/M',
);
check(
  repriceMetrics(metrics({ cacheCreationTokens: 1_000_000 }), priced) === 12.5,
  'a cache write prices at the write premium',
);
check(
  repriceMetrics(metrics({ promptTokens: 1_000_000 }), {
    ...priced,
    cacheReadPerMillion: null,
    cacheWritePerMillion: null,
  }) === 10,
  'a backend with no separate cache rates falls back to input, which is what such a backend charges',
);
check(
  repriceMetrics(metrics({ promptTokens: 1_000_000 }), { ...priced, outputPerMillion: null }) ===
    null,
  'half a price list yields no estimate at all — a partial estimate is wrong, not cheap',
);
check(
  repriceMetrics(metrics({ promptTokens: 100, cacheReadTokens: 400 }), priced) === 0.0004,
  'a prompt reported as more cached than sent never prices negative input',
);

// =====================================================================
// 4 · Drift — constructed, because the mock cannot lie about its own bill
// =====================================================================

console.log('\n4 · drift classification');

const row = (key: string, spend: number, label: string | null = null): GatewayBreakdownRow => ({
  key,
  label,
  metrics: metrics({ spend, promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 }),
  share: 1,
});

/** Exactly what `priced` quotes for that token mix: $10 + $40. */
const atList = 50;
const drift = (spend: number) => deriveCatalog([row('test/model', spend)], [priced], spend);

check(drift(atList).rows[0]?.state === 'matches', 'a bill equal to the list price matches');
check(
  drift(atList * 1.04).rows[0]?.state === 'matches',
  'and so does one 4% above it — under the tolerance is rounding, not a finding',
);
check(
  drift(atList * 1.2).rows[0]?.state === 'above' && drift(atList * 1.2).drifting.length === 1,
  'a bill 20% above list is flagged as over',
);
check(
  drift(atList * 0.7).rows[0]?.state === 'below' && drift(atList * 0.7).drifting.length === 1,
  'a bill 30% below list is flagged as under — an unrecorded discount is as much a finding as a surcharge',
);
check(
  Math.abs((drift(atList * 1.2).rows[0]?.ratio ?? 0) - 1.2) < 1e-9,
  'the ratio is the bill over the estimate, in that order',
);

const varying = deriveCatalog([row('test/model', atList * 1.4)], [{ ...priced, deployments: 2, priceVaries: true }], atList * 1.4);
check(
  varying.rows[0]?.state === 'floor' &&
    varying.drifting.length === 0 &&
    varying.firmRatio === null,
  'the same 40% gap on a multi-deployment alias is a floor, is not flagged, and leaves the aggregate ratio unanswered',
);

const unlisted = deriveCatalog([row('nobody/knows-me', 10)], [priced], 10);
check(
  unlisted.rows[0]?.gap === 'unlisted' &&
    unlisted.rows[0]?.price === null &&
    unlisted.coverage === 0,
  'a model the catalogue has never heard of resolves to nothing and takes coverage with it',
);
check(
  unlisted.idleModels.length === 1 && unlisted.idleModels[0]?.model === 'test/model',
  'and the catalogue entry nobody called is reported as configured-but-unused',
);

const viaBackend = deriveCatalog([row('azure/test', 50)], [priced], 50);
check(
  viaBackend.rows[0]?.price?.model === 'test/model' && viaBackend.idleModels.length === 0,
  'a key that resolved through the backend routing string is not also counted as an idle alias',
);

check(
  !hasCatalog(deriveCatalog([], [], 0)) && !hasCatalog(deriveCatalog([], [priced], 0)),
  'no traffic and no catalogue both stand the card down rather than rendering an empty table',
);
check(
  deriveCatalog([row('test/model', 0)], [priced], 0).coverage === 0,
  'a window with no spend divides by nothing rather than by zero',
);

// =====================================================================
// 5 · Through Postgres, over what a sync actually stored
// =====================================================================

console.log('\n5 · through Postgres');

const storedModels = await db.select({ model: gatewayModel.model }).from(gatewayModel);
if (storedModels.length === 0) {
  console.log('      no catalogue stored yet — running a full sync first');
  await startGatewaySync();
  for (let attempt = 0; attempt < 120; attempt++) {
    const rows = await db.select({ model: gatewayModel.model }).from(gatewayModel);
    if (rows.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const dbCatalogue = (await getGatewayModels()).models;
const dbUsage = await getGatewayUsage(from, to);
const dbSummary = deriveGateway(dbUsage, from, to);
const dbCatalog = deriveCatalog(dbSummary.breakdowns.model, dbCatalogue, dbSummary.totals.spend);

check(dbCatalogue.length > 0, `the stored catalogue answers (${dbCatalogue.length} models)`);
check(
  dbSummary.breakdowns.model.length > 0,
  `and the stored window carries model rows (${dbSummary.breakdowns.model.length})`,
);
check(
  dbCatalog.unlisted.length === 0,
  'every stored model still resolves after the round trip — nothing was renamed by Postgres',
);
check(
  dbCatalog.unpriced.length === catalog.unpriced.length,
  `a null price is still null through the database (${dbCatalog.unpriced.length} unpriceable, not 0)`,
);
check(
  dbCatalog.firmRatio !== null && Math.abs(dbCatalog.firmRatio - 1) < 0.01,
  `firm rates still re-price to the stored bill (${dbCatalog.firmRatio?.toFixed(4)}×)`,
);
check(
  dbCatalog.rows.filter((entry) => entry.state === 'floor').length === 1,
  'the multi-deployment flag survives into the view as a floor row',
);
check(
  resolveModelPrice(dbCatalogue, 'azure/gpt-5-preview') === null,
  'and a model the proxy does not serve still resolves to nothing rather than to a neighbour',
);

console.log(
  `\n      coverage ${(dbCatalog.coverage * 100).toFixed(1)}% · list $${dbCatalog.firmEstimate.toFixed(2)} vs billed $${dbCatalog.firmBilled.toFixed(2)} on firm rates · ${dbCatalog.idleModels.length} configured models unused`,
);

console.log(
  failures.length === 0
    ? '\nAll catalogue-view checks passed.\n'
    : `\n${failures.length} FAILED:\n${failures.map((message) => `  - ${message}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
