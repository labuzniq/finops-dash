/**
 * Ad-hoc check of the LLM gateway's model catalogue — the price list the proxy
 * is configured with, as opposed to the spend it recorded. Not a test suite (the
 * repo has none) — run it by hand, with the API's env loaded:
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-catalog.ts
 *
 * `verify-litellm-contract.ts` covers the *wire*: the `{"data": […]}` envelope,
 * the per-token → per-million scale, null-vs-zero, and the collapse of several
 * deployments onto one alias. This script covers the two things a fake proxy
 * cannot answer:
 *
 *  - **The join.** A price list is only worth storing if it can be read next to
 *    the usage it prices, and the two are keyed independently — the catalogue by
 *    what the proxy is configured with, the `model` dimension by what callers
 *    actually sent. So the load-bearing number here is *coverage*: the share of
 *    gateway spend sitting on models `resolveModelPrice` can price. On the mock
 *    it must be exactly 1, because both sides come from the same table; anything
 *    short of that is a bug in the join rather than in the data.
 *  - **The round trip.** Prices are bigint nano-dollars per million tokens in
 *    Postgres and floats in the payload, and every null has to survive both
 *    directions — an unpriced model that comes back as `$0.00/M` would price its
 *    traffic at free, which is the catalogue's version of the budget snapshot's
 *    null-vs-zero rule.
 *
 * It also checks what the catalogue *licenses*, which is the reason it exists:
 * a list rate times a token count is an estimate, and the estimate has to land
 * in the same order of magnitude as the spend the proxy actually billed. A
 * catalogue that disagrees with the bill by a factor is not a rounding
 * difference — it is the wrong price list, or the wrong join.
 *
 * The Postgres half runs a real full sync, so it needs a database and it writes
 * `gateway_model` (and everything else a sync writes). It restores nothing,
 * because a sync is idempotent on that table by construction: the next one
 * replaces it wholesale.
 */
import { eq } from 'drizzle-orm';
import { resolveModelPrice } from '@dash/shared';
import type { GatewayModelPrice } from '@dash/shared';
import { db } from '../src/db/client.js';
import { gatewayModel } from '../src/db/schema.js';
import { MockGatewayClient } from '../src/gateway/mock.js';
import { getGatewayModels } from '../src/services/gateway.js';
import { startGatewaySync } from '../src/services/gateway-sync.js';
import { nanoToDollars } from '../src/lib/nano.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};

const client = new MockGatewayClient();

// =====================================================================
// 1 · The catalogue the source produces
// =====================================================================

console.log('\n1 · the mock catalogue');

const snapshot = await client.fetchModels();

