import { inputTokens, resolveModelPrice, uncachedInputTokens } from '@dash/shared';
import type { GatewayMetrics, GatewayModelPrice } from '@dash/shared';
import type { GatewayBreakdownRow } from './gateway.js';

/**
 * The proxy's configured **price list**, read next to the spend it priced.
 *
 * Every other gateway card derives from `gateway_daily`: what the proxy
 * charged, sliced. This one is the only surface that joins the *catalogue*
 * (`GET /api/gateway/models`, one row per public model alias) to the `model`
 * usage dimension, and it exists to answer the one question the usage payload
 * cannot: the daily aggregate carries a single `spend` per row covering input,
 * output and both cache operations together, so nothing in it can say what a
 * token of any particular kind cost.
 *
 * Three rules, and none of them is a presentation preference:
 *
 *  - **A list rate is an estimate, never the bill.** Re-pricing a row's tokens
 *    from four published rates ignores every negotiated discount, per-key
 *    override and committed-throughput SKU the account might carry. The
 *    estimate is shown *beside* the billed figure, and the billed figure is the
 *    one every other card on the page reads.
 *  - **A `priceVaries` row is a floor, not a rate.** Several router deployments
 *    answer to one alias at different prices, and the daily aggregate has no
 *    deployment id to split them by, so the catalogue reports the cheapest.
 *    Its estimate is therefore a lower bound by construction — it is never
 *    flagged as a disagreement, and it never enters the aggregate ratio, or
 *    one PTU pool would read as gateway-wide under-pricing.
 *  - **A miss reduces coverage; it never resolves to a near-match.**
 *    `resolveModelPrice` tries the alias, then the backend routing string, then
 *    the deployment after the provider prefix, and then gives up. Coverage —
 *    the share of gateway spend sitting on models the catalogue can price — is
 *    the number this card leads with, in the same way `gatewayAdoption` leads
 *    with attribution coverage, and a fuzzy match would quietly destroy it.
 *
 * What the card is *for* is the residue: on a model whose catalogue price is a
 * firm rate, the estimate must reproduce the bill. When it does not, the list
 * price and the invoice disagree — a mis-configured deployment, an unrecorded
 * discount, or a model being served by something other than what the config
 * says. That is a finding no spend-shaped card can make, because both numbers
 * are needed to make it.
 */

/**
 * How far a firm-rate model may drift from its list price before the row is a
 * finding rather than rounding.
 *
 * 5% is above the noise floor of the arithmetic (nano-dollar integers, a token
 * split across four rates) and well below any discount worth naming: an
 * enterprise agreement is 15–40%, a mis-priced deployment is usually a factor.
 */
export const CATALOG_DRIFT_TOLERANCE = 0.05;

/** Why a model in the window carries no estimate. */
export type CatalogGap =
  /** No catalogue entry resolved — the proxy billed a model it does not list. */
  | 'unlisted'
  /**
   * Listed, but with no per-token rate: per-second billing, or a model
   * LiteLLM's price map cannot resolve. Never zero-filled — a `0` in the
   * catalogue means deliberately free and is a priced model.
   */
  | 'unpriced';

/** How a priced row's estimate compares with what the proxy billed. */
export type CatalogState =
  /** Within tolerance of the list price — the catalogue describes this model. */
  | 'matches'
  /** Billed materially above list. A surcharge, an override, or the wrong entry. */
  | 'above'
  /** Billed materially below list. A discount the catalogue does not record. */
  | 'below'
  /** Several deployments at different prices: the estimate is a lower bound. */
  | 'floor'
  /** Nothing to compare — see `gap`. */
  | 'unpriced';

export interface CatalogRow {
  /** The `model` dimension's key, exactly as the proxy reported it. */
  key: string;
  label: string | null;
  metrics: GatewayMetrics;
  /** Share of gateway-wide spend, like every other share on the page. */
  share: number;
  /** The catalogue entry the key resolved to, or null when it resolved to none. */
  price: GatewayModelPrice | null;
  /** Why there is no estimate, or null when there is one. */
  gap: CatalogGap | null;
  /** This row's tokens re-priced at the list rates, in dollars. */
  estimate: number | null;
  /**
   * `spend ÷ estimate`. 1.00 is a catalogue that describes the bill; above is
   * a surcharge, below is a discount — or, on a `floor` row, the spread between
   * the cheapest deployment and whatever mix actually served the traffic.
   */
  ratio: number | null;
  /** Blended $/1M tokens the proxy actually billed. Null with no tokens. */
  effectivePerMillion: number | null;
  /** The same blend at list rates — same token mix, so the mix cancels. */
  listPerMillion: number | null;
  state: CatalogState;
}

