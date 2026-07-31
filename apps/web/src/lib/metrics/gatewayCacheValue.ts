import { cacheReadShare, inputTokens, resolveModelPrice, uncachedInputTokens } from '@dash/shared';
import type { GatewayMetrics, GatewayModelPrice } from '@dash/shared';
import type { GatewayBreakdownRow } from './gateway.js';

/**
 * What the prompt cache is **worth in dollars**, priced from the catalogue.
 *
 * `gatewayCache.ts` reports tokens and refuses dollars, and the refusal is
 * correct on its own inputs: the proxy's daily row carries one `spend` covering
 * input, output, cache reads and cache writes together, with no per-model price
 * to split it by. Four rates per model is exactly what lifts that refusal, and
 * `GET /api/gateway/models` now carries them — so this module is the cache card
 * read through the price list rather than through a convention.
 *
 * The arithmetic is a subtraction against a counterfactual, not a re-pricing of
 * the bill:
 *
 * ```
 *   billed input   = uncached·input + read·readRate + write·writeRate
 *   no-cache input = (uncached + read + write)·input
 *   saving         = read·(input − readRate) − write·(writeRate − input)
 * ```
 *
 * Output tokens cancel and are left out entirely — the cache cannot touch them,
 * and including them would bury the number this card exists to state.
 *
 * Four rules, three of them inherited and one new:
 *
 *  - **Pinned to the `model` dimension.** This is the reason the card could not
 *    be built before and the reason it cannot follow the switcher: one `team`'s
 *    cached tokens span every model it touched, at rates differing by a factor,
 *    so a single saving figure for a team would be an average of price lists.
 *    A model is the finest key the catalogue can price and the coarsest key that
 *    carries exactly one price.
 *  - **A missing cache rate is unknown, never zero.** `repriceMetrics` in
 *    `gatewayCatalog.ts` falls back to the input rate when a backend prices no
 *    cache separately, and that is right there: it is reconstructing a *total*,
 *    and a backend with no cache column charges input for those tokens. Here the
 *    quantity is the *difference* between two rates, and the same fallback would
 *    silently report a saving of exactly zero for every such model — an
 *    assertion that the cache does nothing, made out of a null. Those rows are
 *    excluded and counted, in the same null-vs-zero shape the budget snapshot
 *    and the catalogue itself carry.
 *  - **A floor is never mixed into a rate.** A `priceVaries` alias reports the
 *    cheapest of several deployments, so its rate *spread* is a lower bound too.
 *    It is priced and shown, but kept out of the headline the same way
 *    `gatewayCatalog` keeps it out of the aggregate ratio — an aggregate that
 *    mixes a rate with a floor is neither.
 *  - **An estimate, never the bill.** Nothing here is subtracted from `spend`,
 *    and no other card reads these numbers. The list price ignores every
 *    discount and per-key override the account carries, which is exactly the gap
 *    the catalogue card measures.
 *
 * Pure, like every module in `lib/metrics/` — it reads the ranked `model` rows
 * already on screen and the catalogue already fetched, and never fetches.
 */

/** Why a model in the window carries no priced saving. */
export type CacheValueGap =
  /** No catalogue entry resolved — the proxy billed a model it does not list. */
  | 'unlisted'
  /** Listed with no per-token input rate: per-second billing, or an unresolvable model. */
  | 'unpriced'
  /**
   * Priced for input, but the rate this row needs is absent: a cache read rate
   * for a model that read from cache, or a write rate for one that wrote. Never
   * read as "no discount" — that is the null-vs-zero rule.
   */
  | 'no_cache_rate';

export interface CacheValueRow {
  /** The `model` dimension's key, exactly as the proxy reported it. */
  key: string;
  label: string | null;
  /** Prompt tokens the provider served from its cache. */
  cachedTokens: number;
  /** Prompt tokens billed at the full input rate. */
  uncachedTokens: number;
  /** Tokens written into the cache, billed at a premium. */
  writeTokens: number;
  /** The catalogue rates this row was priced at, in dollars per million. */
  inputPerMillion: number;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
  /** Dollars the reads kept off the bill: `read · (input − readRate)`. */
  readSaving: number;
  /** Dollars the writes added to it: `write · (writeRate − input)`. Signed. */
  writePremium: number;
  /** `readSaving − writePremium`. Negative on a workload that writes and does not read back. */
  netSaving: number;
  /** What this row's input tokens would have cost with no cache at all. */
  noCacheInputCost: number;
  /** `netSaving ÷ noCacheInputCost`, signed. Null when the row sent no input. */
  savingShare: number | null;
  /**
   * Uncached tokens that would move into cache if this model merely reached the
   * gateway-wide hit rate, priced at this model's own read discount. A floor on
   * the opportunity — levelling to the gateway's own behaviour, not to 100%,
   * exactly as `gatewayCache.headroomTokens` does in tokens.
   */
  headroomTokens: number;
  headroomValue: number;
  /** The alias is served by several deployments: every figure above is a lower bound. */
  isFloor: boolean;
}

