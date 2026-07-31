/**
 * Ad-hoc check of the web app's volume/mix/rate decomposition against a real
 * mock-source payload. Not a test suite (the repo has none) — run it by hand:
 *
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-mix.ts
 *
 * It sits outside apps/api's tsconfig `include` on purpose: it imports the web
 * app's metrics modules, which do not belong in the API's build.
 *
 * What it proves:
 *
 * - the split is an identity, not an attribution: per key, volume + mix + rate
 *   equals that key's own spend delta to the cent, and summed across a
 *   dimension that reconstitutes the totals it equals the gateway-wide spend
 *   delta with nothing unexplained. That is the one property that makes the
 *   card readable as three reasons rather than three opinions;
 * - the three effects isolate what they claim to, proven on constructed
 *   payloads where only one thing changed: doubling every key's tokens at fixed
 *   prices is pure volume, re-weighting a fixed token count toward a dearer key
 *   is pure mix, and re-pricing a fixed mix is pure rate;
 * - the overlap invariant holds here as everywhere else — every full-coverage
 *   dimension decomposes the *same* movement into the same total, while
 *   `mcp_server` is a strict subset and is refused rather than reported short;
 * - arrivals and departures are handled by the identity rather than by a
 *   special case: a key with no prior tokens is priced at the gateway's prior
 *   blended rate, and a key that vanished still reconciles;
 * - the edges behave: an empty prior window, a token-free window, a movement
 *   too small to have a reason, and a dimension the proxy never answered.
 */
import { MockGatewayClient } from '../src/gateway/mock.js';
import { nanoToDollars } from '../src/lib/nano.js';
import { EMPTY_GATEWAY_METRICS, GATEWAY_DIMENSIONS, sumGatewayMetrics } from '@dash/shared';
import type {
  GatewayBreakdownPoint,
  GatewayDailyPoint,
  GatewayDimension,
  GatewayMetrics,
  GatewayUsage,
} from '@dash/shared';
import { deriveGateway } from '../../web/src/lib/metrics/gateway.js';
import type { GatewayBreakdownRow } from '../../web/src/lib/metrics/gateway.js';
import { comparisonWindow } from '../../web/src/lib/metrics/gatewayCompare.js';
import type { ComparisonWindow } from '../../web/src/lib/metrics/gatewayCompare.js';
import { deriveGatewayMix, dominantEffect, hasMixSignal } from '../../web/src/lib/metrics/gatewayMix.js';

const DAYS = 30;
const MS_PER_DAY = 86_400_000;

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
const money = (value: number) => `$${value.toFixed(2)}`;

// --------------------------------------------------------------- live payload

const from = iso(-(DAYS - 1));
const to = iso(0);
const usage = await pull(from, to);
const summary = deriveGateway(usage, from, to);

const window = comparisonWindow(summary.daily);
if (window === null) {
  console.error('no spine — the mock returned nothing to compare');
  process.exit(1);
}

const priorUsage = await pull(window.from, window.to);
const priorTotals = sumGatewayMetrics(priorUsage.daily);

console.log(
  `current ${summary.daily[0]?.date} … ${summary.daily.at(-1)?.date} ` +
    `(${summary.daily.length}d, ${money(summary.totals.spend)})`,
);
console.log(`prior   ${window.from} … ${window.to} (${window.days}d, ${money(priorTotals.spend)})`);

const deltaSpend = summary.totals.spend - priorTotals.spend;
console.log(
  `movement ${money(deltaSpend)} · ` +
    `$${((priorTotals.spend / priorTotals.totalTokens) * 1e6).toFixed(2)}/M → ` +
    `$${((summary.totals.spend / summary.totals.totalTokens) * 1e6).toFixed(2)}/M\n`,
);

// ------------------------------------------- 1. the identity, every dimension

const FULL_COVERAGE: GatewayDimension[] = GATEWAY_DIMENSIONS.filter(
  (dimension) => dimension !== 'mcp_server',
);

