import type {
  GatewayBreakdownPoint,
  GatewayDailyPoint,
  GatewayDimension,
  GatewayMetrics,
} from '@dash/shared';

/**
 * Prompt-cache derivations for the gateway page — the one lever that lowers the
 * bill without changing what anybody is allowed to do.
 *
 * Every other card on this page reads dollars and asks who spent them. This one
 * reads the two counters LiteLLM carries beside them — `cache_read_input_tokens`
 * and `cache_creation_input_tokens` — and asks a different question: of all the
 * input we paid to send, how much did we send *again*. A workload re-posting the
 * same 6,000-token system prompt on every call is not a governance problem, it
 * has no owner to escalate to and no anomaly to flag; it is just money leaving
 * quietly at a steady rate, which is exactly the shape no other surface here can
 * see.
 *
 * Three things this module deliberately does not do:
 *
 * - **It reports tokens, never dollars.** The proxy's daily aggregate carries
 *   one `spend` figure per row covering input, output, cache reads and cache
 *   writes together, and no per-model price. Splitting that back apart would
 *   mean assuming a price list, and the gateway fronts three backends whose
 *   lists differ. `estimatedSavingRatio` below is the one exception and it is
 *   labelled a pricing *convention*, not a measurement.
 * - **It does not flag "below average".** Ranking rows by uncached input tokens
 *   already puts the material ones on top; a badge is reserved for the two
 *   states that are faults under any price list (see `CacheState`). Half the
 *   keys are below the mean by construction — iteration 10's reliability badge
 *   learned this the expensive way.
 * - **It does not judge a workload with no cache activity as broken.** Plenty of
 *   traffic legitimately cannot cache: every prompt genuinely different, or a
 *   provider/deployment with no prompt cache at all. `unused` is a state, not a
 *   verdict, and the card words it as one.
 *
 * Pure, like every module in `lib/metrics/` — it reads the payload already in
 * memory and never fetches. Token counters are non-null everywhere (the proxy
 * omits what never happened, so zero is a fact), but a *rate* over zero input
 * tokens is genuinely unknown and stays null rather than rendering as 0%.
 */

/**
 * Cache reads bill at roughly a tenth of the input rate and cache writes at a
 * premium over it — 0.1× and 1.25× are the multipliers Anthropic publishes and
 * Bedrock mirrors, and Azure OpenAI's cached-input discount is in the same
 * direction (shallower, so this is the optimistic end).
 *
 * They are here for exactly one purpose: to derive the break-even below, which
 * is a statement about *shape* (does re-reading a cache entry pay for having
 * written it) rather than about any particular bill. Nothing on this card
 * converts a token to a dollar with them.
 */
export const CACHE_READ_RATE = 0.1;
export const CACHE_WRITE_RATE = 1.25;

/**
 * Cache reads per token written before the cache pays for itself.
 *
 * Writing W tokens costs `1.25·W·p` where sending them uncached costs `1.0·W·p`,
 * so the write carries a `0.25·W·p` premium. Reading R tokens back costs
 * `0.1·R·p` against `1.0·R·p` uncached, saving `0.9·R·p`. The cache is ahead
 * when `0.9·R > 0.25·W`, i.e. `R/W > 0.278`.
 *
 * A workload below this line is paying the premium and collecting almost none of
 * the discount — it is *more* expensive than not caching at all. That is a fault
 * under any of the three backends' price lists, which is what makes it worth a
 * badge when "below the gateway average" is not.
 */
export const CACHE_BREAKEVEN_REUSE = (CACHE_WRITE_RATE - 1) / (1 - CACHE_READ_RATE);

/**
 * What one key's cache behaviour is, in the only three flavours worth naming.
 *
 * - `ok` — the cache is being re-read enough to pay for itself, or the workload
 *   writes nothing and reads nothing at a volume too small to matter.
 * - `churning` — writes are happening and are not being read back past the
 *   break-even. Every provider prices a write above a plain input token, so this
 *   costs more than caching nothing. Usually a per-request cache key: a prompt
 *   assembled fresh each call, cached, and never seen again.
 * - `unused` — material input volume, no cache activity at all. Not a fault on
 *   its own (some prompts genuinely never repeat), but it is where the headroom
 *   is, so the card shows it and says what it does not know.
 */
