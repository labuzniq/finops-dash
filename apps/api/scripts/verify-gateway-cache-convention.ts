/**
 * Ad-hoc check of the LLM gateway's **cache-token convention** — the single
 * statement that `prompt_tokens` is the whole input and both cache counters are
 * subsets of it. Not a test suite (the repo has none) — run it by hand, with the
 * API's env loaded:
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-cache-convention.ts
 *
 * Why this exists as its own script rather than as a section of the cache one:
 * the bug it guards against is *between* modules and no single-module check can
 * see it. For five iterations `gatewayCache.ts` and the shared `cacheHitRate`
 * read the input total as `promptTokens + cacheReadTokens` while
 * `gatewayCatalog.ts`, `gatewayCacheValue.ts` and the mock's own billing read
 * the cache as already inside `promptTokens`. Every module was internally
 * consistent, every verify script passed, and the two answers differed by the
 * size of the cache itself (22.1% against 28.3% on the mock). It only became
 * visible when one module borrowed a *rate* from another.
 *
 * So the load-bearing checks here are all cross-module or falsifying:
 *
 *  - **One number, four call sites.** The KPI's `cacheHitRate`, the cache card's
 *    `hitRate`, the rate the priced panel levels headroom to, and the split the
 *    catalogue re-prices from must all be the same arithmetic over the same
 *    payload — checked by making two modules produce a figure that can only
 *    agree if they share the convention (headroom in tokens).
 *  - **The split is exhaustive.** `uncachedInputTokens + reads + writes` must
 *    reconstitute `promptTokens` exactly, on every row the mock emits and on
 *    every row of every dimension. If a counter were outside the prompt count,
 *    the identity would break by exactly that counter.
 *  - **The convention is falsifiable, and the falsification is surfaced.** A row
 *    whose cache counters do not fit inside its prompt count cannot be
 *    described by it, so `detectCacheTokenConvention` must name that rather than
 *    clamp it away — a clamped violation reads as a small cache and nothing
 *    says otherwise. `reads_outside` and `writes_outside` are kept apart
 *    because a proxy mixing the two provider families shows only the second.
 *  - **A pricing module and a token module agree about what a cache is worth.**
 *    A workload sitting exactly on the gateway's own hit rate must have zero
 *    headroom in both the token card and the priced panel; a workload below it
 *    must have the same non-zero headroom in both. That is the check that would
 *    have failed before this convention existed.
 */
import {
  cacheHitRate,
  cacheReadShare,
  detectCacheTokenConvention,
  EMPTY_GATEWAY_METRICS,
  inputTokens,
  uncachedInputTokens,
  sumGatewayMetrics,
  GATEWAY_DIMENSIONS,
} from '@dash/shared';
import type {
  GatewayBreakdownPoint,
  GatewayDailyPoint,
  GatewayMetrics,
  GatewayModelPrice,
  GatewayUsage,
} from '@dash/shared';
import { MockGatewayClient } from '../src/gateway/mock.js';
import { nanoToDollars } from '../src/lib/nano.js';
import { deriveGateway } from '../../web/src/lib/metrics/gateway.js';
import type { GatewayBreakdownRow } from '../../web/src/lib/metrics/gateway.js';
import { deriveGatewayCache } from '../../web/src/lib/metrics/gatewayCache.js';
import { deriveCacheValue } from '../../web/src/lib/metrics/gatewayCacheValue.js';
import { repriceMetrics } from '../../web/src/lib/metrics/gatewayCatalog.js';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};
const near = (a: number, b: number, epsilon = 1e-9) => Math.abs(a - b) <= epsilon;

const dollarsOrNull = (nano: bigint | null): number | null =>
  nano === null ? null : nanoToDollars(nano);