/** The same conversion `getGatewayModels` does, so the pure checks run on payload shapes. */
const toPrice = (row: (typeof snapshot)[number]): GatewayModelPrice => ({
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

const catalogue = snapshot.map(toPrice);
const priceOf = (model: string) => catalogue.find((entry) => entry.model === model);

check(catalogue.length > 0, `the mock proxy answers a catalogue (${catalogue.length} models)`);
check(
  new Set(catalogue.map((entry) => entry.model)).size === catalogue.length,
  'one row per public model name — the alias is the primary key',
);
check(
  catalogue.every((entry) => entry.deployments >= 1),
  'every row stands for at least one deployment',
);

const varying = catalogue.filter((entry) => entry.priceVaries);
check(
  varying.length === 1 && varying[0]?.deployments === 2,
  'exactly one alias has more than one deployment behind it, and it is the one flagged',
);

const unpriced = catalogue.filter((entry) => entry.inputPerMillion === null);
check(
  unpriced.length === 1,
  `exactly one model carries no price at all (${unpriced.map((entry) => entry.model).join(', ')})`,
);
check(
  unpriced.every(
    (entry) =>
      entry.outputPerMillion === null &&
      entry.cacheReadPerMillion === null &&
      entry.cacheWritePerMillion === null &&
      entry.maxInputTokens === null,
  ),
  'an unpriced model is null on every price, never zero — zero would price its traffic at free',
);
check(
  catalogue.every((entry) => entry.inputPerMillion === null || entry.inputPerMillion > 0),
  'a priced model has a positive rate — a mock that quoted 0 would hide the null-vs-zero distinction',
);
check(
  catalogue.every(
    (entry) =>
      entry.outputPerMillion === null ||
      entry.inputPerMillion === null ||
      entry.outputPerMillion > entry.inputPerMillion,
  ),
  'output costs more than input on every backend, which is what makes the two worth separating',
);
check(
  catalogue.every(
    (entry) =>
      entry.cacheReadPerMillion === null ||
      entry.inputPerMillion === null ||
      (entry.cacheReadPerMillion < entry.inputPerMillion &&
        (entry.cacheWritePerMillion ?? 0) > entry.inputPerMillion),
  ),
  'a cache read is cheaper than plain input and a cache write is dearer — the convention the cache card assumes, now priced',
);

// =====================================================================
// 2 · The join — catalogue coverage over real usage
// =====================================================================
//
// This is the number a card would lead with, and the only one that says whether
// the catalogue is usable at all. On the mock both sides come from the same
// MODELS table, so it must be exact; on a real proxy a shortfall is the finding.

console.log('\n2 · coverage over the model dimension');

const today = new Date();
const to = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
const from = new Date(today.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
const usage = await client.fetchUsage(from, to);

const modelRows = usage.breakdowns.filter((row) => row.dimension === 'model');
const gatewaySpend = usage.daily.reduce((sum, row) => sum + row.spendNano, 0n);
const modelSpend = modelRows.reduce((sum, row) => sum + row.spendNano, 0n);

const keys = [...new Set(modelRows.map((row) => row.key))];
const resolved = keys.filter((key) => resolveModelPrice(catalogue, key) !== null);
const pricedSpend = modelRows
  .filter((row) => resolveModelPrice(catalogue, row.key) !== null)
  .reduce((sum, row) => sum + row.spendNano, 0n);

check(
  keys.length > 0 && modelSpend > 0n,
  `the window carries model-dimension spend to price (${keys.length} keys)`,
);
check(
  resolved.length === keys.length,
  `every model the gateway billed resolves to a catalogue entry (${resolved.length}/${keys.length})`,
);
check(
  pricedSpend === modelSpend,
  'catalogue coverage over the mock is exact — both sides are the same configured list',
);
check(
  modelSpend === gatewaySpend,
  'and the model dimension still reconstitutes the gateway total, so coverage is measured against the whole bill',
);

// A key the catalogue has never heard of must reduce coverage rather than
// resolve to something plausible: a silently wrong price is worse than a gap.
check(
  resolveModelPrice(catalogue, 'azure/gpt-5-preview') === null,
  'a model the proxy does not offer resolves to nothing, not to its nearest neighbour',
);

// =====================================================================
// 3 · What the catalogue licenses — an estimate, checked against the bill
// =====================================================================
//
// The point of storing prices is to turn token counts into dollars where the
// daily aggregate cannot: it carries one `spend` covering input, output and both
// cache operations together, which is why `lib/metrics/gatewayCache.ts` reports
// tokens and refuses dollars. Re-pricing a day's tokens from the catalogue is
// what lifts that refusal, so the estimate has to be checked against the number
// the proxy actually billed.
//
// Two assertions, and the second is the one that matters:
//
//  - On the models whose catalogue price is a *rate* (one deployment), the
//    estimate must reproduce the bill almost exactly. The four rates cover every
//    token the aggregate counts, so anything more than rounding apart means the
//    scale conversion, the cache split or the join is wrong.
//  - On the model whose catalogue price is a *floor* (two deployments at
//    different prices), the estimate must come in **under** the bill, and by
//    roughly the discount. That is the whole content of `priceVaries`: the
//    number is a lower bound, and a card that presented it as a rate would
//    under-report that model's cost every time.

console.log('\n3 · the estimate against the bill');

const repriceNano = (row: (typeof modelRows)[number], price: GatewayModelPrice): bigint | null => {
  if (price.inputPerMillion === null || price.outputPerMillion === null) return null;
  const uncached = Math.max(0, row.promptTokens - row.cacheReadTokens);
  const dollars =
    (uncached * price.inputPerMillion +
      row.cacheReadTokens * (price.cacheReadPerMillion ?? price.inputPerMillion) +
      row.cacheCreationTokens * (price.cacheWritePerMillion ?? price.inputPerMillion) +
      row.completionTokens * price.outputPerMillion) /
    1_000_000;
  return BigInt(Math.round(dollars * 1e9));
};

let firmEstimate = 0n;
let firmBilled = 0n;
let floorEstimate = 0n;
let floorBilled = 0n;
let unpricedSpend = 0n;

for (const row of modelRows) {
  const price = resolveModelPrice(catalogue, row.key);
  const estimate = price === null ? null : repriceNano(row, price);
  if (price === null || estimate === null) {
    unpricedSpend += row.spendNano;
    continue;
  }
  if (price.priceVaries) {
    floorEstimate += estimate;
    floorBilled += row.spendNano;
  } else {
    firmEstimate += estimate;
    firmBilled += row.spendNano;
  }
}

const firmRatio = firmBilled === 0n ? 0 : nanoToDollars(firmEstimate) / nanoToDollars(firmBilled);
const floorRatio =
  floorBilled === 0n ? 0 : nanoToDollars(floorEstimate) / nanoToDollars(floorBilled);
console.log(
  `      firm rates: $${nanoToDollars(firmEstimate).toFixed(2)} vs $${nanoToDollars(firmBilled).toFixed(2)} (${firmRatio.toFixed(4)}×)`,
);
console.log(
  `      floor rate: $${nanoToDollars(floorEstimate).toFixed(2)} vs $${nanoToDollars(floorBilled).toFixed(2)} (${floorRatio.toFixed(4)}×)`,
);

check(
  firmBilled > 0n && Math.abs(firmRatio - 1) < 0.001,
  `a single-deployment model re-prices to the cent it was billed (${firmRatio.toFixed(4)}×)`,
);
check(
  floorBilled > 0n && floorRatio < 0.995,
  `a multi-deployment model re-prices below its bill — the catalogue rate is a floor (${floorRatio.toFixed(4)}×)`,
);
check(
  unpricedSpend > 0n && unpricedSpend < gatewaySpend,
  'the unpriced model is excluded from both comparisons rather than counted at zero',
);

// =====================================================================
// 4 · The round trip through Postgres
// =====================================================================

console.log('\n4 · through Postgres');

const job = await startGatewaySync();
check(job.status !== 'failed', `a full sync ran (${job.status})`);

// The job is asynchronous; wait for the table rather than for the job row,
// which is what the assertions are actually about.
for (let attempt = 0; attempt < 120; attempt++) {
  const rows = await db.select({ model: gatewayModel.model }).from(gatewayModel);
  if (rows.length > 0) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const stored = await getGatewayModels();
const storedOf = (model: string) => stored.models.find((entry) => entry.model === model);

check(
  stored.models.length === catalogue.length,
  `the sync stored every model (${stored.models.length}/${catalogue.length})`,
);

const varyingModel = varying[0]?.model ?? '';
check(
  storedOf(varyingModel)?.priceVaries === true && storedOf(varyingModel)?.deployments === 2,
  'the multi-deployment flag and its count survive the round trip',
);

const unpricedModel = unpriced[0]?.model ?? '';
check(
  storedOf(unpricedModel)?.inputPerMillion === null &&
    storedOf(unpricedModel)?.outputPerMillion === null &&
    storedOf(unpricedModel)?.maxInputTokens === null,
  'a null price is still null after Postgres — nothing zero-fills it on the way out',
);

const exact = catalogue.find((entry) => entry.inputPerMillion !== null);
check(
  exact !== undefined && storedOf(exact.model)?.inputPerMillion === exact.inputPerMillion,
  'a stored price comes back to the cent it went in as',
);

const ordered = stored.models.map((entry) => entry.inputPerMillion);
const firstNull = ordered.indexOf(null);
check(
  firstNull === -1 || ordered.slice(firstNull).every((value) => value === null),
  'the unpriced rows sort last — they cannot take part in a rate comparison but must stay visible',
);
check(
  ordered
    .filter((value): value is number => value !== null)
    .every((value, index, all) => index === 0 || all[index - 1]! <= value),
  'the priced rows are ordered cheapest input first',
);

// A model withdrawn from the router must lose its row rather than keep pricing
// traffic that can no longer happen — the same rule the budget snapshot has.
await db.insert(gatewayModel).values({
  model: 'retired/model-nobody-offers',
  backend: 'azure/retired',
  provider: 'azure',
  mode: 'chat',
  inputPerMillionNano: 999_000_000_000n,
  outputPerMillionNano: null,
  cacheReadPerMillionNano: null,
  cacheWritePerMillionNano: null,
  maxInputTokens: null,
  maxOutputTokens: null,
  deployments: 1,
  priceVaries: false,
});

const afterPlant = await db
  .select({ model: gatewayModel.model })
  .from(gatewayModel)
  .where(eq(gatewayModel.model, 'retired/model-nobody-offers'));
check(afterPlant.length === 1, 'a retired model was planted to see whether a sync clears it');

const second = await startGatewaySync();
check(second.status !== 'failed', `a second full sync ran (${second.status})`);
for (let attempt = 0; attempt < 120; attempt++) {
  const rows = await db
    .select({ model: gatewayModel.model })
    .from(gatewayModel)
    .where(eq(gatewayModel.model, 'retired/model-nobody-offers'));
  if (rows.length === 0) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const afterSync = await db
  .select({ model: gatewayModel.model })
  .from(gatewayModel)
  .where(eq(gatewayModel.model, 'retired/model-nobody-offers'));
check(
  afterSync.length === 0,
  'a full sync replaces the catalogue wholesale, so a model the router no longer offers stops being priced',
);

// -------------------------------------------------------------------- verdict

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('all gateway catalogue checks passed');
process.exit(0);
