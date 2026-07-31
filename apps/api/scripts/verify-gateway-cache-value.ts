/**
 * Ad-hoc check of the LLM gateway's **priced cache** — the derivation that
 * finally puts a dollar figure on the prompt cache by reading the catalogue's
 * four rates. Not a test suite (the repo has none) — run it by hand, with the
 * API's env loaded:
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-cache-value.ts
 *
 * `gatewayCache.ts` reports tokens and refuses dollars because the proxy's daily
 * row carries one `spend` covering input, output and both cache operations
 * together. `gatewayCacheValue.ts` is that refusal lifted on the one dimension
 * where a rate belongs — `model` — and everything worth checking here follows
 * from what the number actually is: a **counterfactual**, not a re-pricing.
 *
 *   billed input   = uncached·input + read·readRate + write·writeRate
 *   no-cache input = (uncached + read + write)·input
 *   saving         = read·(input − readRate) − write·(writeRate − input)
 *
 * The load-bearing checks:
 *
 *  - **The identity holds.** The saving must equal the difference between those
 *    two bills to the cent, over constructed rows where both are known. If it
 *    does not, the split between plain input, cache read and cache write is
 *    wrong — and LiteLLM counting cache reads *inside* `prompt_tokens` is the
 *    exact place that goes wrong (iteration 27 found it in the catalogue card).
 *  - **A missing cache rate is unknown, never zero.** `repriceMetrics` falls
 *    back to the input rate when a backend prices no cache separately, which is
 *    right when reconstructing a total and catastrophic when measuring a
 *    *difference*: it would report a saving of exactly $0.00 out of a null. The
 *    mock cannot plant that (its catalogue prices cache on every model it
 *    prices at all), so it is checked over constructed rows.
 *  - **A floor is never mixed into a rate.** `azure/gpt-4o`'s two deployments
 *    make its rate spread a lower bound, so it must stay out of the headline
 *    and out of coverage, reported apart — the same rule the catalogue card
 *    applies to its aggregate ratio.
 *  - **The saving agrees with the break-even the cache card already draws.** A
 *    workload sitting exactly on `CACHE_BREAKEVEN_REUSE` must price to zero at
 *    the 0.1×/1.25× rates the constant is derived from. That is the one check
 *    that ties the convention-weighted card and the priced panel together; if
 *    it fails, one of the two is telling the reader something the other denies.
 *
 * The Postgres half runs the same derivation over what a sync actually stored,
 * which is what proves the nullable cache-rate columns survive the round trip
 * as nulls rather than coming back as free cache operations.
 */
import type { GatewayMetrics, GatewayModelPrice } from '@dash/shared';
import { MockGatewayClient } from '../src/gateway/mock.js';
import { getGatewayModels, getGatewayUsage } from '../src/services/gateway.js';
import { nanoToDollars } from '../src/lib/nano.js';
import { deriveGateway } from '../../web/src/lib/metrics/gateway.js';
import type { GatewayBreakdownRow } from '../../web/src/lib/metrics/gateway.js';
import { CACHE_BREAKEVEN_REUSE } from '../../web/src/lib/metrics/gatewayCache.js';

import {
  deriveCacheValue,
  hasCacheValue,
} from '../../web/src/lib/metrics/gatewayCacheValue.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};
const near = (a: number, b: number, epsilon = 1e-6) => Math.abs(a - b) <= epsilon;

// ---------------------------------------------------------------------
// Constructed helpers — a row and a price with only the fields that matter
// ---------------------------------------------------------------------

function metrics(part: Partial<GatewayMetrics>): GatewayMetrics {
  return {
    spend: 0,
    requests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...part,
  };
}

function row(key: string, part: Partial<GatewayMetrics>): GatewayBreakdownRow {
  return { key, label: null, metrics: metrics(part), share: 0 };
}

function price(part: Partial<GatewayModelPrice> & { model: string }): GatewayModelPrice {
  return {
    backend: part.model,
    provider: 'azure',
    mode: 'chat',
    inputPerMillion: 10,
    outputPerMillion: 30,
    cacheReadPerMillion: 1,
    cacheWritePerMillion: 12.5,
    maxInputTokens: null,
    maxOutputTokens: null,
    deployments: 1,
    priceVaries: false,
    ...part,
  };
}

// =====================================================================
// 1 · The identity: saving = no-cache bill − billed bill
// =====================================================================

console.log('\n1 · the counterfactual identity');

