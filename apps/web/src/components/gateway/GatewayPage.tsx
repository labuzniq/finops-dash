import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  cacheHitRate,
  costPerMillionTokens,
  costPerRequest,
  GATEWAY_RETENTION_DAYS,
  inputTokens,
  RANGE_DAYS,
  rangeDayCount,
  successRate,
} from '@dash/shared';
import type { DateRange, GatewayBudgetScope, GatewayDimension } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, count, EMPTY, percent, rangeLabel, relativeTime, usd } from '../../lib/format.js';
import { breakdownDailySeries, deriveGateway } from '../../lib/metrics/gateway.js';
import { deriveAdoption, hasAdoption } from '../../lib/metrics/gatewayAdoption.js';
import { deriveAgentTraffic, hasAgentTraffic } from '../../lib/metrics/gatewayAgents.js';
import { buildGatewayAlerts } from '../../lib/metrics/gatewayAlerts.js';
import { deriveGatewayHealth } from '../../lib/metrics/gatewayHealth.js';
import {
  deriveHealthHistory,
  hasHealthHistory,
  HEALTH_HISTORY_DAYS,
} from '../../lib/metrics/gatewayHealthHistory.js';
import { attributeAnomaly, detectSpendAnomalies } from '../../lib/metrics/gatewayAnomaly.js';
import { deriveBudgets } from '../../lib/metrics/gatewayBudgets.js';
import { deriveBudgetHistory } from '../../lib/metrics/gatewayBudgetHistory.js';
import { deriveGatewayCache, hasCacheActivity } from '../../lib/metrics/gatewayCache.js';
import { deriveCacheValue } from '../../lib/metrics/gatewayCacheValue.js';
import { deriveCatalog, hasCatalog } from '../../lib/metrics/gatewayCatalog.js';
import {
  CHARGEBACK_DIMENSIONS,
  chargebackMonths,
  chargebackRange,
  deriveChargeback,
} from '../../lib/metrics/gatewayChargeback.js';
import type { ChargebackDimension } from '../../lib/metrics/gatewayChargeback.js';
import { buildGatewayChartGeometry } from '../../lib/metrics/gatewayChart.js';
import {
  comparisonWindow,
  deriveGatewayComparison,
  isWithinRetention,
  optionalDelta,
  rankMovers,
  rateDelta,
} from '../../lib/metrics/gatewayCompare.js';
import type { MetricDelta } from '../../lib/metrics/gatewayCompare.js';
import {
  deriveGatewayExceptions,
  exceptionWindow,
  ledgerFailuresIn,
} from '../../lib/metrics/gatewayExceptions.js';
import { deriveSpendForecast, forecastRange } from '../../lib/metrics/gatewayForecast.js';
import { deriveGatewayLatency, latencyWindow } from '../../lib/metrics/gatewayLatency.js';
import {
  deriveGatewaySlowResponses,
  slowResponseWindow,
} from '../../lib/metrics/gatewaySlowResponses.js';
import {
  SLOW_RESPONSE_HISTORY_DAYS,
  deriveSlowResponseHistory,
  hasSlowResponseHistory,
} from '../../lib/metrics/gatewaySlowResponseHistory.js';
import { deriveLedger, hasLedger } from '../../lib/metrics/gatewayHistory.js';
import {
  deriveSpendLogs,
  ledgerRequestsIn,
  spendLogWindow,
} from '../../lib/metrics/gatewayLogs.js';
import { deriveGatewayMix, hasMixSignal } from '../../lib/metrics/gatewayMix.js';
import { deriveReliability } from '../../lib/metrics/gatewayReliability.js';
import {
  useGatewayBudgetHistory,
  useGatewayBudgets,
  useGatewayChargebackData,
  useGatewayComparisonData,
  useGatewayCoverage,
  useGatewayDeploymentHistory,
  useGatewayExceptions,
  useGatewayHealth,
  useGatewayLatency,
  useGatewaySlowResponseHistory,
  useGatewaySlowResponses,
  useGatewayModels,
  useGatewaySealHistory,
  useGatewaySeals,
  useGatewaySpendLogs,
  useGatewayData,
  useGatewayForecastData,
  useGatewayStatus,
} from '../../hooks/useGatewayData.js';
import { useLatestJob } from '../../hooks/useCopilotData.js';
import type { UseSyncJob } from '../../hooks/useCopilotData.js';
import { spendRangeBounds } from '../../hooks/useSpendData.js';
import { Card } from '../Card.js';
import { DateRangePicker } from '../DateRangePicker.js';
import { GatewayAdoptionCard } from './GatewayAdoptionCard.js';
import { GatewayAgentsCard } from './GatewayAgentsCard.js';
import { GatewayAnomalyCard } from './GatewayAnomalyCard.js';
import { GatewayAttentionCard } from './GatewayAttentionCard.js';
import { GatewayBreakdownCard } from './GatewayBreakdownCard.js';
import { GatewayBudgetCard } from './GatewayBudgetCard.js';
import { GatewayCacheCard } from './GatewayCacheCard.js';
import { GatewayCatalogCard } from './GatewayCatalogCard.js';
import { GatewayHealthCard } from './GatewayHealthCard.js';
import { GatewayHealthHistoryCard } from './GatewayHealthHistoryCard.js';
import { GatewayChargebackCard } from './GatewayChargebackCard.js';
import { GatewayCoverageNote } from './GatewayCoverageNote.js';
import { GatewayForecastCard } from './GatewayForecastCard.js';
import { GatewayHistoryCard } from './GatewayHistoryCard.js';
import { GatewayKeyDetail } from './GatewayKeyDetail.js';
import { GatewayMixCard } from './GatewayMixCard.js';
import { GatewayMoversCard } from './GatewayMoversCard.js';
import { GatewayExceptionCard } from './GatewayExceptionCard.js';
import { GatewayLatencyCard } from './GatewayLatencyCard.js';
import { GatewaySlowResponseCard } from './GatewaySlowResponseCard.js';
import { GatewaySlowResponseHistoryCard } from './GatewaySlowResponseHistoryCard.js';
import { GatewayReliabilityCard } from './GatewayReliabilityCard.js';
import { GatewayRequestLogCard } from './GatewayRequestLogCard.js';
import { GatewayTrendCard } from './GatewayTrendCard.js';
import styles from './GatewayPage.module.css';

