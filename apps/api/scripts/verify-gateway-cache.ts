/**
 * Ad-hoc check of the web app's prompt-cache derivations against a real
 * mock-source payload. Not a test suite (the repo has none) — run it by hand:
 *
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-cache.ts
 *
 * It sits outside apps/api's tsconfig `include` on purpose: it imports the web
 * app's metrics modules, which do not belong in the API's build.
 *
 * What it proves:
 *
 * - the split is exact and exhaustive — cached + written + uncached = input on
 *   every row (both cache counters sit *inside* `prompt_tokens`, so the input
 *   total is the prompt count and the full-rate tokens are what is left after
 *   taking both back out), the days sum to the range totals, and every full-coverage
 *   dimension's rows reconcile to the gateway-wide numbers while `mcp_server`
 *   stays a strict subset, as it does everywhere else on the page;
 * - shares of uncached input sum to 1 across a full-coverage dimension, so the
 *   column is a decomposition of the opportunity rather than a decoration;
 * - the break-even the module derives from the providers' published multipliers
 *   is the number the arithmetic actually gives, and it separates the mock's
 *   three planted cache regimes — the churning document workload is badged, the
 *   sandbox reads as untouched headroom, and the workloads whose caches pay for
 *   themselves are badged as neither;
 * - the churning workload is genuinely more expensive than not caching at all,
 *   measured in dollars per input token against the gateway (which is the claim
 *   the badge makes, and the one thing no spend-shaped card can see, since the
 *   same key simply reads as busy);
 * - headroom is the row-by-row levelling it claims to be — never negative,
 *   never more than the uncached tokens it comes out of, and zero when every
 *   row already sits at the gateway rate;
 * - the edges behave: an empty spine, a range with no cache activity at all, a
 *   key too small to badge, and a key that writes without ever reading back.
 */
import { MockGatewayClient } from '../src/gateway/mock.js';
import { nanoToDollars } from '../src/lib/nano.js';
import { GATEWAY_DIMENSIONS } from '@dash/shared';
import type { GatewayBreakdownPoint, GatewayDailyPoint, GatewayUsage } from '@dash/shared';
import { deriveGateway } from '../../web/src/lib/metrics/gateway.js';
import {
  CACHE_BREAKEVEN_REUSE,
  CACHE_READ_RATE,
  CACHE_WRITE_RATE,
  deriveGatewayCache,
  hasCacheActivity,
} from '../../web/src/lib/metrics/gatewayCache.js';

const DAYS = 60;
const MS_PER_DAY = 86_400_000;

/** The mock's own plants — see CACHE_PROFILES in apps/api/src/gateway/mock.ts. */
const CHURNING_TAG = 'document-intelligence';
const CHURNING_KEY_ALIAS = 'risk-doc-analysis';
const UNUSED_TAG = 'experiment';
const CACHING_TAGS = ['coding-assistant', 'support', 'batch', 'chat'];

function iso(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
}

const client = new MockGatewayClient();

async function pull(from: string, to: string): Promise<GatewayUsage> {
  const snapshot = await client.fetchUsage(from, to);
  return {
    daily: snapshot.daily.map(
      (row): GatewayDailyPoint => ({ ...row, spend: nanoToDollars(row.spendNano) }),
    ),
    breakdowns: snapshot.breakdowns.map(
      (row): GatewayBreakdownPoint => ({ ...row, spend: nanoToDollars(row.spendNano) }),
    ),
  };
}

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};
const close = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

const from = iso(-(DAYS - 1));
const to = iso(0);
const usage = await pull(from, iso(-1));
const summary = deriveGateway(usage, from, to);
const points = usage.breakdowns;

const compact = (value: number) =>
  value >= 1e9
    ? `${(value / 1e9).toFixed(2)}B`
    : value >= 1e6
      ? `${(value / 1e6).toFixed(1)}M`
      : value.toLocaleString();
const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

// ------------------------------------------------------------------ constants

// 1.25× to write, 0.1× to read: writing W costs 0.25·W over sending it plain,
// reading R back saves 0.9·R, so the cache is ahead above R/W = 0.25/0.9.
check(
  close(CACHE_BREAKEVEN_REUSE, (CACHE_WRITE_RATE - 1) / (1 - CACHE_READ_RATE), 1e-12) &&
    close(CACHE_BREAKEVEN_REUSE, 0.2777, 1e-3),
  `break-even reuse is ${CACHE_BREAKEVEN_REUSE.toFixed(4)}, expected ~0.2778`,
);