{
  // 1M prompt tokens of which 600k came from cache, 200k written, at $10/M in,
  // $1/M read, $12.50/M write. LiteLLM counts reads inside prompt_tokens, so
  // 400k paid full price.
  const entry = price({ model: 'azure/gpt-4o-mini' });
  const usage = row('azure/gpt-4o-mini', {
    promptTokens: 1_000_000,
    cacheReadTokens: 600_000,
    cacheCreationTokens: 200_000,
    completionTokens: 500_000,
  });

  const summary = deriveCacheValue({
    modelRows: [usage],
    catalogue: [entry],
    gatewayTotals: metrics({}),
  });
  const priced = summary.rows[0];

  const billedInput = (400_000 * 10 + 600_000 * 1 + 200_000 * 12.5) / 1e6;
  const noCacheInput = (400_000 + 600_000 + 200_000) * 10 / 1e6;

  check(priced !== undefined, 'a model with cache activity is priced');
  check(
    priced !== undefined && near(priced.noCacheInputCost, noCacheInput),
    `the no-cache bill prices every input token at the full rate ($${noCacheInput.toFixed(2)})`,
  );
  check(
    priced !== undefined && near(priced.netSaving, noCacheInput - billedInput),
    `saving is exactly the difference between the two bills ($${(noCacheInput - billedInput).toFixed(2)})`,
  );
  check(
    priced !== undefined && near(priced.readSaving, (600_000 * 9) / 1e6),
    'reads are valued at the spread between the input rate and the read rate',
  );
  check(
    priced !== undefined && near(priced.writePremium, (200_000 * 2.5) / 1e6),
    'writes are valued at the premium over a plain input token, not at the whole write rate',
  );
  check(
    priced !== undefined && priced.uncachedTokens === 400_000,
    'cache reads are taken back out of prompt_tokens — pricing the whole prompt at input would overstate every cache-heavy model',
  );
  check(
    summary.savingShare !== null && near(summary.savingShare, (noCacheInput - billedInput) / noCacheInput),
    'the share is measured against the no-cache bill, so it cannot exceed 100%',
  );
}

{
  // Output tokens must cancel: the cache cannot touch them, and folding them in
  // would shrink every share on the panel by the size of the completion bill.
  const entry = price({ model: 'm' });
  const base = deriveCacheValue({
    modelRows: [row('m', { promptTokens: 500_000, cacheReadTokens: 300_000, cacheCreationTokens: 50_000 })],
    catalogue: [entry],
    gatewayTotals: metrics({}),
  });
  const withOutput = deriveCacheValue({
    modelRows: [
      row('m', {
        promptTokens: 500_000,
        cacheReadTokens: 300_000,
        cacheCreationTokens: 50_000,
        completionTokens: 9_000_000,
      }),
    ],
    catalogue: [entry],
    gatewayTotals: metrics({}),
  });
  check(
    near(base.netSaving, withOutput.netSaving) && near(base.noCacheInputCost, withOutput.noCacheInputCost),
    'output tokens change nothing — the cache cannot touch them and they are left out of both bills',
  );
}

// =====================================================================
// 2 · Null is unknown, never a zero saving
// =====================================================================

console.log('\n2 · null-vs-zero on the cache rates');

{
  const noReadRate = price({ model: 'noread', cacheReadPerMillion: null });
  const summary = deriveCacheValue({
    modelRows: [row('noread', { promptTokens: 1_000_000, cacheReadTokens: 400_000 })],
    catalogue: [noReadRate],
    gatewayTotals: metrics({}),
  });
  check(summary.rows.length === 0, 'a model that read from cache with no read rate is not priced');
  check(
    summary.gaps.length === 1 && summary.gaps[0]?.gap === 'no_cache_rate',
    'it is reported as a gap rather than as a $0.00 saving — the same null-vs-zero rule the budgets carry',
  );
  check(
    near(summary.netSaving, 0) && summary.savingShare === null,
    'and it contributes nothing to the totals, rather than dragging them towards zero',
  );
}

{
  // The requirement is per counter, not per catalogue entry: a model that never
  // wrote needs no write rate, and refusing to price it would invent a gap.
  const readOnly = price({ model: 'readonly', cacheWritePerMillion: null });
  const summary = deriveCacheValue({
    modelRows: [row('readonly', { promptTokens: 1_000_000, cacheReadTokens: 400_000 })],
    catalogue: [readOnly],
    gatewayTotals: metrics({}),
  });
  check(
    summary.rows.length === 1 && summary.gaps.length === 0,
    'a model that read but never wrote is priced without a write rate',
  );
  check(
    summary.rows[0] !== undefined && near(summary.rows[0].writePremium, 0),
    'and its write premium is a real zero: it wrote no tokens',
  );
}