/** A model in the window the catalogue could not value, and why. */
export interface CacheValueGapRow {
  key: string;
  label: string | null;
  gap: CacheValueGap;
  /** Cache tokens (read + write) this model carried — the size of what is unpriced. */
  cacheTokens: number;
  spend: number;
}

export interface CacheValueSummary {
  /** Priced firm-rate rows, ranked by net saving, biggest contributor first. */
  rows: CacheValueRow[];
  /** Priced rows whose alias is served by several deployments — floors, kept separate. */
  floorRows: CacheValueRow[];
  /** Models with cache activity the catalogue could not value. */
  gaps: CacheValueGapRow[];
  /** Firm-rate rows whose cache costs more than it saves, most negative first. */
  costing: CacheValueRow[];
  /** Sum over firm-rate rows only. */
  readSaving: number;
  writePremium: number;
  netSaving: number;
  noCacheInputCost: number;
  /** `netSaving ÷ noCacheInputCost` over firm-rate rows. Null when none carried input. */
  savingShare: number | null;
  /** Headroom over firm-rate rows, in tokens and in dollars at their own read discounts. */
  headroomTokens: number;
  headroomValue: number;
  /** The same net saving over the floor rows — a lower bound, reported apart. */
  floorNetSaving: number;
  /**
   * Cache tokens (read + write) on firm-rate rows ÷ every cache token the
   * gateway reported. The number this card leads with, for the same reason
   * `gatewayCatalog` leads with catalogue coverage and `gatewayAdoption` with
   * attribution coverage: everything below it describes only that share.
   */
  coverage: number;
  /** Cache tokens on firm-rate rows, and gateway-wide — coverage's two halves. */
  pricedCacheTokens: number;
  gatewayCacheTokens: number;
}

export const EMPTY_CACHE_VALUE_SUMMARY: CacheValueSummary = {
  rows: [],
  floorRows: [],
  gaps: [],
  costing: [],
  readSaving: 0,
  writePremium: 0,
  netSaving: 0,
  noCacheInputCost: 0,
  savingShare: null,
  headroomTokens: 0,
  headroomValue: 0,
  floorNetSaving: 0,
  coverage: 0,
  pricedCacheTokens: 0,
  gatewayCacheTokens: 0,
};

export interface CacheValueInput {
  /** The already-ranked rows of the `model` dimension — the same ones the breakdown table renders. */
  modelRows: readonly GatewayBreakdownRow[];
  catalogue: readonly GatewayModelPrice[];
  /**
   * Gateway-wide totals for the window, from the spine rather than from any
   * dimension. Two numbers are taken off them: coverage's denominator (every
   * cache token the proxy reported) and the hit rate every row's headroom is
   * levelled to.
   *
   * The rate comes from `cacheReadShare` in `@dash/shared` — the same helper
   * the cache card and the KPI read — because pricing on one convention and
   * levelling on another silently levels every model to a bar it already
   * clears and reports no headroom anywhere. That was the state of this repo
   * until the convention became one statement; see
   * `CACHE_TOKENS_INSIDE_PROMPT_TOKENS`.
   */
  gatewayTotals: Readonly<GatewayMetrics>;
}

/**
 * Which rates a row needs, given what it actually did.
 *
 * A model that never read from cache needs no read rate, and refusing to value
 * it would report a gap where there is nothing to value. The requirement is per
 * row and per counter, not per catalogue entry.
 */
function missingRate(
  price: GatewayModelPrice,
  cachedTokens: number,
  writeTokens: number,
): boolean {
  if (cachedTokens > 0 && price.cacheReadPerMillion === null) return true;
  if (writeTokens > 0 && price.cacheWritePerMillion === null) return true;
  return false;
}

function priceRow(
  row: GatewayBreakdownRow,
  price: GatewayModelPrice,
  input: number,
  gatewayHitRate: number | null,
): CacheValueRow {
  const cachedTokens = row.metrics.cacheReadTokens;
  const writeTokens = row.metrics.cacheCreationTokens;
  // Both cache counters sit inside `prompt_tokens`, so the tokens that paid the
  // full rate are what is left after taking both of them back out.
  const uncachedTokens = uncachedInputTokens(row.metrics);

  const readRate = price.cacheReadPerMillion ?? input;
  const writeRate = price.cacheWritePerMillion ?? input;

  const readSaving = (cachedTokens * (input - readRate)) / 1_000_000;
  const writePremium = (writeTokens * (writeRate - input)) / 1_000_000;
  // The counterfactual bill: every input token at the plain input rate, which
  // under the shared convention is `promptTokens` — cache counters included,
  // never added on top of it.
  const promptTokens = inputTokens(row.metrics);
  const noCacheInputCost = (promptTokens * input) / 1_000_000;

  // Headroom levels each row to the gateway's own hit rate over the same input
  // total the cache card uses, so the two cards level to one bar.
  const headroomTokens =
    gatewayHitRate === null ? 0 : Math.max(0, promptTokens * gatewayHitRate - cachedTokens);

  return {
    key: row.key,
    label: row.label,
    cachedTokens,
    uncachedTokens,
    writeTokens,
    inputPerMillion: input,
    cacheReadPerMillion: price.cacheReadPerMillion,
    cacheWritePerMillion: price.cacheWritePerMillion,
    readSaving,
    writePremium,
    netSaving: readSaving - writePremium,
    noCacheInputCost,
    savingShare: noCacheInputCost > 0 ? (readSaving - writePremium) / noCacheInputCost : null,
    headroomTokens,
    headroomValue: (headroomTokens * (input - readRate)) / 1_000_000,
    isFloor: price.priceVaries,
  };
}