for (const dimension of FULL_COVERAGE) {
  const rows = summary.breakdowns[dimension];
  if (rows.length === 0) continue;

  const split = deriveGatewayMix(
    rows,
    priorUsage.breakdowns,
    dimension,
    summary.totals,
    priorTotals,
    window,
  );
  if (split === null) {
    failures.push(`${dimension}: no decomposition at all`);
    continue;
  }

  const tolerance = Math.max(1e-6, Math.abs(deltaSpend) * 1e-9);

  check(
    close(split.volume + split.mix + split.rate, split.delta, tolerance),
    `${dimension}: volume+mix+rate ${money(split.volume + split.mix + split.rate)} ` +
      `≠ gateway movement ${money(split.delta)}`,
  );
  check(
    close(split.unexplained, 0, tolerance),
    `${dimension}: ${money(split.unexplained)} of the movement is unexplained`,
  );
  check(split.usable, `${dimension}: reconstitutes the totals but is marked unusable`);
  check(
    close(split.delta, deltaSpend, 1e-9),
    `${dimension}: decomposing a different movement than the gateway's`,
  );

  // Per-key exactness — the property that makes the table a decomposition.
  for (const row of split.rows) {
    const own = row.currentSpend - row.previousSpend;
    check(
      close(row.total, own, Math.max(1e-9, Math.abs(own) * 1e-9)),
      `${dimension}/${row.key}: effects ${money(row.total)} ≠ own delta ${money(own)}`,
    );
  }

  // The headline is the sum of the rows, never a second derivation of it.
  const rowVolume = split.rows.reduce((sum, row) => sum + row.volume, 0);
  const rowMix = split.rows.reduce((sum, row) => sum + row.mix, 0);
  const rowRate = split.rows.reduce((sum, row) => sum + row.rate, 0);
  check(
    close(rowVolume, split.volume, 1e-9) &&
      close(rowMix, split.mix, 1e-9) &&
      close(rowRate, split.rate, 1e-9),
    `${dimension}: the headline effects disagree with the rows that make them up`,
  );

  // Rows are ranked by what volume does *not* explain.
  const ranks = split.rows.map((row) => Math.abs(row.mix + row.rate));
  check(
    ranks.every((value, index) => index === 0 || value <= (ranks[index - 1] ?? Infinity) + 1e-9),
    `${dimension}: rows are not ordered by |mix + rate|`,
  );

  // Shares are of the gateway's tokens, and a full-coverage dimension's sum to 1.
  const shareNow = split.rows.reduce((sum, row) => sum + row.currentShare, 0);
  const shareBefore = split.rows.reduce((sum, row) => sum + row.previousShare, 0);
  check(
    close(shareNow, 1, 1e-6) && close(shareBefore, 1, 1e-6),
    `${dimension}: token shares sum to ${shareBefore.toFixed(4)} → ${shareNow.toFixed(4)}, expected 1`,
  );

  console.log(
    `  ${dimension.padEnd(11)} volume ${money(split.volume).padStart(11)} · ` +
      `mix ${money(split.mix).padStart(10)} · rate ${money(split.rate).padStart(10)} · ` +
      `drives ${dominantEffect(split)}`,
  );
}

// Every full-coverage dimension decomposes the same movement — different
// stories about the same dollar, which is exactly the overlap invariant.
const drivers = new Map<GatewayDimension, number>();
for (const dimension of FULL_COVERAGE) {
  const rows = summary.breakdowns[dimension];
  if (rows.length === 0) continue;
  const split = deriveGatewayMix(
    rows,
    priorUsage.breakdowns,
    dimension,
    summary.totals,
    priorTotals,
    window,
  );
  if (split !== null) drivers.set(dimension, split.volume);
}
const volumes = [...drivers.values()];
check(
  volumes.every((value) => close(value, volumes[0] ?? 0, Math.max(1e-6, Math.abs(deltaSpend) * 1e-6))),
  `the volume effect differs by dimension (${volumes.map((v) => money(v)).join(', ')}) — ` +
    'it is a gateway-wide quantity and must not',
);

// -------------------------------------------------- 2. mcp_server is refused

const mcpRows = summary.breakdowns.mcp_server;
if (mcpRows.length > 0) {
  const split = deriveGatewayMix(
    mcpRows,
    priorUsage.breakdowns,
    'mcp_server',
    summary.totals,
    priorTotals,
    window,
  );
  check(split !== null, 'mcp_server produced no decomposition at all, expected an unusable one');
  check(
    split === null || !split.usable,
    'mcp_server is a strict subset and must be refused, not reported short',
  );
  check(
    split === null || split.currentCoverage < 0.99,
    `mcp_server coverage reads ${((split?.currentCoverage ?? 1) * 100).toFixed(1)}%, expected a subset`,
  );
  check(!hasMixSignal(split), 'hasMixSignal accepted the mcp_server subset');
  console.log(
    `  mcp_server  refused · coverage ${((split?.currentCoverage ?? 0) * 100).toFixed(1)}% of spend\n`,
  );
}

// ------------------------------------------- 3. constructed single-cause runs

function metrics(spend: number, tokens: number): GatewayMetrics {
  return { ...EMPTY_GATEWAY_METRICS, spend, totalTokens: tokens, requests: 1 };
}

