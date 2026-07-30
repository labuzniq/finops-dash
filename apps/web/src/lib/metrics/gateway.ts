import {
  EMPTY_GATEWAY_METRICS,
  GATEWAY_DIMENSIONS,
  sumGatewayMetrics,
} from '@dash/shared';
import type {
  GatewayBreakdownPoint,
  GatewayDailyPoint,
  GatewayDimension,
  GatewayMetrics,
  GatewayUsage,
} from '@dash/shared';

/**
 * Derivations over one `GET /api/gateway` payload.
 *
 * Same contract as the Copilot spend section: the API hands back the raw days
 * and every breakdown row for the range, and everything the page shows —
 * totals, the trend spine, the ranked breakdowns — is computed here, purely,
 * so switching dimension or re-slicing never hits the network.
 *
 * The one rule that is not a preference: **the breakdown dimensions overlap.**
 * `model`, `provider`, `api_key`, `team`, `tag` and `user` are six slices of
 * the same dollar, and `mcp_server` is a subset of it. Every function below
 * ranks *within* one dimension and takes its share denominator from the
 * gateway-wide daily totals, never from another dimension's sum.
 */

/** One key of one dimension, summed across the range. */
export interface GatewayBreakdownRow {
  key: string;
  /** Key alias / team name when the proxy resolved one; null renders as `—`. */
  label: string | null;
  metrics: GatewayMetrics;
  /** Share of gateway-wide spend in range, 0..1. Zero when nothing was spent. */
  share: number;
}

export interface GatewaySummary {
  /** Ascending, zero-filled across the whole range — a quiet day is a real zero. */
  daily: GatewayDailyPoint[];
  /** Gateway-wide totals for the range. The only legitimate "our LLM spend" number. */
  totals: GatewayMetrics;
  /** Every dimension, ranked by spend. Empty array for a dimension the proxy never answered. */
  breakdowns: Record<GatewayDimension, GatewayBreakdownRow[]>;
  /** Dimensions that carry at least one row — the switcher only offers these. */
  availableDimensions: GatewayDimension[];
}

const EMPTY_BREAKDOWNS = Object.fromEntries(
  GATEWAY_DIMENSIONS.map((dimension) => [dimension, [] as GatewayBreakdownRow[]]),
) as Record<GatewayDimension, GatewayBreakdownRow[]>;

export const EMPTY_GATEWAY_SUMMARY: GatewaySummary = {
  daily: [],
  totals: EMPTY_GATEWAY_METRICS,
  breakdowns: EMPTY_BREAKDOWNS,
  availableDimensions: [],
};

/** ISO date shifted by `days` in UTC — the spine walks calendar days, not 24h steps. */
function shiftIso(iso: string, days: number): string {
  const [year, month, day] = iso.split('-');
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days))
    .toISOString()
    .slice(0, 10);
}

/**
 * Every ISO day from `from` to `to` inclusive. Capped so a malformed range
 * cannot spin: the API only ever holds 90 days, and a year of spine is already
 * far past anything the chart can draw.
 */
function isoSpine(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to && days.length < 400; day = shiftIso(day, 1)) {
    days.push(day);
  }
  return days;
}

/**
 * The daily series over the range, with missing days zero-filled and the
 * unsynced tail trimmed.
 *
 * LiteLLM omits a day it saw no traffic on, and so does our sync. Plotting the
 * sparse rows would silently compress a quiet weekend out of the x-axis; a
 * zero-filled spine draws the dip that actually happened. Zero is a fact here,
 * not an unknown — unlike the Copilot per-user metrics.
 *
 * The tail is the exception. The sync ends at *yesterday* UTC, and a preset
 * range anchors on today, so the last day or two of every spine are days the
 * proxy was never asked about. Filling those with zeros would draw a cliff to
 * the floor on every chart, every day. They are dropped instead: the series
 * ends on the last day the gateway actually reported.
 */
export function zeroFillDaily(
  points: readonly GatewayDailyPoint[],
  from: string,
  to: string,
): GatewayDailyPoint[] {
  const byDate = new Map(points.map((point) => [point.date, point]));
  const lastReported = points.reduce<string | null>(
    (latest, point) => (latest === null || point.date > latest ? point.date : latest),
    null,
  );
  const end = lastReported !== null && lastReported < to ? lastReported : to;

  return isoSpine(from, end).map(
    (date) => byDate.get(date) ?? { date, ...EMPTY_GATEWAY_METRICS },
  );
}

/**
 * One dimension's rows, summed across the range and ranked by spend.
 *
 * `totalSpend` is the gateway-wide range total, so a row's share reads as
 * "this much of what the gateway cost", comparable across dimensions. Ranking
 * by spend rather than by requests is deliberate: this is a FinOps console,
 * and the model that ran twice at $4 outranks the one that ran 4,000 times at
 * a thousandth of a cent.
 */
export function rankBreakdown(
  points: readonly GatewayBreakdownPoint[],
  dimension: GatewayDimension,
  totalSpend: number,
): GatewayBreakdownRow[] {
  const buckets = new Map<string, { label: string | null; points: GatewayBreakdownPoint[] }>();

  for (const point of points) {
    if (point.dimension !== dimension) continue;
    const bucket = buckets.get(point.key);
    if (bucket === undefined) {
      buckets.set(point.key, { label: point.label, points: [point] });
    } else {
      bucket.points.push(point);
      // The proxy may only resolve an alias on some days; first one wins.
      if (bucket.label === null) bucket.label = point.label;
    }
  }

  return [...buckets.entries()]
    .map(([key, bucket]) => {
      const metrics = sumGatewayMetrics(bucket.points);
      return {
        key,
        label: bucket.label,
        metrics,
        share: totalSpend > 0 ? metrics.spend / totalSpend : 0,
      };
    })
    .sort((a, b) => b.metrics.spend - a.metrics.spend || a.key.localeCompare(b.key));
}

/**
 * Everything the gateway page renders, from one payload and the range it was
 * fetched for. The range bounds come from the caller rather than from the data
 * so an empty payload still draws a full, flat axis instead of nothing.
 */
export function deriveGateway(
  usage: GatewayUsage | undefined,
  from: string,
  to: string,
): GatewaySummary {
  const daily = zeroFillDaily(usage?.daily ?? [], from, to);
  const totals = sumGatewayMetrics(daily);
  const breakdownPoints = usage?.breakdowns ?? [];

  const breakdowns = Object.fromEntries(
    GATEWAY_DIMENSIONS.map((dimension) => [
      dimension,
      rankBreakdown(breakdownPoints, dimension, totals.spend),
    ]),
  ) as Record<GatewayDimension, GatewayBreakdownRow[]>;

  return {
    daily,
    totals,
    breakdowns,
    availableDimensions: GATEWAY_DIMENSIONS.filter(
      (dimension) => breakdowns[dimension].length > 0,
    ),
  };
}