/**
 * The prompt cache priced from the catalogue, over the window's `model` rows.
 *
 * Rows carrying no cache activity at all are dropped rather than priced at zero:
 * a model nobody cached is a row of the cache card's `unused` state, and listing
 * it here with $0.00 in every column would bury the models that have a number.
 */
export function deriveCacheValue(input: CacheValueInput): CacheValueSummary {
  const { modelRows, catalogue, gatewayTotals } = input;
  const gatewayCacheTokens = gatewayTotals.cacheReadTokens + gatewayTotals.cacheCreationTokens;
  // 0..1, from the shared helper — the percent form of the same number feeds
  // the KPI string, and multiplying a token count by it inflates headroom by
  // two orders of magnitude.
  const gatewayHitRate = cacheReadShare(gatewayTotals);

  if (modelRows.length === 0 || catalogue.length === 0) {
    return { ...EMPTY_CACHE_VALUE_SUMMARY, gatewayCacheTokens };
  }

  const firm: CacheValueRow[] = [];
  const floorRows: CacheValueRow[] = [];
  const gaps: CacheValueGapRow[] = [];

  for (const row of modelRows) {
    const cacheTokens = row.metrics.cacheReadTokens + row.metrics.cacheCreationTokens;
    if (cacheTokens === 0) continue;

    const price = resolveModelPrice(catalogue, row.key);
    const gap: CacheValueGap | null =
      price === null
        ? 'unlisted'
        : price.inputPerMillion === null
          ? 'unpriced'
          : missingRate(price, row.metrics.cacheReadTokens, row.metrics.cacheCreationTokens)
            ? 'no_cache_rate'
            : null;

    if (gap !== null || price === null || price.inputPerMillion === null) {
      gaps.push({
        key: row.key,
        label: row.label,
        gap: gap ?? 'unpriced',
        cacheTokens,
        spend: row.metrics.spend,
      });
      continue;
    }

    const priced = priceRow(row, price, price.inputPerMillion, gatewayHitRate);
    (priced.isFloor ? floorRows : firm).push(priced);
  }

  const byNetSaving = (a: CacheValueRow, b: CacheValueRow): number =>
    b.netSaving - a.netSaving || b.noCacheInputCost - a.noCacheInputCost || a.key.localeCompare(b.key);
  firm.sort(byNetSaving);
  floorRows.sort(byNetSaving);
  gaps.sort((a, b) => b.cacheTokens - a.cacheTokens || a.key.localeCompare(b.key));

  const sum = (pick: (row: CacheValueRow) => number): number =>
    firm.reduce((total, row) => total + pick(row), 0);

  const netSaving = sum((row) => row.netSaving);
  const noCacheInputCost = sum((row) => row.noCacheInputCost);
  const pricedCacheTokens = sum((row) => row.cachedTokens + row.writeTokens);

  return {
    rows: firm,
    floorRows,
    gaps,
    costing: firm.filter((row) => row.netSaving < 0).sort((a, b) => a.netSaving - b.netSaving),
    readSaving: sum((row) => row.readSaving),
    writePremium: sum((row) => row.writePremium),
    netSaving,
    noCacheInputCost,
    savingShare: noCacheInputCost > 0 ? netSaving / noCacheInputCost : null,
    headroomTokens: sum((row) => row.headroomTokens),
    headroomValue: sum((row) => row.headroomValue),
    floorNetSaving: floorRows.reduce((total, row) => total + row.netSaving, 0),
    coverage: gatewayCacheTokens > 0 ? pricedCacheTokens / gatewayCacheTokens : 0,
    pricedCacheTokens,
    gatewayCacheTokens,
  };
}

/**
 * Whether there is a priced saving to state at all.
 *
 * A gateway whose catalogue carries no cache rates values nothing, and a panel
 * of `—` next to the cache card's token figures reads as a broken card rather
 * than an absent price list. The gaps are still worth naming when *something*
 * was priced; when nothing was, the cache card stands the whole panel down and
 * keeps its own convention-weighted ratio, which needs no catalogue.
 */
export function hasCacheValue(summary: CacheValueSummary): boolean {
  return summary.rows.length > 0 || summary.floorRows.length > 0;
}