/**
 * The corporate LLM gateway — LiteLLM in front of Azure AI Foundry, Azure
 * OpenAI and AWS Bedrock, as one per-token spend surface.
 *
 * Deliberately never joined with the Copilot pages: Copilot spend is per-seat
 * and licence-shaped, gateway spend is per-token and workload-shaped, and one
 * number spanning both would mean nothing. The two live side by side in the
 * nav and nowhere else.
 *
 * DRAFT — the numbers here are whatever `GATEWAY_SOURCE` yields, which is the
 * seeded mock until a real proxy is reachable. See docs/litellm-gateway.md.
 */

const MS_PER_DAY = 86_400_000;

/**
 * How far back the budget card's per-row history reaches.
 *
 * Not tied to the range picker or to the proxy's 90-day retention: these rows
 * are our own observations and nothing prunes them. Sixty days covers two
 * monthly budget periods, which is the shortest window in which "last period"
 * means anything.
 */
const BUDGET_HISTORY_DAYS = 60;

function KpiCard({
  kicker,
  value,
  trend,
  children,
}: {
  kicker: string;
  value: ReactNode;
  /** Period-over-period note, absent when there is nothing to compare against. */
  trend?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card padded={false} className={styles.kpiCard}>
      <div className={styles.kicker}>{kicker}</div>
      <div className={styles.kpiValue}>{value}</div>
      <div className={styles.kpiSub}>{children}</div>
      {trend}
    </Card>
  );
}

/**
 * Which direction of a metric is worth flagging.
 *
 * `cost` — up is money out, drawn in the negative hue. `quality` — up is
 * better. `neutral` — volume, which is neither good nor bad on its own: more
 * requests are the point of the gateway, so they get an arrow and no colour.
 */
type Tone = 'cost' | 'neutral' | 'quality';

function toneClass(direction: number, tone: Tone): string | false | undefined {
  if (direction === 0 || tone === 'neutral') return false;
  const adverse = tone === 'cost' ? direction > 0 : direction < 0;
  return adverse ? styles.trendNeg : styles.trendPos;
}

function arrowFor(direction: number): string {
  return direction > 0 ? '▲' : direction < 0 ? '▼' : '·';
}

/** `▲ +12.4% · vs $1,204.11` — the change, then what it is a change from. */
function TrendNote({
  delta,
  tone,
  format,
}: {
  delta: MetricDelta | null;
  tone: Tone;
  format: (value: number) => string;
}) {
  if (delta === null) return null;

  const direction = Math.sign(delta.absolute);
  const change =
    delta.change === null
      ? delta.current > 0
        ? 'new this period'
        : 'no prior activity'
      : `${delta.change >= 0 ? '+' : '−'}${Math.abs(delta.change * 100).toFixed(1)}%`;

  return (
    <div className={styles.trend}>
      <span className={cx(styles.trendValue, toneClass(direction, tone))}>
        {arrowFor(direction)} {change}
      </span>
      {delta.change !== null && <span className={styles.trendPrev}>vs {format(delta.previous)}</span>}
    </div>
  );
}

/**
 * Rates move in percentage *points*, never in percent of a percent: a cache-hit
 * rate going 20% → 24% is +4 points, and calling it +20% would be a different,
 * wrong claim.
 */
function RateTrendNote({ points, tone }: { points: number | null; tone: Tone }) {
  if (points === null) return null;

  const direction = Math.sign(Number(points.toFixed(1)));
  return (
    <div className={styles.trend}>
      <span className={cx(styles.trendValue, toneClass(direction, tone))}>
        {arrowFor(direction)} {points >= 0 ? '+' : '−'}
        {Math.abs(points).toFixed(1)} pts
      </span>
      <span className={styles.trendPrev}>vs prior period</span>
    </div>
  );
}

/** Percentages that are only meaningful when something happened. */
function optionalRate(value: number | null): string {
  return value === null ? EMPTY : `${value.toFixed(1)}%`;
}

interface GatewayPageProps {
  /** The gateway sync job, owned by `App` so it outlives navigating away. */
  sync: UseSyncJob;
}

