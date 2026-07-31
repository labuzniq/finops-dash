import { EMPTY_GATEWAY_METRICS, sumGatewayMetrics } from '@dash/shared';
import type {
  GatewayBreakdownPoint,
  GatewayDimension,
  GatewayMetrics,
} from '@dash/shared';
import type { GatewayBreakdownRow } from './gateway.js';
import type { ComparisonWindow } from './gatewayCompare.js';

/**
 * Why gateway spend moved — the volume / mix / rate decomposition.
 *
 * Every other comparison on the page reports *that* something changed. The
 * movers card names which keys moved the dollars; the trend charts show the
 * shape. None of them separate the three reasons a bill grows, which need
 * three different conversations:
 *
 *  - **Volume** — the gateway processed more tokens at the prices it was
 *    already paying. Usually the answer nobody needs to act on: it is the
 *    gateway doing its job, and it is what capacity planning is for.
 *  - **Mix** — the same token count shifted toward dearer models (or keys, or
 *    providers). Nothing got more expensive and nothing did more work; the
 *    traffic moved. This is the routing conversation.
 *  - **Rate** — the same slice cost more per token than it did before. On a
 *    gateway this is a price change, a shift from input-heavy to output-heavy
 *    turns, or a cache that stopped hitting. Never a volume story.
 *
 * The arithmetic is the standard three-factor split, per key `i`, with `t` for
 * tokens, `p` for dollars per token and `s` for share of the window's tokens:
 *
 *   volume_i = (T₁ − T₀)·s_i₀·p_i₀
 *   mix_i    = T₁·(s_i₁ − s_i₀)·p_i₀
 *   rate_i   = t_i₁·(p_i₁ − p_i₀)
 *
 * Those three sum to `t_i₁·p_i₁ − t_i₀·p_i₀` exactly — the key's own spend
 * delta — with no interaction term left over, which is what makes the table a
 * decomposition rather than an attribution. Summed across a dimension that
 * reconstitutes the totals, they reproduce the gateway-wide spend delta.
 *
 * That exactness is also the whole constraint on where this card may be read.
 * The six full-coverage dimensions each re-slice the same dollar, so any one of
 * them decomposes the totals; `mcp_server` is a strict subset and `user` may be
 * partially attributed, and for those the three effects explain only part of
 * the movement. Rather than quietly reporting a short sum, the derivation
 * measures its own coverage and marks itself unusable — see `usable`.
 *
 * Volume is measured in **tokens**, deliberately, because a token is the thing
 * the gateway is billed for. The trade-off is stated on the card: a workload
 * that keeps its request count and doubles its prompt length reads as volume,
 * not as a price change, and per-key `p` is a blended input+output rate, so an
 * output-heavy shift inside one model lands in `rate`.
 *
 * Pure and memo-friendly, like every other module in `lib/metrics/`.
 */

/** Coverage below this and the dimension cannot claim to explain the totals. */
const MIN_COVERAGE = 0.99;

/** Residual above this share of the movement and the split is not a split. */
const MAX_UNEXPLAINED = 0.01;

export interface GatewayMixRow {
  key: string;
  label: string | null;
  previousTokens: number;
  currentTokens: number;
  previousSpend: number;
  currentSpend: number;
  /**
   * Dollars per million tokens in each window; null where the key carried no
   * tokens then — a key that did not exist has no price, and zero would read
   * as "it was free".
   */
  previousPrice: number | null;
  currentPrice: number | null;
  /** Share of the *gateway's* tokens, 0..1 — the same denominator as `mix`. */
  previousShare: number;
  currentShare: number;
  volume: number;
  mix: number;
  rate: number;
  /** `volume + mix + rate`, identical to `currentSpend − previousSpend`. */
  total: number;
}