// --------------------------------------------------------------- gateway-wide

const tags = deriveGatewayCache(summary.daily, points, 'tag');

console.log(
  `${summary.daily.length}d spine · ${compact(tags.inputTokens)} input tokens · ${pct(tags.hitRate)} from cache · ${tags.reusePerWrite?.toFixed(1) ?? 'n/a'} reads per write`,
);
console.log(
  `  uncached ${compact(tags.uncachedTokens)} · written ${compact(tags.writeTokens)} · headroom ${compact(tags.headroomTokens)} · saving ratio ${pct(tags.estimatedSavingRatio)}`,
);

check(hasCacheActivity(tags), 'the mock reported no prompt-cache activity at all');
check(
  tags.cachedTokens + tags.writeTokens + tags.uncachedTokens === tags.inputTokens,
  'gateway cached + written + uncached does not equal input tokens',
);
check(
  tags.hitRate !== null && close(tags.hitRate, tags.cachedTokens / tags.inputTokens, 1e-12),
  'gateway hit rate is not cached ÷ input',
);
check(
  tags.estimatedSavingRatio !== null && tags.estimatedSavingRatio > 0,
  `gateway saving ratio is ${pct(tags.estimatedSavingRatio)} — the mock caches profitably overall`,
);

// The days are the spine and nothing else: same length, same order, summing to
// the range totals.
check(tags.daily.length === summary.daily.length, 'cache daily length does not match the spine');
check(
  tags.daily.every((day, index) => day.date === summary.daily[index]?.date),
  'cache daily dates do not match the spine',
);
check(
  tags.daily.reduce((total, day) => total + day.inputTokens, 0) === tags.inputTokens &&
    tags.daily.reduce((total, day) => total + day.cachedTokens, 0) === tags.cachedTokens,
  'cache daily rows do not sum to the range totals',
);
check(
  tags.daily.every(
    (day) =>
      day.cachedTokens <= day.inputTokens &&
      (day.hitRate === null
        ? day.inputTokens === 0
        : close(day.hitRate, day.cachedTokens / day.inputTokens, 1e-12)),
  ),
  'a cache day has an inconsistent hit rate',
);

// ------------------------------------------------------- dimension invariants

for (const dimension of GATEWAY_DIMENSIONS) {
  const view = deriveGatewayCache(summary.daily, points, dimension);
  if (view.rows.length === 0) continue;

  const rowInput = view.rows.reduce((total, row) => total + row.inputTokens, 0);
  const rowUncached = view.rows.reduce((total, row) => total + row.uncachedTokens, 0);
  const rowCached = view.rows.reduce((total, row) => total + row.cachedTokens, 0);
  const shares = view.rows.reduce((total, row) => total + row.shareOfUncached, 0);

  check(
    view.rows.every(
      (row) => row.cachedTokens + row.writeTokens + row.uncachedTokens === row.inputTokens,
    ),
    `${dimension}: a row's cached + written + uncached does not equal its input`,
  );

  if (dimension === 'mcp_server') {
    // A subset of the same calls — it may not reconstitute the totals, and must
    // not exceed them.
    check(
      rowInput < view.inputTokens && rowUncached < view.uncachedTokens,
      'mcp_server does not read as a strict subset of the gateway input',
    );
    check(shares < 1, `mcp_server shares sum to ${shares.toFixed(3)}, expected below 1`);
    continue;
  }

  // Full-coverage dimensions re-slice the same tokens, so each must rebuild the
  // gateway-wide numbers exactly. Rounding in the mock's per-row token maths is
  // the only slack allowed.
  const tolerance = Math.max(64, view.inputTokens * 1e-9);
  check(
    close(rowInput, view.inputTokens, tolerance),
    `${dimension}: rows sum to ${compact(rowInput)} input against ${compact(view.inputTokens)} gateway-wide`,
  );
  check(
    close(rowCached, view.cachedTokens, tolerance) &&
      close(rowUncached, view.uncachedTokens, tolerance),
    `${dimension}: rows do not reconstitute the cached/uncached split`,
  );
  check(close(shares, 1, 1e-6), `${dimension}: uncached shares sum to ${shares.toFixed(6)}`);

  // Ranked by the size of the opportunity, descending.
  check(
    view.rows.every(
      (row, index) => index === 0 || row.uncachedTokens <= (view.rows[index - 1]?.uncachedTokens ?? 0),
    ),
    `${dimension}: rows are not ordered by uncached tokens`,
  );

  // Headroom is a levelling-up, so it is bounded on both sides and is exactly
  // the sum of the per-row shortfalls the card would draw.
  const shortfall = view.rows.reduce(
    (total, row) => total + Math.max(0, row.inputTokens * (view.hitRate ?? 0) - row.cachedTokens),
    0,
  );
  check(
    close(view.headroomTokens, shortfall, 1e-6 * Math.max(1, shortfall)),
    `${dimension}: headroom is not the sum of per-row shortfalls`,
  );
  check(
    view.headroomTokens >= 0 && view.headroomTokens <= view.uncachedTokens,
    `${dimension}: headroom ${compact(view.headroomTokens)} outside [0, ${compact(view.uncachedTokens)}]`,
  );
}