export interface CatalogSummary {
  /** Ranked by spend, like the breakdown table. */
  rows: CatalogRow[];
  /** Gateway-wide spend in the window — the denominator every share uses. */
  gatewaySpend: number;
  /** Spend the `model` dimension accounts for. Equal to `gatewaySpend` on a proxy that reports it fully. */
  modelSpend: number;
  /** Spend on models the catalogue could price. The number the card leads with. */
  pricedSpend: number;
  /** `pricedSpend ÷ gatewaySpend`, 0..1. Zero when nothing was spent. */
  coverage: number;
  /** Models seen in the window that resolved to no catalogue entry at all. */
  unlisted: CatalogRow[];
  /** Resolved, but with no per-token rate to price them by. */
  unpriced: CatalogRow[];
  /** Firm-rate rows whose bill and list price disagree past the tolerance. */
  drifting: CatalogRow[];
  /**
   * Estimate and bill summed over **firm-rate rows only**. Floor rows are
   * excluded on purpose: they are guaranteed to come in under, so folding them
   * in would report a discount the gateway may not have.
   */
  firmEstimate: number;
  firmBilled: number;
  /** `firmEstimate ÷ firmBilled`, or null when no firm-rate row carried spend. */
  firmRatio: number | null;
  /** Catalogue rows that saw no traffic in the window — configured, unused. */
  idleModels: GatewayModelPrice[];
  /** How many aliases the catalogue holds at all. Zero means it never answered. */
  catalogueSize: number;
}

export const EMPTY_CATALOG_SUMMARY: CatalogSummary = {
  rows: [],
  gatewaySpend: 0,
  modelSpend: 0,
  pricedSpend: 0,
  coverage: 0,
  unlisted: [],
  unpriced: [],
  drifting: [],
  firmEstimate: 0,
  firmBilled: 0,
  firmRatio: null,
  idleModels: [],
  catalogueSize: 0,
};

/**
 * One row's tokens at one entry's rates, in dollars.
 *
 * The split mirrors what the four catalogue columns actually price. LiteLLM's
 * `prompt_tokens` contains both cache counters (`CACHE_TOKENS_INSIDE_PROMPT_TOKENS`
 * in `@dash/shared`), so plain input is what `uncachedInputTokens` leaves —
 * pricing the whole prompt at the input rate would charge full price for every
 * cached token and overstate every cache-heavy workload, and adding the cache
 * counters back on top of it would bill them twice. Cache read and write fall back to the input rate rather
 * than to zero when the backend does not price them separately, because a
 * backend with no separate cache rate charges input for them.
 *
 * Null when either of the two rates every model must have is missing: an
 * estimate built from half a price list is not a cheaper estimate, it is a
 * wrong one.
 */
export function repriceMetrics(
  metrics: GatewayMetrics,
  price: GatewayModelPrice,
): number | null {
  if (price.inputPerMillion === null || price.outputPerMillion === null) return null;

  const uncachedInput = uncachedInputTokens(metrics);
  const cacheRead = price.cacheReadPerMillion ?? price.inputPerMillion;
  const cacheWrite = price.cacheWritePerMillion ?? price.inputPerMillion;

  return (
    (uncachedInput * price.inputPerMillion +
      metrics.cacheReadTokens * cacheRead +
      metrics.cacheCreationTokens * cacheWrite +
      metrics.completionTokens * price.outputPerMillion) /
    1_000_000
  );
}

/**
 * Every token the estimate priced — the denominator both blended rates use.
 *
 * It is the input total plus the output, and no cache counter is added on top:
 * they are already inside `promptTokens`, so adding them would inflate the
 * denominator by the size of the cache and read every cache-heavy model as
 * cheaper per token than it is.
 */