export interface GatewayMixDecomposition {
  dimension: GatewayDimension;
  /** The period being compared against — the same window every other delta uses. */
  window: ComparisonWindow;
  previousSpend: number;
  currentSpend: number;
  /** Gateway-wide spend delta. `volume + mix + rate + unexplained` reproduces it. */
  delta: number;
  previousTokens: number;
  currentTokens: number;
  /** Blended dollars per million tokens, gateway-wide, in each window. */
  previousPrice: number;
  currentPrice: number;
  /**
   * What the current token mix would have cost per million at the *prior*
   * per-key rates — the midpoint that separates mix from rate.
   */
  priceAtPriorRates: number;
  volume: number;
  mix: number;
  rate: number;
  /**
   * `delta − (volume + mix + rate)`. Zero for a dimension that reconstitutes
   * the totals; the shortfall of a subset dimension, and the reason `usable`
   * exists rather than the card silently under-explaining.
   */
  unexplained: number;
  /** The dimension's rows' spend ÷ gateway spend, per window, 0..1. */
  previousCoverage: number;
  currentCoverage: number;
  /** Whether the three effects may be read as an explanation of the movement. */
  usable: boolean;
  /** Every key, biggest `|mix + rate|` first — the part volume does not explain. */
  rows: GatewayMixRow[];
}

function priceOf(spend: number, tokens: number): number | null {
  return tokens > 0 ? spend / tokens : null;
}

/**
 * Split the gateway's spend movement into volume, mix and rate across one
 * breakdown dimension.
 *
 * `currentRows` are the ranked rows the breakdown card is already showing, so
 * the two cards can never disagree about who is in the slice; `previousPoints`
 * are the prior window's raw breakdown rows, summed here.
 *
 * Null when there is nothing to decompose: no prior traffic (every dollar is
 * new, and "why did it grow" has no baseline), or no tokens on either side.
 *
 * A key present only in the current window is priced at the *gateway's* prior
 * blended rate rather than at nothing. That keeps the identity exact and makes
 * the reading honest: a newly routed model arrives as mix (traffic moved to
 * it) plus rate (it is dearer, or cheaper, than what the gateway used to pay).
 */