{
  const unlisted = deriveCacheValue({
    modelRows: [row('azure/nobody-lists-this', { promptTokens: 500_000, cacheReadTokens: 100_000 })],
    catalogue: [price({ model: 'azure/gpt-4o' })],
    gatewayTotals: metrics({}),
  });
  check(
    unlisted.gaps[0]?.gap === 'unlisted',
    'a model the catalogue never heard of is a gap, not a near-match',
  );

  const unpriced = deriveCacheValue({
    modelRows: [row('perSecond', { promptTokens: 500_000, cacheReadTokens: 100_000 })],
    catalogue: [price({ model: 'perSecond', inputPerMillion: null })],
    gatewayTotals: metrics({}),
  });
  check(
    unpriced.gaps[0]?.gap === 'unpriced',
    'a listed model billed per second carries no input rate and is a gap of its own kind',
  );
}

// =====================================================================
// 3 · Churning, and agreement with the cache card's break-even
// =====================================================================

console.log('\n3 · churning and the break-even');

{
  // 0.1x read and 1.25x write are the rates CACHE_BREAKEVEN_REUSE is derived
  // from, so a workload sitting exactly on it must price to zero.
  const entry = price({ model: 'be', inputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 12.5 });
  const written = 1_000_000;
  const read = Math.round(written * CACHE_BREAKEVEN_REUSE);
  const summary = deriveCacheValue({
    modelRows: [
      row('be', {
        promptTokens: 2_000_000 + read,
        cacheReadTokens: read,
        cacheCreationTokens: written,
      }),
    ],
    catalogue: [entry],
    gatewayTotals: metrics({}),
  });
  check(
    summary.rows[0] !== undefined && Math.abs(summary.rows[0].netSaving) < 0.01,
    `a workload exactly on the cache card's break-even (${CACHE_BREAKEVEN_REUSE.toFixed(3)} reads per write) prices to $0.00 — the two cards agree`,
  );
}

{
  const entry = price({ model: 'churn' });
  const summary = deriveCacheValue({
    modelRows: [
      row('churn', { promptTokens: 3_000_000, cacheReadTokens: 20_000, cacheCreationTokens: 2_000_000 }),
    ],
    catalogue: [entry],
    gatewayTotals: metrics({}),
  });
  check(
    summary.netSaving < 0 && summary.costing.length === 1,
    `a workload writing far more than it reads costs money ($${summary.netSaving.toFixed(2)}) and is listed as costing`,
  );
  check(
    summary.savingShare !== null && summary.savingShare < 0,
    'the share is signed, so the panel cannot render a cost as a small saving',
  );
}

// =====================================================================
// 4 · Headroom levels to the gateway's own rate
// =====================================================================

console.log('\n4 · headroom');

{
  const entry = price({ model: 'h' });
  // A gateway at a 50% hit rate: 500k of every million prompt tokens came out
  // of cache. Reads sit inside `promptTokens`, which is the convention this
  // module prices on and therefore the one it levels on.
  const gatewayAtHalf = metrics({ promptTokens: 10_000_000, cacheReadTokens: 5_000_000 });
  const below = deriveCacheValue({
    modelRows: [row('h', { promptTokens: 1_000_000, cacheReadTokens: 100_000, cacheCreationTokens: 10_000 })],
    catalogue: [entry],
    gatewayTotals: gatewayAtHalf,
  });
  // input tokens = 900k fresh + 100k read = 1M; at 50% that is 500k cached, so
  // 400k could move, valued at the $9/M spread.
  check(
    below.rows[0] !== undefined && near(below.rows[0].headroomTokens, 400_000),
    'headroom is what would move if the model merely reached the gateway rate',
  );
  check(
    below.rows[0] !== undefined && near(below.rows[0].headroomValue, (400_000 * 9) / 1e6),
    'and it is valued at that model\'s own read discount, not at a gateway-wide one',
  );

  const above = deriveCacheValue({
    modelRows: [row('h', { promptTokens: 1_000_000, cacheReadTokens: 900_000, cacheCreationTokens: 10_000 })],
    catalogue: [entry],
    gatewayTotals: gatewayAtHalf,
  });
  check(
    above.headroomTokens === 0 && above.headroomValue === 0,
    'a model already above the gateway rate offers no headroom — this is a floor on the opportunity, not a redistribution',
  );

  const unknown = deriveCacheValue({
    modelRows: [row('h', { promptTokens: 1_000_000, cacheReadTokens: 100_000 })],
    catalogue: [entry],
    gatewayTotals: metrics({}),
  });
  check(
    unknown.headroomTokens === 0,
    'and a gateway with no hit rate to level up to states no headroom rather than assuming one',
  );
}