export type CacheState = 'ok' | 'churning' | 'unused';

export interface CacheRow {
  key: string;
  /** Key alias / team name when the proxy resolved one; null renders as `—`. */
  label: string | null;
  /** Everything fed to the model: fresh prompt tokens plus tokens served from cache. */
  inputTokens: number;
  /** Input tokens the provider served from its prompt cache. */
  cachedTokens: number;
  /** Input tokens billed at the full rate — what re-sending costs. */
  uncachedTokens: number;
  /** Tokens written into the cache, billed at a premium. */
  writeTokens: number;
  /** `cachedTokens / inputTokens`, 0..1. Null when this key sent no input at all. */
  hitRate: number | null;
  /**
   * Cache tokens read back per token written. Null when nothing was written —
   * which is the difference between "we never tried" and "we tried and it did
   * not stick", and the two need different answers.
   */
  reusePerWrite: number | null;
  /** Share of *gateway-wide* uncached input tokens, 0..1 — same denominator rule as every other card. */
  shareOfUncached: number;
  state: CacheState;
}

export interface CacheDay {
  date: string;
  inputTokens: number;
  cachedTokens: number;
  /** 0..1, or null on a day the gateway sent no input at all. */
  hitRate: number | null;
}

export interface CacheSummary {
  inputTokens: number;
  cachedTokens: number;
  uncachedTokens: number;
  writeTokens: number;
  /** Gateway-wide cache hit rate for the range, 0..1. Null when nothing was sent. */
  hitRate: number | null;
  /** Gateway-wide reads per token written. Null when nothing was written. */
  reusePerWrite: number | null;
  /**
   * Fraction of the full input bill the cache is already keeping off it, under
   * the pricing convention above: `(0.9·cached − 0.25·written) / input`.
   *
   * Signed on purpose — a gateway that writes far more than it reads gets a
   * negative number, and that is the honest reading. Null when no input was
   * sent. It is a ratio of tokens weighted by convention multipliers, so it is
   * comparable across ranges but is *not* a dollar figure and the card never
   * multiplies it by spend.
   */
  estimatedSavingRatio: number | null;
  /** Every day of the trimmed spine, in order — the strip the card draws. */
  daily: CacheDay[];
  dimension: GatewayDimension;
  /** Keys of `dimension`, ranked by uncached input tokens. */
  rows: CacheRow[];
  /**
   * Uncached tokens that would move into cache if every key below the
   * gateway-wide hit rate merely reached it. Deliberately conservative: it
   * levels rows up to the gateway's own behaviour, not to the best key's and not
   * to 100%, so it is a floor on the headroom rather than a target nobody hits.
   * Zero when there is no rate to level up to.
   */
  headroomTokens: number;
}

/** Input tokens = fresh prompt + what came out of the cache. */
export function inputTokens(metrics: Readonly<GatewayMetrics>): number {
  return metrics.promptTokens + metrics.cacheReadTokens;
}