export function deriveGatewayMix(
  currentRows: readonly GatewayBreakdownRow[],
  previousPoints: readonly GatewayBreakdownPoint[],
  dimension: GatewayDimension,
  currentTotals: Readonly<GatewayMetrics>,
  previousTotals: Readonly<GatewayMetrics>,
  window: ComparisonWindow,
): GatewayMixDecomposition | null {
  const previousTokens = previousTotals.totalTokens;
  const currentTokens = currentTotals.totalTokens;
  if (previousTokens <= 0 || currentTokens <= 0) return null;
  if (previousTotals.spend <= 0 && currentTotals.spend <= 0) return null;

  const previousByKey = new Map<string, GatewayBreakdownPoint[]>();
  for (const point of previousPoints) {
    if (point.dimension !== dimension) continue;
    const bucket = previousByKey.get(point.key);
    if (bucket === undefined) previousByKey.set(point.key, [point]);
    else bucket.push(point);
  }

  // Union of both windows — an arrival and a departure are both movements, and
  // the identity only holds over every key that carried tokens in either.
  const labels = new Map<string, string | null>();
  for (const row of currentRows) labels.set(row.key, row.label);
  for (const [key, points] of previousByKey) {
    const resolved = points.find((point) => point.label !== null)?.label ?? null;
    if (!labels.has(key)) labels.set(key, resolved);
    else if (labels.get(key) === null && resolved !== null) labels.set(key, resolved);
  }

  const currentByKey = new Map(currentRows.map((row) => [row.key, row.metrics]));

  // The fallback price for a key with no prior tokens: what the gateway itself
  // paid per token before. Zero would book the arrival entirely as rate.
  const gatewayPriorPrice = previousTotals.spend / previousTokens;

  const rows: GatewayMixRow[] = [];
  let previousRowSpend = 0;
  let currentRowSpend = 0;

  for (const [key, label] of labels) {
    const now = currentByKey.get(key) ?? EMPTY_GATEWAY_METRICS;
    const before = sumGatewayMetrics(previousByKey.get(key) ?? []);

    previousRowSpend += before.spend;
    currentRowSpend += now.spend;

    const beforeTokens = before.totalTokens;
    const nowTokens = now.totalTokens;
    if (beforeTokens <= 0 && nowTokens <= 0) continue;

    const beforePrice = priceOf(before.spend, beforeTokens);
    const nowPrice = priceOf(now.spend, nowTokens);
    const basePrice = beforePrice ?? gatewayPriorPrice;

    const previousShare = beforeTokens / previousTokens;
    const currentShare = nowTokens / currentTokens;

    const volume = (currentTokens - previousTokens) * previousShare * basePrice;
    const mix = currentTokens * (currentShare - previousShare) * basePrice;
    const rate = nowTokens * ((nowPrice ?? basePrice) - basePrice);

    rows.push({
      key,
      label,
      previousTokens: beforeTokens,
      currentTokens: nowTokens,
      previousSpend: before.spend,
      currentSpend: now.spend,
      previousPrice: beforePrice === null ? null : beforePrice * 1_000_000,
      currentPrice: nowPrice === null ? null : nowPrice * 1_000_000,
      previousShare,
      currentShare,
      volume,
      mix,
      rate,
      total: volume + mix + rate,
    });
  }

  if (rows.length === 0) return null;

  const volume = rows.reduce((sum, row) => sum + row.volume, 0);
  const mix = rows.reduce((sum, row) => sum + row.mix, 0);
  const rate = rows.reduce((sum, row) => sum + row.rate, 0);
  const delta = currentTotals.spend - previousTotals.spend;
  const unexplained = delta - (volume + mix + rate);

  const previousCoverage = previousTotals.spend > 0 ? previousRowSpend / previousTotals.spend : 0;
  const currentCoverage = currentTotals.spend > 0 ? currentRowSpend / currentTotals.spend : 0;

  const scale = Math.max(Math.abs(delta), Math.abs(volume) + Math.abs(mix) + Math.abs(rate));
  const usable =
    previousCoverage >= MIN_COVERAGE &&
    currentCoverage >= MIN_COVERAGE &&
    (scale === 0 || Math.abs(unexplained) / scale <= MAX_UNEXPLAINED);

  rows.sort(
    (a, b) =>
      Math.abs(b.mix + b.rate) - Math.abs(a.mix + a.rate) || a.key.localeCompare(b.key),
  );

  return {
    dimension,
    window,
    previousSpend: previousTotals.spend,
    currentSpend: currentTotals.spend,
    delta,
    previousTokens,
    currentTokens,
    previousPrice: (previousTotals.spend / previousTokens) * 1_000_000,
    currentPrice: (currentTotals.spend / currentTokens) * 1_000_000,
    // The mix effect is by construction `T₁·(P₀ at the new mix − P₀)`, so the
    // midpoint price falls straight out of it rather than being re-derived.
    priceAtPriorRates: ((previousTotals.spend / previousTokens) + mix / currentTokens) * 1_000_000,
    volume,
    mix,
    rate,
    unexplained,
    previousCoverage,
    currentCoverage,
    usable,
    rows,
  };
}

/** Which of the three effects carries the movement — the card's opening claim. */
export type MixDriver = 'volume' | 'mix' | 'rate';

export function dominantEffect(decomposition: GatewayMixDecomposition): MixDriver {
  const { volume, mix, rate } = decomposition;
  const ranked: Array<[MixDriver, number]> = [
    ['volume', Math.abs(volume)],
    ['mix', Math.abs(mix)],
    ['rate', Math.abs(rate)],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? 'volume';
}

/**
 * Whether the decomposition is worth rendering at all: usable, and describing
 * enough movement to have a reason worth naming rather than three rounding
 * errors argued over at full size.
 *
 * The gate is on the *gross* effect — |volume| + |mix| + |rate| — and not on
 * the net movement, deliberately. A gateway whose bill held flat while it
 * processed 20% fewer tokens at a 25% higher blended price has not had a quiet
 * month, and it is the one case where every other card on the page reports
 * nothing at all. Gating on the net delta would hide exactly that.
 */
export function hasMixSignal(
  decomposition: GatewayMixDecomposition | null,
  minimumEffect = 0.005,
): decomposition is GatewayMixDecomposition {
  if (decomposition === null || !decomposition.usable) return false;
  if (decomposition.previousSpend <= 0) return false;
  const gross =
    Math.abs(decomposition.volume) + Math.abs(decomposition.mix) + Math.abs(decomposition.rate);
  return gross / decomposition.previousSpend >= minimumEffect;
}