// =====================================================================
// 5 · Over the mock payload — floors, coverage, and the bill itself
// =====================================================================

console.log('\n5 · over a mock payload');

const client = new MockGatewayClient();
const today = new Date();
const to = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
const from = new Date(today.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);

const catalogue: GatewayModelPrice[] = (await client.fetchModels()).map((entry) => ({
  model: entry.model,
  backend: entry.backend,
  provider: entry.provider,
  mode: entry.mode,
  inputPerMillion: entry.inputPerMillionNano === null ? null : nanoToDollars(entry.inputPerMillionNano),
  outputPerMillion:
    entry.outputPerMillionNano === null ? null : nanoToDollars(entry.outputPerMillionNano),
  cacheReadPerMillion:
    entry.cacheReadPerMillionNano === null ? null : nanoToDollars(entry.cacheReadPerMillionNano),
  cacheWritePerMillion:
    entry.cacheWritePerMillionNano === null ? null : nanoToDollars(entry.cacheWritePerMillionNano),
  maxInputTokens: entry.maxInputTokens,
  maxOutputTokens: entry.maxOutputTokens,
  deployments: entry.deployments,
  priceVaries: entry.priceVaries,
}));

const usage = await client.fetchUsage(from, to);
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
  breakdowns: usage.breakdowns.map((entry) => ({
    date: entry.date,
    dimension: entry.dimension,
    key: entry.key,
    label: entry.label,
    spend: nanoToDollars(entry.spendNano),
    requests: entry.requests,
    successfulRequests: entry.successfulRequests,
    failedRequests: entry.failedRequests,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    totalTokens: entry.totalTokens,
    cacheReadTokens: entry.cacheReadTokens,
    cacheCreationTokens: entry.cacheCreationTokens,
  })),
};

const summary = deriveGateway(payload, from, to);
const gatewayCacheTokens = summary.totals.cacheReadTokens + summary.totals.cacheCreationTokens;
const value = deriveCacheValue({
  modelRows: summary.breakdowns.model,
  catalogue,
  gatewayTotals: summary.totals,
});

check(hasCacheValue(value), `the panel renders (${value.rows.length} models priced)`);
check(
  value.floorRows.length === 1 && value.floorRows[0]?.isFloor === true,
  'the multi-deployment alias is priced apart as a floor rather than mixed into the headline',
);
check(
  !value.rows.some((entry) => entry.isFloor),
  'and no floor row is inside the firm totals — an aggregate mixing a rate with a floor is neither',
);
check(
  value.gaps.some((gap) => gap.gap === 'unpriced'),
  'the model the price map cannot resolve is a named gap, not a free one',
);
check(
  value.coverage > 0 && value.coverage < 1,
  `coverage is a real fraction of the gateway's cache tokens (${(value.coverage * 100).toFixed(1)}%) — the unpriceable and floor rows are outside it`,
);
check(
  near(
    value.pricedCacheTokens,
    value.rows.reduce((total, entry) => total + entry.cachedTokens + entry.writeTokens, 0),
  ),
  'and its numerator is exactly the cache tokens the priced rows carried',
);
check(
  value.rows.every((entry, index) =>
    index === 0 ? true : entry.netSaving <= (value.rows[index - 1]?.netSaving ?? Infinity) + 1e-9,
  ),
  'rows are ranked by net saving, biggest contributor first',
);
check(
  !value.rows.some((entry) => entry.cachedTokens === 0 && entry.writeTokens === 0),
  'models with no cache activity are dropped rather than listed at $0.00 in every column',
);
check(
  near(
    value.netSaving,
    value.rows.reduce((total, entry) => total + entry.netSaving, 0),
    1e-6,
  ) && near(value.netSaving, value.readSaving - value.writePremium, 1e-6),
  'the headline is the sum of its rows and of its two halves',
);
// The bound that catches a hit rate handed over in percent: levelling to 24
// instead of 0.24 puts a headroom of tens of thousands of dollars under a
// four-figure input bill, and every other check still passes.
check(
  value.headroomValue >= 0 && value.headroomValue <= value.noCacheInputCost,
  `headroom cannot exceed the input bill it would come out of ($${value.headroomValue.toFixed(2)} of $${value.noCacheInputCost.toFixed(2)})`,
);
check(
  value.rows.every((entry) => entry.headroomTokens <= entry.uncachedTokens + 1e-9),
  'and no model can move more tokens into cache than it sent uncached',
);
console.log(
  `      mock: $${value.netSaving.toFixed(2)} net saved · headroom $${value.headroomValue.toFixed(2)} on ${Math.round(value.headroomTokens).toLocaleString('en-US')} tokens`,
);