function metrics(part: Partial<GatewayMetrics>): GatewayMetrics {
  return { ...EMPTY_GATEWAY_METRICS, ...part };
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
// 1 · The split is exhaustive
// =====================================================================

console.log('\n1 · uncached + reads + writes reconstitutes the prompt count');

{
  const m = metrics({ promptTokens: 1_000, cacheReadTokens: 600, cacheCreationTokens: 200 });
  check(inputTokens(m) === 1_000, 'the input total is `promptTokens` itself, cache included');
  check(uncachedInputTokens(m) === 200, 'full-rate input is the prompt with both counters taken out');
  check(
    uncachedInputTokens(m) + m.cacheReadTokens + m.cacheCreationTokens === inputTokens(m),
    'the three parts reconstitute the input exactly',
  );
  check(
    near(cacheReadShare(m) ?? -1, 0.6) && near(cacheHitRate(m) ?? -1, 60),
    'the share is 0..1 and the hit rate is the same number in percent',
  );
  check(
    cacheReadShare(metrics({})) === null && cacheHitRate(metrics({})) === null,
    'a key that sent no input has no hit rate — null rather than 0%',
  );
}

{
  // The clamp is a floor, not a description: a row this shape is a violation and
  // the detector below is what says so. What matters here is only that nothing
  // downstream sees a negative token count.
  const impossible = metrics({ promptTokens: 100, cacheReadTokens: 400 });
  check(uncachedInputTokens(impossible) === 0, 'an over-cached row clamps at zero rather than going negative');
}

// =====================================================================
// 2 · The detector — the convention is falsifiable
// =====================================================================

console.log('\n2 · detectCacheTokenConvention');

{
  const fits = detectCacheTokenConvention([
    { metrics: metrics({ promptTokens: 1_000, cacheReadTokens: 600, cacheCreationTokens: 200 }), label: 'a' },
    { metrics: metrics({ promptTokens: 1_000, cacheReadTokens: 1_000 }), label: 'b' },
  ]);
  check(fits.verdict === 'consistent', 'counters that fit inside the prompt count are consistent');
  check(fits.rowsObserved === 2 && fits.violations === 0, 'both rows counted, neither a violation');
  check(
    detectCacheTokenConvention([
      { metrics: metrics({ promptTokens: 1_000 }), label: 'a' },
    ]).verdict === 'unobserved',
    'a window with no cache activity says `unobserved` — nothing contradicts it, which is not agreement',
  );
}

{
  const reads = detectCacheTokenConvention([
    { metrics: metrics({ promptTokens: 1_000, cacheReadTokens: 600 }), label: 'ok' },
    { metrics: metrics({ promptTokens: 1_000, cacheReadTokens: 1_400 }), label: 'bad' },
  ]);
  check(reads.verdict === 'reads_outside', 'reads alone exceeding the prompt count is decisive about reads');
  check(
    reads.violations === 1 && reads.rowsObserved === 2 && reads.sample[0] === 'bad',
    'the violating row is counted and named, and the rows that fit are not',
  );
  check(reads.worstExcessTokens === 400, 'the overshoot is reported in tokens — how badly, not just whether');
}

{
  // The shape an Anthropic-family proxy would show if it reported writes
  // alongside `prompt_tokens` rather than inside it: the reads still fit.
  const writes = detectCacheTokenConvention([
    { metrics: metrics({ promptTokens: 1_000, cacheReadTokens: 900, cacheCreationTokens: 400 }), label: 'bad' },
  ]);
  check(
    writes.verdict === 'writes_outside',
    'reads that fit and a pair that does not is a statement about the write counter only',
  );
}

{
  const many = detectCacheTokenConvention(
    Array.from({ length: 9 }, (_, index) => ({
      metrics: metrics({ promptTokens: 10, cacheReadTokens: 100 }),
      label: `row-${index}`,
    })),
  );
  check(
    many.violations === 9 && many.sample.length === 5,
    'the sample is capped at five while the count stays whole — same rule as the seal diff',
  );
}

// =====================================================================
// 3 · The mock obeys it, on every row of every dimension
// =====================================================================

console.log('\n3 · the generated payload');

const client = new MockGatewayClient();
const MS_PER_DAY = 86_400_000;
const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
const from = isoDay(-58);
const to = isoDay(0);

// The client answers in nano-dollars, the way the table stores it; every web
// derivation reads dollars.
const snapshot = await client.fetchUsage(from, isoDay(-1));
const usage: GatewayUsage = {
  daily: snapshot.daily.map((day): GatewayDailyPoint => ({ ...day, spend: nanoToDollars(day.spendNano) })),
  breakdowns: snapshot.breakdowns.map(
    (point): GatewayBreakdownPoint => ({ ...point, spend: nanoToDollars(point.spendNano) }),
  ),
};
const view = deriveGateway(usage, from, to);
const totals = view.totals;

const payloadCheck = detectCacheTokenConvention([
  ...usage.daily.map((day) => ({ metrics: day, label: day.date })),
  ...usage.breakdowns.map((point) => ({
    metrics: point,
    label: `${point.dimension}:${point.key}:${point.date}`,
  })),
]);
check(
  payloadCheck.verdict === 'consistent' && payloadCheck.rowsObserved > 0,
  `the mock reports its cache inside prompt_tokens on all ${payloadCheck.rowsObserved} cache-carrying rows`,
);

for (const dimension of GATEWAY_DIMENSIONS) {
  const rows = usage.breakdowns.filter((point) => point.dimension === dimension);
  const summed = sumGatewayMetrics(rows);
  check(
    uncachedInputTokens(summed) + summed.cacheReadTokens + summed.cacheCreationTokens ===
      inputTokens(summed),
    `${dimension}: uncached + reads + writes reconstitutes the dimension's own input total`,
  );
}

console.log(
  `      gateway hit rate ${(cacheHitRate(totals) ?? 0).toFixed(1)}% · ` +
    `${(inputTokens(totals) / 1e6).toFixed(1)}M input · ` +
    `${(totals.cacheReadTokens / 1e6).toFixed(1)}M read · ` +
    `${(totals.cacheCreationTokens / 1e6).toFixed(1)}M written`,
);

// =====================================================================
// 4 · Cross-module agreement — the check no single module can make
// =====================================================================

console.log('\n4 · the KPI, the cache card and the priced panel answer one number');

const cache = deriveGatewayCache(view.daily, usage.breakdowns, 'model');

check(
  cache.hitRate !== null && near(cache.hitRate * 100, cacheHitRate(totals) ?? -1, 1e-9),
  'the cache card headline and the KPI are the same rate',
);
check(
  cache.inputTokens === inputTokens(totals),
  'and both are measured over the same input total',
);
check(
  cache.cachedTokens + cache.writeTokens + cache.uncachedTokens === cache.inputTokens,
  'the card\'s own split is exhaustive over the range',
);
check(
  cache.convention.verdict === 'consistent',
  'the card carries the verdict, so a violating proxy cannot be rendered silently',
);

{
  // Two modules, one payload, one number that can only agree if they share the
  // convention: headroom is `input · gatewayRate − cached`, and `input` is the
  // exact quantity the two used to disagree about.
  const gatewayTotals = metrics({ promptTokens: 10_000_000, cacheReadTokens: 4_000_000 });
  const usageRow = row('m', {
    promptTokens: 1_000_000,
    cacheReadTokens: 100_000,
    cacheCreationTokens: 50_000,
  });
  const tokenCard = deriveGatewayCache(
    [{ date: '2026-07-01', ...gatewayTotals }],
    [{ date: '2026-07-01', dimension: 'model', key: 'm', label: null, ...usageRow.metrics }],
    'model',
  );
  const priced = deriveCacheValue({
    modelRows: [usageRow],
    catalogue: [price({ model: 'm' })],
    gatewayTotals,
  });
  const expected = 1_000_000 * 0.4 - 100_000;
  check(
    near(tokenCard.headroomTokens, expected, 1e-6),
    `the token card levels the row to the gateway's 40% (${expected.toLocaleString()} tokens)`,
  );
  check(
    priced.rows[0] !== undefined && near(priced.rows[0].headroomTokens, expected, 1e-6),
    'and the priced panel levels it to exactly the same bar',
  );
  check(
    priced.rows[0] !== undefined && priced.rows[0].uncachedTokens === 850_000,
    'the priced panel takes both counters out of the prompt count, like the card above it',
  );
}

{
  // A model already at the gateway's rate has nothing to level up to, in either
  // module. Under two conventions one of them reports headroom here.
  const gatewayTotals = metrics({ promptTokens: 10_000_000, cacheReadTokens: 2_500_000 });
  const usageRow = row('m', { promptTokens: 4_000_000, cacheReadTokens: 1_000_000 });
  const tokenCard = deriveGatewayCache(
    [{ date: '2026-07-01', ...gatewayTotals }],
    [{ date: '2026-07-01', dimension: 'model', key: 'm', label: null, ...usageRow.metrics }],
    'model',
  );
  const priced = deriveCacheValue({
    modelRows: [usageRow],
    catalogue: [price({ model: 'm' })],
    gatewayTotals,
  });
  check(
    near(tokenCard.headroomTokens, 0, 1e-6) &&
      priced.rows[0] !== undefined &&
      near(priced.rows[0].headroomTokens, 0, 1e-6),
    'a model exactly on the gateway rate has no headroom in either module',
  );
}

// =====================================================================
// 5 · The catalogue prices the same split
// =====================================================================

console.log('\n5 · re-pricing reads the same split');

{
  const entry = price({ model: 'm' });
  const m = metrics({
    promptTokens: 1_000_000,
    cacheReadTokens: 600_000,
    cacheCreationTokens: 200_000,
    completionTokens: 100_000,
  });
  const expected =
    (200_000 * 10 + 600_000 * 1 + 200_000 * 12.5 + 100_000 * 30) / 1_000_000;
  check(
    near(repriceMetrics(m, entry) ?? -1, expected, 1e-9),
    `re-pricing charges the full rate on ${uncachedInputTokens(m).toLocaleString()} tokens, not on the whole prompt ($${expected.toFixed(2)})`,
  );

  // The failure this guards: adding the counters on top of `promptTokens` bills
  // every cached token twice, which is LiteLLM's own issue #9812 one layer up.
  const doubled =
    ((m.promptTokens + m.cacheReadTokens + m.cacheCreationTokens) * 10 +
      m.completionTokens * 30) /
    1_000_000;
  check(
    !near(repriceMetrics(m, entry) ?? -1, doubled, 1e-9),
    'and it is nowhere near what pricing the prompt plus the counters would charge',
  );
}

{
  // Against the generator, where the bill is known: the mock prices exactly the
  // same split, so a firm-rate model must re-price to what it was billed.
  const modelRows: readonly GatewayBreakdownRow[] = view.breakdowns.model;
  const priced = modelRows.find((entry) => entry.key === 'azure/gpt-4o-mini');
  const snapshot = (await client.fetchModels()).find((item) => item.model === 'azure/gpt-4o-mini');
  // The snapshot carries nano-dollars per million, the way the table stores it;
  // the catalogue derivations read dollars.
  const entry: GatewayModelPrice | undefined =
    snapshot === undefined
      ? undefined
      : {
          model: snapshot.model,
          backend: snapshot.backend,
          provider: snapshot.provider,
          mode: snapshot.mode,
          inputPerMillion: dollarsOrNull(snapshot.inputPerMillionNano),
          outputPerMillion: dollarsOrNull(snapshot.outputPerMillionNano),
          cacheReadPerMillion: dollarsOrNull(snapshot.cacheReadPerMillionNano),
          cacheWritePerMillion: dollarsOrNull(snapshot.cacheWritePerMillionNano),
          maxInputTokens: snapshot.maxInputTokens,
          maxOutputTokens: snapshot.maxOutputTokens,
          deployments: snapshot.deployments,
          priceVaries: snapshot.priceVaries,
        };
  const estimate = entry === undefined || priced === undefined ? null : repriceMetrics(priced.metrics, entry);
  check(
    estimate !== null && priced !== undefined && near(estimate / priced.metrics.spend, 1, 1e-4),
    `a single-deployment model re-prices to its bill (${estimate !== null && priced !== undefined ? (estimate / priced.metrics.spend).toFixed(4) : 'n/a'}×)`,
  );
}

console.log(
  failures.length === 0
    ? '\nall cache-convention checks passed'
    : `\n${failures.length} FAILED:\n${failures.map((line) => `  - ${line}`).join('\n')}`,
);
process.exit(failures.length === 0 ? 0 : 1);