// ------------------------------------------------------------ planted regimes

console.log(`\ntag cache regimes (${tags.rows.length} rows)`);
for (const row of tags.rows) {
  console.log(
    `  ${row.key.padEnd(22)} ${pct(row.hitRate).padStart(6)} hit · ${(row.reusePerWrite?.toFixed(2) ?? 'n/a').padStart(6)} reads/write · ${compact(row.uncachedTokens).padStart(8)} uncached · ${row.state}`,
  );
}

const churning = tags.rows.find((row) => row.key === CHURNING_TAG);
check(churning !== undefined, `the mock reported no ${CHURNING_TAG} tag`);
check(
  churning !== undefined &&
    churning.reusePerWrite !== null &&
    churning.reusePerWrite < CACHE_BREAKEVEN_REUSE,
  `${CHURNING_TAG} reads back ${churning?.reusePerWrite?.toFixed(3) ?? 'n/a'} per write, expected below the break-even`,
);
check(
  churning?.state === 'churning',
  `${CHURNING_TAG} classified as ${churning?.state ?? 'missing'}, expected churning`,
);

const unused = tags.rows.find((row) => row.key === UNUSED_TAG);
check(
  unused !== undefined && unused.cachedTokens === 0 && unused.writeTokens === 0,
  `${UNUSED_TAG} was expected to touch the cache not at all`,
);
check(
  unused?.state === 'unused',
  `${UNUSED_TAG} classified as ${unused?.state ?? 'missing'}, expected unused`,
);
check(
  unused !== undefined && unused.reusePerWrite === null && unused.hitRate === 0,
  `${UNUSED_TAG} should have a null reuse (nothing written) and a real 0% hit rate`,
);

for (const tag of CACHING_TAGS) {
  const row = tags.rows.find((entry) => entry.key === tag);
  check(row !== undefined, `the mock reported no ${tag} tag`);
  check(
    row !== undefined && row.reusePerWrite !== null && row.reusePerWrite > CACHE_BREAKEVEN_REUSE,
    `${tag} reads back ${row?.reusePerWrite?.toFixed(2) ?? 'n/a'} per write, expected above the break-even`,
  );
  check(row?.state === 'ok', `${tag} classified as ${row?.state ?? 'missing'}, expected ok`);
}

// The badge is a claim about money, and the payload can settle it: the churning
// workload pays more per input token than the gateway average, while the keys
// whose caches pay for themselves pay less. Nothing on a spend-shaped card can
// draw that distinction — a churning key just looks busy.
const keys = deriveGatewayCache(summary.daily, points, 'api_key');
const spendPerInput = new Map<string, number>();
for (const point of points) {
  if (point.dimension !== 'api_key') continue;
  const previous = spendPerInput.get(point.key) ?? 0;
  spendPerInput.set(point.key, previous + point.spend);
}
const gatewaySpend = summary.daily.reduce((total, day) => total + day.spend, 0);
const gatewayUnitCost = gatewaySpend / keys.inputTokens;
const churningKey = keys.rows.find((row) => row.label === CHURNING_KEY_ALIAS);
check(churningKey !== undefined, `the mock reported no ${CHURNING_KEY_ALIAS} key`);
if (churningKey !== undefined) {
  const unitCost = (spendPerInput.get(churningKey.key) ?? 0) / churningKey.inputTokens;
  console.log(
    `\n${CHURNING_KEY_ALIAS}: $${(unitCost * 1e6).toFixed(2)} per M input tokens against $${(gatewayUnitCost * 1e6).toFixed(2)} gateway-wide`,
  );
  check(
    churningKey.state === 'churning',
    `${CHURNING_KEY_ALIAS} classified as ${churningKey.state}, expected churning`,
  );
  check(
    unitCost > gatewayUnitCost,
    `${CHURNING_KEY_ALIAS} costs $${(unitCost * 1e6).toFixed(2)}/M input, not more than the gateway — the badge would be claiming something false`,
  );
}