function billableTokens(metrics: GatewayMetrics): number {
  return inputTokens(metrics) + metrics.completionTokens;
}

function classify(row: {
  price: GatewayModelPrice | null;
  estimate: number | null;
  ratio: number | null;
}): { gap: CatalogGap | null; state: CatalogState } {
  if (row.price === null) return { gap: 'unlisted', state: 'unpriced' };
  if (row.estimate === null) return { gap: 'unpriced', state: 'unpriced' };
  if (row.price.priceVaries) return { gap: null, state: 'floor' };
  if (row.ratio === null) return { gap: null, state: 'matches' };
  if (row.ratio > 1 + CATALOG_DRIFT_TOLERANCE) return { gap: null, state: 'above' };
  if (row.ratio < 1 - CATALOG_DRIFT_TOLERANCE) return { gap: null, state: 'below' };
  return { gap: null, state: 'matches' };
}

/**
 * The catalogue read against the window's `model` rows.
 *
 * `modelRows` are the already-ranked rows of the `model` dimension — the same
 * ones the breakdown table renders, so the two cards can never disagree about
 * what a model cost. `gatewaySpend` is passed separately rather than summed
 * from those rows because coverage has to be measured against the *whole* bill:
 * a proxy that under-reports the model dimension is exactly the case the number
 * has to catch.
 */
export function deriveCatalog(
  modelRows: readonly GatewayBreakdownRow[],
  catalogue: readonly GatewayModelPrice[],
  gatewaySpend: number,
): CatalogSummary {
  if (catalogue.length === 0 && modelRows.length === 0) return EMPTY_CATALOG_SUMMARY;

  const rows: CatalogRow[] = modelRows.map((row) => {
    const price = resolveModelPrice(catalogue, row.key);
    const estimate = price === null ? null : repriceMetrics(row.metrics, price);
    const ratio = estimate === null || estimate <= 0 ? null : row.metrics.spend / estimate;
    const tokens = billableTokens(row.metrics);
    const { gap, state } = classify({ price, estimate, ratio });

    return {
      key: row.key,
      label: row.label,
      metrics: row.metrics,
      share: row.share,
      price,
      gap,
      estimate,
      ratio,
      effectivePerMillion: tokens > 0 ? (row.metrics.spend / tokens) * 1_000_000 : null,
      listPerMillion: estimate !== null && tokens > 0 ? (estimate / tokens) * 1_000_000 : null,
      state,
    };
  });

  const modelSpend = rows.reduce((sum, row) => sum + row.metrics.spend, 0);
  const pricedSpend = rows
    .filter((row) => row.estimate !== null)
    .reduce((sum, row) => sum + row.metrics.spend, 0);

  const firm = rows.filter((row) => row.estimate !== null && row.price?.priceVaries === false);
  const firmEstimate = firm.reduce((sum, row) => sum + (row.estimate ?? 0), 0);
  const firmBilled = firm.reduce((sum, row) => sum + row.metrics.spend, 0);

  // A model the catalogue knows but nobody called. Matched by the same resolver
  // the rows used, so an alias reached through its backend string is not also
  // reported as idle.
  const touched = new Set(
    rows.map((row) => row.price?.model).filter((model): model is string => model !== undefined),
  );

  return {
    rows,
    gatewaySpend,
    modelSpend,
    pricedSpend,
    coverage: gatewaySpend > 0 ? pricedSpend / gatewaySpend : 0,
    unlisted: rows.filter((row) => row.gap === 'unlisted'),
    unpriced: rows.filter((row) => row.gap === 'unpriced'),
    drifting: rows.filter((row) => row.state === 'above' || row.state === 'below'),
    firmEstimate,
    firmBilled,
    firmRatio: firmBilled > 0 ? firmEstimate / firmBilled : null,
    idleModels: catalogue.filter((entry) => !touched.has(entry.model)),
    catalogueSize: catalogue.length,
  };
}

/** Nothing to render: no catalogue at all, or no model traffic to price with it. */
export function hasCatalog(summary: CatalogSummary): boolean {
  return summary.catalogueSize > 0 && summary.rows.length > 0;
}
