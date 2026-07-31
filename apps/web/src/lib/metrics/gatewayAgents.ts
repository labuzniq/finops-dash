import { sumGatewayMetrics } from '@dash/shared';
import type { GatewayBreakdownPoint, GatewayDailyPoint, GatewayMetrics } from '@dash/shared';

/**
 * How much of the gateway is agents rather than people.
 *
 * The proxy is one endpoint for every human chat turn *and* every autonomous
 * tool loop, and those two workloads have nothing in common except the bill:
 * an agent turn carries a tool schema, a tool result and the conversation so
 * far, so it costs several times what a chat turn costs, and it arrives without
 * anyone watching. "Is agent traffic growing, and what is it costing us" is the
 * question a corporate gateway owner is actually asked, and no other card on
 * the page can answer it — every one of them ranks *within* a dimension, and
 * this is the one dimension that is a **partition** rather than a slice.
 *
 * The honesty constraint runs through the whole module. `mcp_server` is the
 * only agent-shaped signal LiteLLM reports, and it only covers calls that
 * actually routed through an MCP server. An agent that calls
 * `/chat/completions` directly with hand-rolled tools is indistinguishable from
 * a person here. So the split is **MCP-attributed vs everything else**, never
 * "agent vs human", and the remainder is named for what it is. Overstating the
 * coverage would turn a floor into an estimate.
 *
 * The subset invariant is what makes the subtraction legal at all: every
 * `mcp_server` row is a re-slice of requests that are already in the gateway
 * totals, so `remainder = totals − attributed` is a real quantity — the one
 * arithmetic the overlapping dimensions permit. It is clamped at zero and the
 * offending days are reported rather than hidden, because a proxy that
 * over-attributes would otherwise render as a silent negative.
 *
 * Pure, like every module in `lib/metrics/` — it reads the payload already in
 * memory, adds no fetch, and derives the trend from the two halves of the spine
 * on screen rather than from the comparison window's second request.
 */

/** The dimension that carries agent traffic. A constant, so the card cannot drift onto a peer slice. */
export const AGENT_DIMENSION = 'mcp_server';

/** Fewest spine days before a first-half/second-half trend is worth stating. */
const MIN_TREND_DAYS = 6;

export interface AgentTrafficDay {
  date: string;
  attributedSpend: number;
  totalSpend: number;
  /** Attributed ÷ total for the day, 0..1. Null on a day the gateway cost nothing. */
  share: number | null;
}

/** One MCP server, summed across the range. */
export interface AgentServerRow {
  key: string;
  /** Server alias when the proxy resolved one; null renders as `—`. */
  label: string | null;
  metrics: GatewayMetrics;
  /**
   * Share of *attributed* spend, 0..1 — deliberately a different denominator
   * from the breakdown card's, which is gateway-wide. That card answers "how
   * much of the bill is this server"; this one answers "how much of the agent
   * bill is this server", and the second is the one that ranks tool usage.
   */
  shareOfAttributed: number;
  /** Share of gateway-wide spend, 0..1 — the page's usual denominator, kept for continuity. */
  shareOfGateway: number;
}

/** Direction of travel, taken from the two halves of the spine already on screen. */
export interface AgentTrafficTrend {
  firstHalfShare: number | null;
  secondHalfShare: number | null;
  /** Second half minus first, in percentage *points*. Null when either half had no spend. */
  deltaPoints: number | null;
  /** Days in each half — the second gets the odd day on an odd-length spine. */
  firstHalfDays: number;
  secondHalfDays: number;
}

export interface AgentTrafficSummary {
  /** Everything LiteLLM tagged with an MCP server. */
  attributed: GatewayMetrics;
  /** Totals minus attributed — every call the proxy did *not* attribute to a server. */
  remainder: GatewayMetrics;
  totals: GatewayMetrics;
  /** Attributed share of spend / requests / tokens, 0..1. Null when the denominator is zero. */
  spendShare: number | null;
  requestShare: number | null;
  tokenShare: number | null;
  /** Every day of the trimmed spine, in order. */
  daily: AgentTrafficDay[];
  trend: AgentTrafficTrend | null;
  /** MCP servers ranked by spend. */
  servers: AgentServerRow[];
  /**
   * Days where attributed spend exceeded the gateway total. Always empty on a
   * consistent proxy — the subset invariant forbids it — so a non-empty list is
   * a data fault worth surfacing, not a rounding artefact to swallow.
   */
  inconsistentDays: string[];
}