// -------------------------------------------------------------------- edges

const day = (date: string, overrides: Partial<GatewayDailyPoint>): GatewayDailyPoint => ({
  date,
  spend: 0,
  requests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  ...overrides,
});

const row = (
  key: string,
  overrides: Partial<GatewayBreakdownPoint>,
): GatewayBreakdownPoint => ({
  ...day('2026-01-01', {}),
  dimension: 'api_key',
  key,
  label: null,
  ...overrides,
});

const empty = deriveGatewayCache([], [], 'api_key');
check(
  empty.inputTokens === 0 &&
    empty.hitRate === null &&
    empty.reusePerWrite === null &&
    empty.estimatedSavingRatio === null &&
    empty.rows.length === 0 &&
    empty.headroomTokens === 0,
  'an empty range does not derive an empty cache summary',
);
check(!hasCacheActivity(empty), 'an empty range reads as having cache activity');

// A gateway whose backends have no prompt cache: real traffic, both counters
// zero. Every rate is a genuine 0%, not an unknown, and the card stands down.
const noCache = deriveGatewayCache(
  [day('2026-01-01', { promptTokens: 5_000_000 })],
  [row('k1', { promptTokens: 5_000_000 })],
  'api_key',
);
check(
  noCache.hitRate === 0 &&
    noCache.reusePerWrite === null &&
    noCache.headroomTokens === 0 &&
    !hasCacheActivity(noCache),
  'a gateway with no prompt cache at all is misread',
);
check(
  noCache.rows[0]?.state === 'unused',
  `a material key touching no cache is ${noCache.rows[0]?.state ?? 'missing'}, expected unused`,
);

// Same shape, four thousand tokens: below the materiality floor, so it ranks
// but carries no badge. "This key never caches" is not a finding at that size.
const tiny = deriveGatewayCache(
  [day('2026-01-01', { promptTokens: 4_000 })],
  [row('k1', { promptTokens: 4_000 })],
  'api_key',
);
check(tiny.rows[0]?.state === 'ok', 'a negligible key was badged for not caching');

// Writes with no reads at all — the churn regime at its limit. Reuse is 0,
// which is below the break-even, and the state has to say so rather than
// falling through to `unused` on the strength of a zero hit rate.
const writeOnly = deriveGatewayCache(
  [day('2026-01-01', { promptTokens: 5_000_000, cacheCreationTokens: 900_000 })],
  [row('k1', { promptTokens: 5_000_000, cacheCreationTokens: 900_000 })],
  'api_key',
);
check(
  writeOnly.rows[0]?.state === 'churning' && writeOnly.rows[0]?.reusePerWrite === 0,
  `a write-only key is ${writeOnly.rows[0]?.state ?? 'missing'}, expected churning`,
);
check(
  writeOnly.estimatedSavingRatio !== null && writeOnly.estimatedSavingRatio < 0,
  'a write-only gateway should report a negative saving ratio — it is paying the premium for nothing',
);

// Two rows already at the gateway rate: nothing to level up to, so no headroom.
const even = deriveGatewayCache(
  [day('2026-01-01', { promptTokens: 8_000_000, cacheReadTokens: 2_000_000 })],
  [
    row('k1', { promptTokens: 4_000_000, cacheReadTokens: 1_000_000 }),
    row('k2', { promptTokens: 4_000_000, cacheReadTokens: 1_000_000 }),
  ],
  'api_key',
);
check(
  close(even.headroomTokens, 0, 1e-6),
  `an evenly-caching gateway reports ${compact(even.headroomTokens)} of headroom, expected none`,
);

// ------------------------------------------------------------------- verdict

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('\nall cache checks passed');