function rateOf(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/**
 * A key with almost no input is noise in every column here, and `unused` on a
 * key that sent four thousand tokens is not a finding. One million input tokens
 * over the range is roughly a dollar of Sonnet input — below that the row still
 * renders, it just cannot carry a badge.
 */
const MIN_MATERIAL_INPUT_TOKENS = 1_000_000;

function classify(row: {
  inputTokens: number;
  cachedTokens: number;
  writeTokens: number;
  reusePerWrite: number | null;
}): CacheState {
  if (row.inputTokens < MIN_MATERIAL_INPUT_TOKENS) return 'ok';
  if (row.reusePerWrite !== null && row.reusePerWrite < CACHE_BREAKEVEN_REUSE) return 'churning';
  if (row.writeTokens === 0 && row.cachedTokens === 0) return 'unused';
  return 'ok';
}

/**
 * The whole prompt-cache picture for one range and one breakdown dimension.
 *
 * Shares take the gateway-wide uncached total as denominator for the same reason
 * every other card takes the gateway-wide one: the dimensions overlap, so a
 * share only compares across them if the denominator is the single thing they
 * all slice. `mcp_server` therefore sums to less than 100%, correctly.
 */
export function deriveGatewayCache(
  spine: readonly GatewayDailyPoint[],
  points: readonly GatewayBreakdownPoint[],
  dimension: GatewayDimension,
): CacheSummary {
  let prompt = 0;
  let cached = 0;
  let written = 0;

  const daily = spine.map((day): CacheDay => {
    prompt += day.promptTokens;
    cached += day.cacheReadTokens;
    written += day.cacheCreationTokens;
    const input = day.promptTokens + day.cacheReadTokens;
    return {
      date: day.date,
      inputTokens: input,
      cachedTokens: day.cacheReadTokens,
      hitRate: rateOf(day.cacheReadTokens, input),
    };
  });

  const input = prompt + cached;
  const hitRate = rateOf(cached, input);

  interface Bucket {
    label: string | null;
    prompt: number;
    cached: number;
    written: number;
  }
  const buckets = new Map<string, Bucket>();

  for (const point of points) {
    if (point.dimension !== dimension) continue;
    let bucket = buckets.get(point.key);
    if (bucket === undefined) {
      bucket = { label: point.label, prompt: 0, cached: 0, written: 0 };
      buckets.set(point.key, bucket);
    }
    // The proxy may only resolve an alias on some days; first one wins.
    if (bucket.label === null) bucket.label = point.label;
    bucket.prompt += point.promptTokens;
    bucket.cached += point.cacheReadTokens;
    bucket.written += point.cacheCreationTokens;
  }

  const rows = [...buckets.entries()]
    .map(([key, bucket]): CacheRow => {
      const rowInput = bucket.prompt + bucket.cached;
      const reusePerWrite = bucket.written > 0 ? bucket.cached / bucket.written : null;
      return {
        key,
        label: bucket.label,
        inputTokens: rowInput,
        cachedTokens: bucket.cached,
        uncachedTokens: bucket.prompt,
        writeTokens: bucket.written,
        hitRate: rateOf(bucket.cached, rowInput),
        reusePerWrite,
        shareOfUncached: prompt > 0 ? bucket.prompt / prompt : 0,
        state: classify({
          inputTokens: rowInput,
          cachedTokens: bucket.cached,
          writeTokens: bucket.written,
          reusePerWrite,
        }),
      };
    })
    // Ranked by uncached tokens — the size of the opportunity, which is what a
    // reader can act on. Ranking by hit rate puts a 0%-cached key that sent
    // nine thousand tokens above the workload re-sending millions a day.
    .sort(
      (a, b) =>
        b.uncachedTokens - a.uncachedTokens ||
        b.inputTokens - a.inputTokens ||
        a.key.localeCompare(b.key),
    );

  // Levelling up to the gateway's own rate, row by row, and only for the rows
  // below it. Rows above contribute nothing — this is headroom, not a
  // redistribution, so a good key cannot offset a bad one.
  const headroomTokens =
    hitRate === null
      ? 0
      : rows.reduce((total, row) => total + Math.max(0, row.inputTokens * hitRate - row.cachedTokens), 0);

  return {
    inputTokens: input,
    cachedTokens: cached,
    uncachedTokens: prompt,
    writeTokens: written,
    hitRate,
    reusePerWrite: written > 0 ? cached / written : null,
    estimatedSavingRatio:
      input > 0 ? ((1 - CACHE_READ_RATE) * cached - (CACHE_WRITE_RATE - 1) * written) / input : null,
    daily,
    dimension,
    rows,
    headroomTokens,
  };
}

/**
 * Whether the proxy reported any prompt-cache activity at all for this range.
 *
 * A gateway whose backends have no prompt cache — or whose callers never opt in
 * — reports zeroes on both counters, and a card full of 0% and `—` says nothing
 * a reader can use. The page stands the card down entirely in that case, the
 * same way it stands down the agent card when nothing is MCP-attributed.
 */
export function hasCacheActivity(summary: CacheSummary): boolean {
  return summary.cachedTokens > 0 || summary.writeTokens > 0;
}