/** `a − b`, floored at zero per field. */
function subtractMetrics(a: GatewayMetrics, b: GatewayMetrics): GatewayMetrics {
  const floor = (left: number, right: number): number => Math.max(0, left - right);
  return {
    spend: floor(a.spend, b.spend),
    requests: floor(a.requests, b.requests),
    successfulRequests: floor(a.successfulRequests, b.successfulRequests),
    failedRequests: floor(a.failedRequests, b.failedRequests),
    promptTokens: floor(a.promptTokens, b.promptTokens),
    completionTokens: floor(a.completionTokens, b.completionTokens),
    totalTokens: floor(a.totalTokens, b.totalTokens),
    cacheReadTokens: floor(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: floor(a.cacheCreationTokens, b.cacheCreationTokens),
  };
}

/** `part ÷ whole`, or null when there is no whole to take a share of. */
function shareOf(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/**
 * Attributed share across a slice of the spine, as a fraction.
 *
 * Summed then divided, never averaged over the per-day shares: a mean of daily
 * shares weights a $40 Sunday the same as a $600 Wednesday, which would let a
 * quiet weekend of pure agent batch work dominate the trend.
 */
function halfShare(days: readonly AgentTrafficDay[]): number | null {
  const attributed = days.reduce((sum, day) => sum + day.attributedSpend, 0);
  const total = days.reduce((sum, day) => sum + day.totalSpend, 0);
  return shareOf(attributed, total);
}

/**
 * The agent split for one range.
 *
 * `spine` is the page's already-trimmed daily series, so the strip this card
 * draws lines up day-for-day with the trend charts above it and stops at the
 * same last-reported day. `points` is the same breakdown array every other card
 * reads; only the `mcp_server` rows are consulted.
 */
export function deriveAgentTraffic(
  spine: readonly GatewayDailyPoint[],
  points: readonly GatewayBreakdownPoint[],
): AgentTrafficSummary {
  const agentPoints = points.filter((point) => point.dimension === AGENT_DIMENSION);

  const byDate = new Map<string, GatewayBreakdownPoint[]>();
  for (const point of agentPoints) {
    const bucket = byDate.get(point.date);
    if (bucket === undefined) byDate.set(point.date, [point]);
    else bucket.push(point);
  }

  // Summed over the spine rather than over every row the payload holds: the
  // spine has already dropped the unsynced tail, and a breakdown row on a day
  // the totals no longer cover would push the share above 100%.
  const daily = spine.map((day): AgentTrafficDay => {
    const attributedSpend = sumGatewayMetrics(byDate.get(day.date) ?? []).spend;
    return {
      date: day.date,
      attributedSpend,
      totalSpend: day.spend,
      share: shareOf(attributedSpend, day.spend),
    };
  });

  const onSpine = new Set(spine.map((day) => day.date));
  const attributed = sumGatewayMetrics(agentPoints.filter((point) => onSpine.has(point.date)));
  const totals = sumGatewayMetrics(spine);
  const remainder = subtractMetrics(totals, attributed);

  const buckets = new Map<string, { label: string | null; points: GatewayBreakdownPoint[] }>();
  for (const point of agentPoints) {
    if (!onSpine.has(point.date)) continue;
    const bucket = buckets.get(point.key);
    if (bucket === undefined) {
      buckets.set(point.key, { label: point.label, points: [point] });
    } else {
      bucket.points.push(point);
      // The proxy may only resolve an alias on some days; first one wins.
      if (bucket.label === null) bucket.label = point.label;
    }
  }

  const servers = [...buckets.entries()]
    .map(([key, bucket]): AgentServerRow => {
      const metrics = sumGatewayMetrics(bucket.points);
      return {
        key,
        label: bucket.label,
        metrics,
        shareOfAttributed: shareOf(metrics.spend, attributed.spend) ?? 0,
        shareOfGateway: shareOf(metrics.spend, totals.spend) ?? 0,
      };
    })
    .sort((a, b) => b.metrics.spend - a.metrics.spend || a.key.localeCompare(b.key));

  const half = Math.floor(daily.length / 2);
  const trend =
    daily.length >= MIN_TREND_DAYS
      ? {
          firstHalfShare: halfShare(daily.slice(0, half)),
          secondHalfShare: halfShare(daily.slice(half)),
          deltaPoints: null as number | null,
          firstHalfDays: half,
          secondHalfDays: daily.length - half,
        }
      : null;

  if (trend !== null && trend.firstHalfShare !== null && trend.secondHalfShare !== null) {
    trend.deltaPoints = (trend.secondHalfShare - trend.firstHalfShare) * 100;
  }

  return {
    attributed,
    remainder,
    totals,
    spendShare: shareOf(attributed.spend, totals.spend),
    requestShare: shareOf(attributed.requests, totals.requests),
    tokenShare: shareOf(attributed.totalTokens, totals.totalTokens),
    daily,
    trend,
    servers,
    inconsistentDays: daily
      .filter((day) => day.attributedSpend > day.totalSpend)
      .map((day) => day.date),
  };
}

/**
 * Whether the proxy attributed anything at all to an MCP server.
 *
 * A gateway with no MCP routing reports no rows, which is a fact about the
 * gateway and not an empty state to apologise for — the card simply does not
 * render, the same way the reliability card stands down on an idle range.
 */
export function hasAgentTraffic(summary: AgentTrafficSummary): boolean {
  return summary.servers.length > 0 && summary.attributed.requests > 0;
}