function currentRow(key: string, spend: number, tokens: number): GatewayBreakdownRow {
  return { key, label: null, metrics: metrics(spend, tokens), share: 0 };
}

function priorPoint(key: string, spend: number, tokens: number): GatewayBreakdownPoint {
  return {
    ...metrics(spend, tokens),
    date: '2026-01-01',
    dimension: 'model',
    key,
    label: null,
  };
}

const WINDOW: ComparisonWindow = { from: '2026-01-01', to: '2026-01-07', days: 7 };

function split(
  current: Array<[string, number, number]>,
  previous: Array<[string, number, number]>,
) {
  const rows = current.map(([key, spend, tokens]) => currentRow(key, spend, tokens));
  const points = previous.map(([key, spend, tokens]) => priorPoint(key, spend, tokens));
  const totalsNow = sumGatewayMetrics(rows.map((row) => row.metrics));
  const totalsBefore = sumGatewayMetrics(points);
  return deriveGatewayMix(rows, points, 'model', totalsNow, totalsBefore, WINDOW);
}

// Pure volume: same two models, same prices ($10/M and $2/M), same 50/50 mix,
// twice the tokens. Everything must land in volume.
const pureVolume = split(
  [
    ['gpt-4o', 20, 2_000_000],
    ['haiku', 4, 2_000_000],
  ],
  [
    ['gpt-4o', 10, 1_000_000],
    ['haiku', 2, 1_000_000],
  ],
);
check(pureVolume !== null, 'pure-volume case produced no decomposition');
if (pureVolume !== null) {
  check(
    close(pureVolume.volume, 12, 1e-9) &&
      close(pureVolume.mix, 0, 1e-9) &&
      close(pureVolume.rate, 0, 1e-9),
    `doubling the tokens at fixed prices reads as volume ${money(pureVolume.volume)}, ` +
      `mix ${money(pureVolume.mix)}, rate ${money(pureVolume.rate)} — expected $12/$0/$0`,
  );
  check(dominantEffect(pureVolume) === 'volume', 'pure-volume case does not name volume as the driver');
}

// Pure mix: same 2M tokens, same per-model prices, traffic moved from the cheap
// model to the dear one. Volume and rate must both be zero.
const pureMix = split(
  [
    ['gpt-4o', 15, 1_500_000],
    ['haiku', 1, 500_000],
  ],
  [
    ['gpt-4o', 10, 1_000_000],
    ['haiku', 2, 1_000_000],
  ],
);
check(pureMix !== null, 'pure-mix case produced no decomposition');
if (pureMix !== null) {
  check(
    close(pureMix.volume, 0, 1e-9) && close(pureMix.rate, 0, 1e-9) && close(pureMix.mix, 4, 1e-9),
    `a pure routing shift reads as volume ${money(pureMix.volume)}, mix ${money(pureMix.mix)}, ` +
      `rate ${money(pureMix.rate)} — expected $0/$4/$0`,
  );
  check(dominantEffect(pureMix) === 'mix', 'pure-mix case does not name mix as the driver');
  check(
    pureMix.priceAtPriorRates > pureMix.previousPrice &&
      close(pureMix.priceAtPriorRates, pureMix.currentPrice, 1e-9),
    'a pure mix shift must move the whole price change into the prior-rates midpoint',
  );
}

// Pure rate: same tokens, same mix, one model got 20% dearer.
const pureRate = split(
  [
    ['gpt-4o', 12, 1_000_000],
    ['haiku', 2, 1_000_000],
  ],
  [
    ['gpt-4o', 10, 1_000_000],
    ['haiku', 2, 1_000_000],
  ],
);
check(pureRate !== null, 'pure-rate case produced no decomposition');
if (pureRate !== null) {
  check(
    close(pureRate.volume, 0, 1e-9) && close(pureRate.mix, 0, 1e-9) && close(pureRate.rate, 2, 1e-9),
    `a price change reads as volume ${money(pureRate.volume)}, mix ${money(pureRate.mix)}, ` +
      `rate ${money(pureRate.rate)} — expected $0/$0/$2`,
  );
  check(dominantEffect(pureRate) === 'rate', 'pure-rate case does not name rate as the driver');
  check(
    close(pureRate.priceAtPriorRates, pureRate.previousPrice, 1e-9),
    'a pure rate change must leave the prior-rates midpoint at the prior price',
  );
}