// The mock bills at exactly the rates it quotes, so the priced input bill has to
// reconcile with the spend the payload carries once output is taken off it.
{
  const firm = value.rows.filter((entry) => entry.cacheReadPerMillion !== null);
  const reconciled = firm.filter((entry) => {
    const source = summary.breakdowns.model.find((candidate) => candidate.key === entry.key);
    const listed = catalogue.find((candidate) => candidate.model === entry.key);
    if (source === undefined || listed?.outputPerMillion == null) return false;
    const outputBill = (source.metrics.completionTokens * listed.outputPerMillion) / 1e6;
    const billedInput = source.metrics.spend - outputBill;
    return near(entry.noCacheInputCost - entry.netSaving, billedInput, Math.max(0.01, billedInput * 1e-4));
  });
  check(
    firm.length > 0 && reconciled.length === firm.length,
    `every firm-rate model's priced input bill reconciles with what the proxy actually billed (${reconciled.length}/${firm.length})`,
  );
}

// =====================================================================
// 6 · Edges
// =====================================================================

console.log('\n6 · edges');

{
  const noCatalogue = deriveCacheValue({
    modelRows: summary.breakdowns.model,
    catalogue: [],
    gatewayTotals: summary.totals,
  });
  check(
    !hasCacheValue(noCatalogue) && noCatalogue.gatewayCacheTokens === gatewayCacheTokens,
    'a proxy that lists no models stands the panel down while still knowing how many cache tokens went unpriced',
  );

  const noTraffic = deriveCacheValue({
    modelRows: [],
    catalogue,
    gatewayTotals: metrics({}),
  });
  check(!hasCacheValue(noTraffic) && noTraffic.coverage === 0, 'and an empty window prices nothing');

  const noCacheAtAll = deriveCacheValue({
    modelRows: [row('azure/gpt-4o-mini', { promptTokens: 1_000_000, completionTokens: 100_000 })],
    catalogue: [price({ model: 'azure/gpt-4o-mini' })],
    gatewayTotals: metrics({}),
  });
  check(
    !hasCacheValue(noCacheAtAll) && noCacheAtAll.gaps.length === 0,
    'a gateway with no cache activity is not a gateway with a pricing gap',
  );
}

// =====================================================================
// 7 · Through Postgres, over what a sync actually stored
// =====================================================================

console.log('\n7 · through Postgres');

const dbCatalogue = (await getGatewayModels()).models;
const dbUsage = await getGatewayUsage(from, to);
const dbSummary = deriveGateway(dbUsage, from, to);

if (dbCatalogue.length === 0 || dbSummary.breakdowns.model.length === 0) {
  console.log('      nothing stored yet — run a gateway sync first; skipping the Postgres half');
} else {
  const dbValue = deriveCacheValue({
    modelRows: dbSummary.breakdowns.model,
    catalogue: dbCatalogue,
    gatewayTotals: dbSummary.totals,
  });

  check(hasCacheValue(dbValue), `the stored catalogue prices the stored window (${dbValue.rows.length} models)`);
  check(
    dbValue.rows.every((entry) => entry.cacheReadPerMillion !== null),
    'a null cache rate is still null through the database — nothing came back as a free cache operation',
  );
  check(
    dbValue.gaps.every((gap) => gap.gap !== 'unlisted'),
    'and every stored model still resolves after the round trip',
  );
  check(
    dbValue.floorRows.length === 1,
    'the multi-deployment flag survives into the panel as a floor row kept out of the headline',
  );
  check(dbValue.netSaving > 0, `the stored gateway's cache is worth $${dbValue.netSaving.toFixed(2)} at list rates`);

  console.log(
    `\n      saved $${dbValue.readSaving.toFixed(2)} on reads − $${dbValue.writePremium.toFixed(2)} on writes = $${dbValue.netSaving.toFixed(2)} net (${((dbValue.savingShare ?? 0) * 100).toFixed(1)}% of a $${dbValue.noCacheInputCost.toFixed(2)} no-cache input bill) · headroom $${dbValue.headroomValue.toFixed(2)} · coverage ${(dbValue.coverage * 100).toFixed(1)}%`,
  );
}

console.log(
  failures.length === 0
    ? '\nAll priced-cache checks passed.\n'
    : `\n${failures.length} FAILED:\n${failures.map((message) => `  - ${message}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