export function GatewayPage({ sync }: GatewayPageProps) {
  const [range, setRange] = useState<DateRange>({ kind: 'preset', days: RANGE_DAYS[0] });
  const [dimension, setDimension] = useState<GatewayDimension>('model');
  /** The drilled-into key. Held as a key, not a row, so it survives a refetch. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** The flagged day whose overrun is attributed, held as a date for the same reason. */
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  /** Which governance scope the budget card shows. Keys and teams cap the same dollars. */
  const [budgetScope, setBudgetScope] = useState<GatewayBudgetScope>('api_key');
  /**
   * The chargeback statement's own period and payer, held apart from the range
   * picker and the breakdown switcher on purpose: a bill is issued for a
   * calendar month against whoever is being charged, and neither of those is
   * the question the rest of the page is answering. Null month means "the one
   * in flight", resolved once retention is known.
   */
  const [billMonth, setBillMonth] = useState<string | null>(null);
  const [billDimension, setBillDimension] = useState<ChargebackDimension>('team');
  /**
   * The two axes of the request-log matrix, held apart from the breakdown
   * switcher because they are a different question: every other card asks "how
   * does this one dimension divide the money", and this one asks how two of
   * them cross. `team × model` is the default because it is the pair the
   * aggregate layer most obviously cannot answer.
   */
  const [logRowDimension, setLogRowDimension] = useState<GatewayDimension>('team');
  const [logColumnDimension, setLogColumnDimension] = useState<GatewayDimension>('model');

  const statusQuery = useGatewayStatus();
  const usageQuery = useGatewayData(range);
  const latestJobQuery = useLatestJob('gateway');
  // Which days are actually stored. Gated on the source only so an `off`
  // gateway makes no call; the answer is needed before the pickers can be
  // clamped, so it runs alongside the usage fetch rather than after it.
  const coverageQuery = useGatewayCoverage(statusQuery.data?.configured ?? false);
  const coverage = coverageQuery.data ?? null;
  // Which months have been held still. Cheap (one row per closed month) and
  // read only by the statement, but fetched here with the other bounds queries
  // because it answers a question about the table rather than about a range.
  const sealsQuery = useGatewaySeals(statusQuery.data?.configured ?? false);

  const { from, to } = spendRangeBounds(range);
  const summary = useMemo(() => deriveGateway(usageQuery.data, from, to), [usageQuery.data, from, to]);

  const charts = useMemo(
    () => ({
      spend: buildGatewayChartGeometry(summary.daily, 'spend'),
      tokens: buildGatewayChartGeometry(summary.daily, 'totalTokens'),
      requests: buildGatewayChartGeometry(summary.daily, 'requests'),
    }),
    [summary.daily],
  );

  const maxIso = new Date().toISOString().slice(0, 10);
  /**
   * How far back the page may look — the earliest day the dashboard has
   * *stored*, not the earliest day the proxy would still answer for.
   *
   * The two diverge the longer the scheduler runs: the sync deletes only the
   * dates it re-fetched, so `gateway_daily` keeps every day it has ever pulled
   * while LiteLLM prunes at 90. Clamping to the proxy's window would hide
   * history the API is holding, and it is the same floor the comparison window
   * and the chargeback month list use, so it is computed once here.
   *
   * The retention window is the fallback until coverage answers, deliberately:
   * it is the narrower of the two, so the picker can lag behind the stored
   * history for a moment but can never offer a range with nothing behind it.
   */
  const retentionFloorIso = new Date(Date.now() - GATEWAY_RETENTION_DAYS * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
  const minIso = coverage?.floor ?? retentionFloorIso;
  const rangeDays = rangeDayCount(range);

  const { totals } = summary;

  // The dimension the user picked may carry no rows in a shorter range; fall
  // back to whatever the proxy did answer rather than showing an empty card.
  const activeDimension =
    summary.availableDimensions.includes(dimension) || summary.availableDimensions.length === 0
      ? dimension
      : (summary.availableDimensions[0] ?? dimension);

  // The prior window is measured off the *trimmed* spine, so it is exactly as
  // long as what is on screen — and it is only asked for when it is inside the
  // stored history, where an empty answer would mean "nothing spent" rather
  // than "never synced".
  const priorWindow = useMemo(() => {
    const window = comparisonWindow(summary.daily);
    return window !== null && isWithinRetention(window, minIso) ? window : null;
  }, [summary.daily, minIso]);

  const priorQuery = useGatewayComparisonData(priorWindow);
  const priorUsage = priorQuery.data;

  const comparison = useMemo(
    () =>
      priorWindow === null || priorQuery.isPending
        ? null
        : deriveGatewayComparison(priorUsage, priorWindow, totals),
    [priorUsage, priorWindow, priorQuery.isPending, totals],
  );
  const compared = comparison !== null && comparison.hasActivity ? comparison : null;

  // Movers follow the breakdown's dimension: the two cards answer "where does
  // the money go" and "where did it move" about the same slice, so they must
  // never disagree about which slice that is.
  const movers = useMemo(
    () =>
      compared === null
        ? []
        : rankMovers(
            summary.breakdowns[activeDimension],
            priorUsage?.breakdowns ?? [],
            activeDimension,
          ),
    [compared, summary, activeDimension, priorUsage],
  );

  // The movement's *reason*, on the same two windows the movers card uses. It
  // follows the switcher for a reason of its own: mix and rate are relative to
  // the slice — traffic moving to a dearer model inside one provider is mix by
  // model and rate by provider — so which one is on screen changes the answer.
  const mix = useMemo(
    () =>
      compared === null
        ? null
        : deriveGatewayMix(
            summary.breakdowns[activeDimension],
            priorUsage?.breakdowns ?? [],
            activeDimension,
            totals,
            compared.totals,
            compared.window,
          ),
    [compared, summary, activeDimension, priorUsage, totals],
  );

  const configured = statusQuery.data?.configured ?? false;
  const source = statusQuery.data?.source ?? 'off';

  // The forecast answers a calendar-month question, so it fetches its own
  // month-shaped window rather than reading the range picker's. Null until the
  // month has a reported day — on the 1st there is nothing to project from.
  const forecastRangeValue = useMemo(() => forecastRange(maxIso), [maxIso]);
  const forecastQuery = useGatewayForecastData(forecastRangeValue, configured);
  const forecast = useMemo(
    () => deriveSpendForecast(forecastQuery.data?.daily ?? [], forecastRangeValue),
    [forecastQuery.data, forecastRangeValue],
  );

  // Governance is the one gateway surface with no date range: the proxy reports
  // one current state per key and per team and keeps no history of it, so this
  // query carries no bounds and re-derives only when a sync replaces the rows.
  // `now` is read at derivation time and only feeds the pace projection, which
  // moves by a fraction of a percent an hour.
  const budgetsQuery = useGatewayBudgets(configured);
  const budgets = useMemo(
    () => deriveBudgets(budgetsQuery.data?.budgets, new Date()),
    [budgetsQuery.data],
  );

  // ...and the one governance fact that *does* have a range: what those same
  // budgets read on previous days, which only exists because the sync keeps a
  // reading rather than because the proxy serves one. Its own fixed window, not
  // the range picker's — a budget period has nothing to do with the days on the
  // charts above, and the record starts when recording started either way.
  const budgetHistoryQuery = useGatewayBudgetHistory(BUDGET_HISTORY_DAYS, configured);
  const budgetHistory = useMemo(
    () => deriveBudgetHistory(budgetHistoryQuery.data),
    [budgetHistoryQuery.data],
  );

  // The chargeback statement's window is a calendar month picked here, plus
  // the month before it in the same request so every line carries a
  // prior-period figure. Deliberately independent of the range picker: an
  // invoice period is a month, and "the last 28 days" bills nobody.
  const billMonths = useMemo(() => chargebackMonths(maxIso, minIso), [maxIso, minIso]);
  const activeMonth = billMonth !== null && billMonths.includes(billMonth)
    ? billMonth
    : (billMonths[0] ?? maxIso.slice(0, 7));
  const billRange = useMemo(
    () => chargebackRange(activeMonth, maxIso, minIso),
    [activeMonth, maxIso, minIso],
  );
  const billQuery = useGatewayChargebackData(billRange, configured);

  // The payer dimensions the proxy actually answered for. A gateway that tags
  // nothing falls back to `api_key`, which always exists — every call is made
  // with one, so there is always somebody to bill.
  const billDimensions = useMemo(() => {
    const present = new Set(
      (billQuery.data?.breakdowns ?? []).map((point) => point.dimension as string),
    );
    const offered = CHARGEBACK_DIMENSIONS.filter((option) => present.has(option));
    return offered.length > 0 ? offered : (['api_key'] as ChargebackDimension[]);
  }, [billQuery.data]);

  const activeBillDimension = billDimensions.includes(billDimension)
    ? billDimension
    : (billDimensions[0] ?? 'api_key');

  const statement = useMemo(
    () =>
      deriveChargeback(
        billQuery.data?.daily ?? [],
        billQuery.data?.breakdowns ?? [],
        billRange,
        activeBillDimension,
      ),
    [billQuery.data, billRange, activeBillDimension],
  );

  // The seal for the month on screen, if it has one. Resolved by month key
  // rather than held in state, so switching months picks up the right seal —
  // or none, for a month still in flight.
  const activeSeal =
    (sealsQuery.data?.seals ?? []).find((seal) => seal.month === activeMonth) ?? null;
  // Only a month that has been billed more than once has a history worth
  // fetching, and the seal list already says which those are — so an ordinary
  // month costs no extra request.
  const sealHistoryQuery = useGatewaySealHistory(
    activeMonth,
    (activeSeal?.revision ?? 1) > 1,
  );

  // The month-by-month ledger, off the same seal list the statement reads. It
  // is the one derivation on this page that is *not* bounded by the range
  // picker or by the proxy's retention: a sealed month is a record, so the
  // ledger keeps answering for months whose daily rows LiteLLM has pruned.
  const ledger = useMemo(
    () => deriveLedger(sealsQuery.data, { todayIso: maxIso, retentionFloorIso }),
    [sealsQuery.data, maxIso, retentionFloorIso],
  );

  const latestJob = latestJobQuery.data ?? null;
  const hasData = totals.requests > 0 || totals.spend > 0;

  // Resolving the selection against the *current* rows is what makes switching
  // dimension or shortening the range close the drill-down by itself: a key
  // that is no longer ranked simply stops resolving, and nothing stale renders.
  const selectedRow =
    summary.breakdowns[activeDimension].find((row) => row.key === selectedKey) ?? null;

  // Runaway days, and — for the opened one — which keys of the *current*
  // dimension paid for it. Switching dimension re-attributes the same day
  // rather than closing it: "who overran" is a different question per slice.
  const anomalies = useMemo(() => detectSpendAnomalies(summary.daily), [summary.daily]);
  const openAnomaly = anomalies.some((anomaly) => anomaly.date === selectedDay) ? selectedDay : null;

  const attribution = useMemo(
    () =>
      openAnomaly === null
        ? null
        : attributeAnomaly(
            usageQuery.data?.breakdowns ?? [],
            activeDimension,
            openAnomaly,
            summary.daily,
          ),
    [usageQuery.data, activeDimension, openAnomaly, summary.daily],
  );

  // Reliability follows the same dimension as the breakdown and the movers, for
  // the same reason: three cards discussing the same slice must never disagree
  // about which slice it is.
  const reliability = useMemo(
    () => deriveReliability(summary.daily, usageQuery.data?.breakdowns ?? [], activeDimension),
    [summary.daily, usageQuery.data, activeDimension],
  );

  // Cache efficiency follows the switcher too — "who is re-sending the same
  // input" is a question about a slice, and it reads differently by model (does
  // this deployment cache at all) than by key (does this workload build its
  // prompts so it can).
  const cache = useMemo(
    () => deriveGatewayCache(summary.daily, usageQuery.data?.breakdowns ?? [], activeDimension),
    [summary.daily, usageQuery.data, activeDimension],
  );

  // The price list, joined to the `model` dimension — pinned to that constant
  // rather than the switcher for the same reason the agent and adoption cards
  // are pinned to theirs: a catalogue prices models, and "what does a team cost
  // per million tokens" is a question about a workload's mix, not about a rate.
  // The rows come from the same ranked breakdown the table renders, so the two
  // cards can never disagree about what a model cost.
  const catalogQuery = useGatewayModels(configured);
  const catalog = useMemo(
    () =>
      deriveCatalog(
        summary.breakdowns.model,
        catalogQuery.data?.models ?? [],
        summary.totals.spend,
      ),
    [summary.breakdowns.model, catalogQuery.data, summary.totals.spend],
  );

  // The cache priced from that same catalogue — pinned to `model` for a reason
  // the cache card itself cannot be: a rate belongs to a model, and one team's
  // cached tokens span every model it touched at rates differing by a factor, so
  // a per-team saving would be an average of price lists. It is what lifts the
  // cache card's refusal to report dollars, on the one dimension where it can.
  const cacheValue = useMemo(
    () =>
      deriveCacheValue({
        modelRows: summary.breakdowns.model,
        catalogue: catalogQuery.data?.models ?? [],
        // The spine's own totals, not the cache summary's rate: the module
        // levels headroom on the same convention it prices with, and the two
        // differ over whether a cache read is already counted inside
        // `promptTokens`. See the note on `CacheValueInput`.
        gatewayTotals: summary.totals,
      }),
    [summary.breakdowns.model, catalogQuery.data, summary.totals],
  );

  // Deployment health — a snapshot like the catalogue and the budget list, and
  // the only reading keyed *below* the model alias. It is deliberately not
  // scoped to the range picker: `/health` describes the router as it is now (or
  // rather, as it was when the sync last asked), and the card carries the
  // reading's own age instead of pretending otherwise.
  const healthQuery = useGatewayHealth(configured);
  const health = useMemo(
    () => deriveGatewayHealth(healthQuery.data ?? null, new Date()),
    [healthQuery.data],
  );

  // The same readings kept — the only thing that separates a pool refusing
  // tonight from one that has refused every night this week. Its own window
  // rather than the range picker's, for the same reason the snapshot has none:
  // these are our readings of the router, not days of gateway usage, and the
  // recording starts when this dashboard did.
  const healthHistoryQuery = useGatewayDeploymentHistory(HEALTH_HISTORY_DAYS, configured);
  const healthHistory = useMemo(
    () => deriveHealthHistory(healthHistoryQuery.data ?? null),
    [healthHistoryQuery.data],
  );

  // The request sample — the page's one *live* read and its only joint-keyed
  // source. Its window is the tail of the trimmed spine rather than the range
  // picker's bounds, so the sample is evidence about the days actually on
  // screen, and it is never fetched until the card's button asks: these rows
  // come from the largest table the proxy has.
  const logWindow = useMemo(() => spendLogWindow(summary.daily), [summary.daily]);
  const logsQuery = useGatewaySpendLogs(logWindow);
  // The ledger's own request count for the same days, taken from the spine the
  // page already holds. It is the sample's completeness denominator, and it is
  // in requests rather than dollars deliberately: a share of gateway *spend*
  // derived from a capped sample is the one number this layer must not produce.
  const logs = useMemo(
    () =>
      deriveSpendLogs(logsQuery.data ?? null, {
        rowDimension: logRowDimension,
        columnDimension: logColumnDimension,
        ledgerRequests: ledgerRequestsIn(summary.daily, logWindow),
      }),
    [logsQuery.data, logRowDimension, logColumnDimension, summary.daily, logWindow],
  );

  // Why those failures happened — the page's second live read, and the only
  // source of a *reason*. Its window is the tail of the trimmed spine like the
  // request sample's, capped at a month by the error table's own retention, and
  // it is never fetched until the card's button asks: the proxy's route filters
  // on one alias at a time, so a read is a round trip per model.
  const exceptionRead = useMemo(() => exceptionWindow(summary.daily), [summary.daily]);
  const exceptionsQuery = useGatewayExceptions(exceptionRead);
  // Two parameters the module refuses to fetch for itself: the ledger's own
  // failure count for the same days (context beside the exception total, never
  // its denominator — the two tables are switched and pruned independently),
  // and tonight's health reading, which is the only other surface keyed at a
  // deployment and therefore the only thing these rows can be joined to.
  const exceptions = useMemo(
    () =>
      deriveGatewayExceptions(exceptionsQuery.data ?? null, {
        ledgerFailures: ledgerFailuresIn(summary.daily, exceptionRead),
        health: healthQuery.data ?? null,
      }),
    [exceptionsQuery.data, summary.daily, exceptionRead, healthQuery.data],
  );

  // How slowly the backends answered — the page's third live read and its only
  // card about time. Same window rule as the exception sweep (the tail of the
  // trimmed spine, capped by the route's own month) and the same press-to-read
  // rule, for the same two reasons: a round trip per alias, over the request
  // log rather than the daily rows.
  const latencyRead = useMemo(() => latencyWindow(summary.daily), [summary.daily]);
  const latencyQuery = useGatewayLatency(latencyRead);
  // The one parameter the module refuses to fetch for itself: tonight's health
  // reading. It is the only other deployment-keyed source, so it is the only
  // thing these rows can be joined to — and this route's key is coarser than
  // the exception one, so the join has a `mixed` state the other did not need.
  const latency = useMemo(
    () => deriveGatewayLatency(latencyQuery.data ?? null, { health: healthQuery.data ?? null }),
    [latencyQuery.data, healthQuery.data],
  );

  // How many of the calls that did not fail hung anyway — the page's fourth and
  // last live read, and the only one that measures wall clock. Same window rule
  // and same press-to-read rule as the two sweeps above it; the two parameters
  // it refuses to fetch for itself are the ledger's request count for the same
  // days (a disagreement between two tables, shown beside the route's own
  // denominator and never used as one) and tonight's health reading.
  const slowRead = useMemo(() => slowResponseWindow(summary.daily), [summary.daily]);
  const slowQuery = useGatewaySlowResponses(slowRead);
  const slowResponses = useMemo(
    () =>
      deriveGatewaySlowResponses(slowQuery.data ?? null, {
        ledgerRequests: ledgerRequestsIn(summary.daily, slowRead),
        health: healthQuery.data ?? null,
      }),
    [slowQuery.data, summary.daily, slowRead, healthQuery.data],
  );

  // The same sweeps kept — the only one of the four live reads that has a
  // history, and the only one that may: this route answers counts of disjoint
  // request-log rows beside their own denominator, and counts add across nights
  // where a mean of per-request ratios and a denominator-less total do not. Its
  // own window rather than the range picker's, like the two other history cards,
  // because these are our nightly readings rather than days of gateway usage —
  // and unlike the live read above it, it runs on mount: it is a table of ours.
  const slowHistoryQuery = useGatewaySlowResponseHistory(SLOW_RESPONSE_HISTORY_DAYS, configured);
  const slowHistory = useMemo(
    () => deriveSlowResponseHistory(slowHistoryQuery.data ?? null),
    [slowHistoryQuery.data],
  );

  // The one card that does not follow the dimension switcher: `mcp_server` is
  // a subset of the same requests rather than a peer slice, so it is the only
  // dimension the totals can legitimately be split *by*. Reading it through the
  // switcher would put it back among the overlapping six.
  const agents = useMemo(
    () => deriveAgentTraffic(summary.daily, usageQuery.data?.breakdowns ?? []),
    [summary.daily, usageQuery.data],
  );

  // The page's other card that is pinned to a constant dimension rather than
  // the switcher: `user` is the only slice that is a population rather than a
  // workload, and the questions it answers — how many people, how evenly — have
  // no meaning read through `model` or `provider`.
  const adoption = useMemo(
    () => deriveAdoption(summary.daily, usageQuery.data?.breakdowns ?? []),
    [summary.daily, usageQuery.data],
  );

  // Everything the cards below have already flagged, in one list at the top.
  // It reads the derived summaries rather than the payload on purpose: the
  // digest must not be able to disagree with the card it points at, so it owns
  // no threshold of its own and can only repeat a finding somebody else made.
  const attention = useMemo(
    () =>
      buildGatewayAlerts({
        budgets,
        budgetsLoaded: !budgetsQuery.isPending,
        history: budgetHistory,
        anomalies,
        reliability,
        cache,
        coverage,
        health,
      }),
    [
      budgets,
      budgetsQuery.isPending,
      budgetHistory,
      anomalies,
      reliability,
      cache,
      coverage,
      health,
    ],
  );

  const selectedDaily = useMemo(
    () =>
      selectedRow === null
        ? []
        : breakdownDailySeries(
            usageQuery.data?.breakdowns ?? [],
            activeDimension,
            selectedRow.key,
            summary.daily,
          ),
    [usageQuery.data, activeDimension, selectedRow, summary.daily],
  );

  return (
    <>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>LLM gateway</div>
          <div className={styles.sub}>
            LiteLLM proxy · Azure AI Foundry · Azure OpenAI · AWS Bedrock
          </div>
        </div>
        <div className={styles.sourceTag}>
          source: <span className={styles.sourceValue}>{source}</span>
        </div>
      </div>

      <div className={styles.filterBar}>
        <div className={styles.segmented} role="group" aria-label="Date range">
          {RANGE_DAYS.map((days) => {
            const active = range.kind === 'preset' && days === range.days;
            return (
              <button
                key={days}
                type="button"
                className={cx(styles.segment, active && styles.segmentActive)}
                aria-pressed={active}
                onClick={() => setRange({ kind: 'preset', days })}
              >
                {days}d
              </button>
            );
          })}
          <DateRangePicker
            range={range}
            min={minIso}
            max={maxIso}
            onApply={(customFrom, customTo) => setRange({ kind: 'custom', from: customFrom, to: customTo })}
          />
        </div>

        <div className={styles.spacer} />

        <div className={styles.syncNote}>
          {latestJob?.finishedAt ? `synced ${relativeTime(latestJob.finishedAt)}` : 'not yet synced'}
        </div>
        <button
          type="button"
          className={styles.syncButton}
          onClick={() => sync.sync()}
          disabled={sync.isRunning || !configured}
        >
          {sync.isRunning ? 'Syncing…' : 'Sync'}
        </button>
      </div>

      {sync.error !== null && <div className={cx(styles.status, styles.error)}>{sync.error}</div>}

      {!statusQuery.isPending && !configured && (
        <div className={styles.status}>
          No gateway source is configured. Set <span className={styles.hint}>GATEWAY_SOURCE=mock</span> for
          the seeded dataset, or <span className={styles.hint}>GATEWAY_SOURCE=litellm</span> with{' '}
          <span className={styles.hint}>LITELLM_BASE_URL</span> and{' '}
          <span className={styles.hint}>LITELLM_API_KEY</span> to read the real proxy.
        </div>
      )}

      {usageQuery.error && (
        <div className={cx(styles.status, styles.error)}>
          Could not load gateway usage: {usageQuery.error.message}
        </div>
      )}

      {configured && !usageQuery.error && usageQuery.isPending && (
        <div className={styles.status}>Loading gateway usage…</div>
      )}

      {configured && !usageQuery.error && !usageQuery.isPending && !hasData && (
        <div className={styles.status}>
          No gateway activity in this range. Run a sync to pull the proxy&apos;s daily aggregates.
        </div>
      )}

      {configured && !usageQuery.error && !usageQuery.isPending && hasData && (
        <>
          {/*
            The anchors the digest scrolls to. Wrapper elements rather than ids
            on the cards themselves, because a card that stands itself down —
            the cache card on a gateway with no cache activity — would take its
            anchor with it, and a jump button pointing at nothing is worse than
            no button.
          */}
          <div id="gateway-coverage">
            <GatewayCoverageNote
              coverage={coverage}
              onBackfill={(window) => sync.sync(window)}
              isSyncing={sync.isRunning}
            />
          </div>

          <GatewayAttentionCard digest={attention} />

          {compared !== null && (
            <div className={styles.compareNote}>
              compared against the preceding {compared.window.days} days ({compared.window.from} …{' '}
              {compared.window.to})
            </div>
          )}

          <div className={styles.kpiRow}>
            <KpiCard
              kicker={`GATEWAY SPEND · ${rangeDays}d`}
              value={usd(totals.spend, 2)}
              trend={
                <TrendNote
                  delta={compared?.spend ?? null}
                  tone="cost"
                  format={(value) => usd(value, 2)}
                />
              }
            >
              per-token cost across every provider
            </KpiCard>
            <KpiCard
              kicker="REQUESTS"
              value={compactCount(totals.requests)}
              trend={
                <TrendNote delta={compared?.requests ?? null} tone="neutral" format={compactCount} />
              }
            >
              {optionalRate(successRate(totals))} succeeded
            </KpiCard>
            <KpiCard
              kicker="TOKENS"
              value={compactCount(totals.totalTokens)}
              trend={
                <TrendNote
                  delta={compared?.totalTokens ?? null}
                  tone="neutral"
                  format={compactCount}
                />
              }
            >
              {compactCount(totals.promptTokens)} in · {compactCount(totals.completionTokens)} out
            </KpiCard>
            <KpiCard
              kicker="COST PER 1M TOKENS"
              value={
                costPerMillionTokens(totals) === null
                  ? EMPTY
                  : usd(costPerMillionTokens(totals) ?? 0, 2)
              }
              trend={
                <TrendNote
                  delta={
                    compared === null
                      ? null
                      : optionalDelta(
                          costPerMillionTokens(totals),
                          costPerMillionTokens(compared.totals),
                        )
                  }
                  tone="cost"
                  format={(value) => usd(value, 2)}
                />
              }
            >
              blended across models and providers
            </KpiCard>
          </div>

          <div className={styles.kpiRowSecondary}>
            <KpiCard
              kicker="PROMPT CACHE HIT RATE"
              value={optionalRate(cacheHitRate(totals))}
              trend={
                <RateTrendNote
                  points={
                    compared === null
                      ? null
                      : rateDelta(cacheHitRate(totals), cacheHitRate(compared.totals))
                  }
                  tone="quality"
                />
              }
            >
              {compactCount(totals.cacheReadTokens)} of {compactCount(inputTokens(totals))} input tokens served from cache
            </KpiCard>
            <KpiCard
              kicker="COST PER REQUEST"
              value={costPerRequest(totals) === null ? EMPTY : usd(costPerRequest(totals) ?? 0, 4)}
              trend={
                <TrendNote
                  delta={
                    compared === null
                      ? null
                      : optionalDelta(costPerRequest(totals), costPerRequest(compared.totals))
                  }
                  tone="cost"
                  format={(value) => usd(value, 4)}
                />
              }
            >
              average across the range
            </KpiCard>
            <KpiCard
              kicker="FAILED REQUESTS"
              value={count(totals.failedRequests)}
              trend={
                <TrendNote delta={compared?.failedRequests ?? null} tone="cost" format={count} />
              }
            >
              {totals.requests === 0
                ? EMPTY
                : `${percent((totals.failedRequests / totals.requests) * 100)} of all calls`}
            </KpiCard>
          </div>

          {forecast !== null && <GatewayForecastCard forecast={forecast} />}

          <div id="gateway-budgets">
            <GatewayBudgetCard
              scopes={budgets.scopes}
              scope={budgetScope}
              onScope={setBudgetScope}
              loaded={!budgetsQuery.isPending}
              history={budgetHistory}
            />
          </div>

          <GatewayChargebackCard
            statement={statement}
            months={billMonths}
            onMonth={setBillMonth}
            onDimension={setBillDimension}
            available={billDimensions}
            seal={activeSeal}
            history={sealHistoryQuery.data ?? null}
            loading={billQuery.isPending}
          />

          {/*
            Directly under the statement on purpose: that card bills one month
            and this one is every month it has ever billed. It stands itself
            down until a month has been sealed — a ledger of nothing would say
            the gateway is new, when what it means is that no month has closed
            with all of its days stored yet.
          */}
          {hasLedger(ledger) && <GatewayHistoryCard ledger={ledger} />}


          <div className={styles.chartRow}>
            <GatewayTrendCard title="Daily gateway spend" sub={rangeLabel(range)} chart={charts.spend} />
            <GatewayTrendCard title="Daily tokens" sub="input + output" chart={charts.tokens} />
          </div>

          <GatewayTrendCard title="Daily requests" sub="successes + failures" chart={charts.requests} />

          <div id="gateway-anomalies">
            <GatewayAnomalyCard
              anomalies={anomalies}
              dimension={activeDimension}
              selectedDate={openAnomaly}
              onSelect={(date) => setSelectedDay((current) => (current === date ? null : date))}
              attribution={attribution}
            />
          </div>

          <div id="gateway-reliability">
            <GatewayReliabilityCard summary={reliability} />
          </div>

          {/*
            Immediately under reliability, and deliberately not instead of it:
            that card says how many calls failed and where, this one says what
            they were. The ledger has no error column at all, so a rate limit
            and an expired credential are one number up there and two different
            jobs down here — and a reader given only this card would read an
            exception count as a failure count, which is why it never appears
            without the rate above it.
          */}
          <div id="gateway-exceptions">
            <GatewayExceptionCard
              view={exceptions}
              onRead={() => void exceptionsQuery.refetch()}
              loading={exceptionsQuery.isFetching}
              error={exceptionsQuery.error instanceof Error ? exceptionsQuery.error : null}
              enabled={configured && exceptionRead !== null}
            />
          </div>

          {/*
            Directly under the reason card, and the third question about the
            same failures: how many, why, and — here — how slowly the ones that
            *succeeded* came back. A deployment that answers everything at a
            crawl fails nothing and bills normally, so it is invisible on every
            card above; and this is the page's only rate, which is why the unit
            is spelled out on the card rather than assumed.
          */}
          <div id="gateway-latency">
            <GatewayLatencyCard
              view={latency}
              onRead={() => void latencyQuery.refetch()}
              loading={latencyQuery.isFetching}
              error={latencyQuery.error instanceof Error ? latencyQuery.error : null}
              enabled={configured && latencyRead !== null}
            />
          </div>

          {/*
            The last of the four questions about the same window of traffic, and
            the only one about wall clock: how many calls failed, why, how
            slowly the rest came back per token — and here, how many ran past
            the proxy's own alerting threshold and then answered anyway. That
            call is a success on the reliability card, silent on the exception
            card, and unremarkable on the latency card if the answer was long.
          */}
          <div id="gateway-slow-responses">
            <GatewaySlowResponseCard
              view={slowResponses}
              onRead={() => void slowQuery.refetch()}
              loading={slowQuery.isFetching}
              error={slowQuery.error instanceof Error ? slowQuery.error : null}
              enabled={configured && slowRead !== null}
            />
          </div>

          {/*
            Directly under the live read, because it is the same sweep with the
            question a single window cannot answer asked of it: "how many hung"
            is only ever readable next to "how many usually do". It stands itself
            down until a night has been filed — there is no backfill for this
            table, so an empty one means the recording has not started rather
            than that nothing has ever hung.
          */}
          <div id="gateway-slow-response-history">
            {hasSlowResponseHistory(slowHistory) && (
              <GatewaySlowResponseHistoryCard view={slowHistory} />
            )}
          </div>

          {/*
            Under reliability on purpose: that card counts calls that failed,
            and this one is the capacity behind them — a degraded alias fails
            nothing at all, which is exactly why it needs its own card. It
            stands itself down when no reading has ever been stored — a proxy
            that never answered /health is a blind spot on the digest above
            rather than an empty table here.
          */}
          <div id="gateway-health">
            {health.answered && !health.isEmpty && <GatewayHealthCard view={health} />}
          </div>

          {/*
            Directly under the snapshot, because it is the same reading with a
            second question asked of it. It stands itself down until a reading
            has been filed: there is no backfill for this table, so an empty one
            means the recording has not started rather than that nothing has
            ever failed — and the digest above already names an unread /health.
          */}
          <div id="gateway-health-history">
            {hasHealthHistory(healthHistory) && (
              <GatewayHealthHistoryCard view={healthHistory} />
            )}
          </div>

          <div id="gateway-cache">
            {hasCacheActivity(cache) && <GatewayCacheCard summary={cache} value={cacheValue} />}
          </div>

          {/*
            Directly under the cache card on purpose: that card reports tokens
            and refuses dollars because the daily row carries one spend covering
            four kinds of token, and this is the list of rates that would price
            them apart — read as an estimate beside the bill, never instead of
            it.
          */}
          <div id="gateway-catalog">
            {hasCatalog(catalog) && <GatewayCatalogCard summary={catalog} />}
          </div>

          {hasAgentTraffic(agents) && <GatewayAgentsCard summary={agents} />}

          {hasAdoption(adoption) && <GatewayAdoptionCard summary={adoption} />}

          <GatewayBreakdownCard
            rows={summary.breakdowns[activeDimension]}
            dimension={activeDimension}
            available={summary.availableDimensions}
            onDimension={setDimension}
            selectedKey={selectedRow?.key ?? null}
            onSelect={(key) => setSelectedKey((current) => (current === key ? null : key))}
          />

          {compared !== null && movers.length > 0 && (
            <GatewayMoversCard rows={movers} dimension={activeDimension} window={compared.window} />
          )}

          {/*
            Last of the analysis cards, and the only one that fetches on a
            press: it reads individual requests from the proxy live, which is
            the one thing that can cross two dimensions — every card above it
            reads the daily aggregates, where each dimension is reported on its
            own and a joint key does not exist.
          */}
          <div id="gateway-request-log">
            <GatewayRequestLogCard
              view={logs}
              available={summary.availableDimensions}
              onRowDimension={setLogRowDimension}
              onColumnDimension={setLogColumnDimension}
              onRead={() => void logsQuery.refetch()}
              loading={logsQuery.isFetching}
              error={logsQuery.error instanceof Error ? logsQuery.error : null}
              enabled={configured && logWindow !== null}
            />
          </div>

          {hasMixSignal(mix) && <GatewayMixCard decomposition={mix} />}

          {selectedRow !== null && (
            <GatewayKeyDetail
              dimension={activeDimension}
              row={selectedRow}
              daily={selectedDaily}
              rangeLabel={rangeLabel(range)}
              onClose={() => setSelectedKey(null)}
            />
          )}
        </>
      )}
    </>
  );
}