// An arrival and a departure in one movement: a model that did not exist gets
// half the tokens, one that did vanishes. The identity has to hold anyway.
const churn = split(
  [
    ['gpt-4o', 10, 1_000_000],
    ['sonnet-5', 9, 1_000_000],
  ],
  [
    ['gpt-4o', 10, 1_000_000],
    ['haiku', 2, 1_000_000],
  ],
);
check(churn !== null, 'arrival/departure case produced no decomposition');
if (churn !== null) {
  check(
    close(churn.volume + churn.mix + churn.rate, churn.delta, 1e-9) &&
      close(churn.unexplained, 0, 1e-9),
    'a window where one model arrived and another vanished does not reconcile',
  );
  const arrival = churn.rows.find((row) => row.key === 'sonnet-5');
  const departure = churn.rows.find((row) => row.key === 'haiku');
  check(
    arrival?.previousPrice === null && arrival?.currentPrice === 9,
    'an arriving key must report no prior price rather than a zero one',
  );
  check(
    departure?.currentPrice === null && close(departure?.total ?? 0, -2, 1e-9),
    'a departing key must report no current price and give back exactly its own spend',
  );
  // Priced at the gateway's prior blended rate ($6/M), the arrival's $9/M shows
  // as $6 of mix (traffic moved to it) and $3 of rate (it is dearer than what
  // the gateway used to pay).
  check(
    close(arrival?.mix ?? 0, 6, 1e-9) && close(arrival?.rate ?? 0, 3, 1e-9),
    `the arrival splits as mix ${money(arrival?.mix ?? 0)} / rate ${money(arrival?.rate ?? 0)}, ` +
      'expected $6/$3 against the gateway prior blended price',
  );
}

// A partially attributed dimension is refused for the same reason mcp_server
// is: the rows cover 70% of the spend and can only explain 70% of the movement.
const partial = deriveGatewayMix(
  [currentRow('alice', 7, 700_000)],
  [priorPoint('alice', 5, 500_000)],
  'model',
  metrics(10, 1_000_000),
  metrics(8, 800_000),
  WINDOW,
);
check(
  partial !== null && !partial.usable && partial.unexplained !== 0,
  'a 70%-covered dimension must be refused rather than explaining 70% of the movement',
);

// ------------------------------------------------------------------ 4. edges

check(
  split([['gpt-4o', 10, 1_000_000]], []) === null,
  'a window with no prior traffic must produce no decomposition — there is no baseline',
);
check(
  split([], [['gpt-4o', 10, 1_000_000]]) === null,
  'a current window with no tokens must produce no decomposition',
);
check(
  deriveGatewayMix(
    summary.breakdowns.model,
    priorUsage.breakdowns,
    'tag',
    summary.totals,
    priorTotals,
    window,
  )?.rows.every((row) => row.currentTokens === 0) !== true,
  'passing one dimension\'s rows with another\'s name must not silently produce a decomposition of nothing',
);

// A movement too small to have a reason is not rendered.
const flat = split(
  [['gpt-4o', 10.02, 1_002_000]],
  [['gpt-4o', 10, 1_000_000]],
);
check(
  flat !== null && flat.usable && !hasMixSignal(flat),
  'a 0.2% movement must reconcile but not be worth a card',
);

// ...but a flat *bill* hiding offsetting effects is the case the card exists
// for: 20% fewer tokens at a 25% dearer blended price nets out to nothing, and
// every other card on the page reports a quiet month.
const offsetting = split(
  [['gpt-4o', 100, 8_000_000]],
  [['gpt-4o', 100, 10_000_000]],
);
check(offsetting !== null, 'the offsetting case produced no decomposition');
if (offsetting !== null) {
  check(
    close(offsetting.delta, 0, 1e-9) &&
      close(offsetting.volume, -20, 1e-9) &&
      close(offsetting.rate, 20, 1e-9),
    `a flat bill on 20% fewer, dearer tokens reads as volume ${money(offsetting.volume)} / ` +
      `rate ${money(offsetting.rate)}, expected −$20/+$20`,
  );
  check(
    hasMixSignal(offsetting),
    'a flat bill hiding $20 of volume against $20 of rate must still be worth a card',
  );
}

// The live mock is the same shape at a smaller scale — the gate has to let the
// real payload through, or the card is dead in dev and unverifiable.
const livePayloadModel = deriveGatewayMix(
  summary.breakdowns.model,
  priorUsage.breakdowns,
  'model',
  summary.totals,
  priorTotals,
  window,
);
check(
  hasMixSignal(livePayloadModel),
  'the mock payload does not clear the signal gate — the card would never render in dev',
);

// ------------------------------------------------------------------- verdict

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('\nall mix checks passed');
