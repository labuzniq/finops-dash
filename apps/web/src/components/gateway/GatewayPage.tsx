import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  cacheHitRate,
  costPerMillionTokens,
  costPerRequest,
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
import { attributeAnomaly, detectSpendAnomalies } from '../../lib/metrics/gatewayAnomaly.js';
import { deriveBudgets } from '../../lib/metrics/gatewayBudgets.js';
import { deriveGatewayCache, hasCacheActivity } from '../../lib/metrics/gatewayCache.js';
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
import { deriveSpendForecast, forecastRange } from '../../lib/metrics/gatewayForecast.js';
import { deriveGatewayMix, hasMixSignal } from '../../lib/metrics/gatewayMix.js';
import { deriveReliability } from '../../lib/metrics/gatewayReliability.js';
import {
  useGatewayBudgets,
  useGatewayChargebackData,
  useGatewayComparisonData,
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
import { GatewayBreakdownCard } from './GatewayBreakdownCard.js';
import { GatewayBudgetCard } from './GatewayBudgetCard.js';
import { GatewayCacheCard } from './GatewayCacheCard.js';
import { GatewayChargebackCard } from './GatewayChargebackCard.js';
import { GatewayForecastCard } from './GatewayForecastCard.js';
import { GatewayKeyDetail } from './GatewayKeyDetail.js';
import { GatewayMixCard } from './GatewayMixCard.js';
import { GatewayMoversCard } from './GatewayMoversCard.js';
import { GatewayReliabilityCard } from './GatewayReliabilityCard.js';
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

/** The proxy retains 90 days of daily aggregates; the picker is clamped to match. */
const RETENTION_DAYS = 90;
const MS_PER_DAY = 86_400_000;

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

  const statusQuery = useGatewayStatus();
  const usageQuery = useGatewayData(range);
  const latestJobQuery = useLatestJob('gateway');

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
  const minIso = new Date(Date.now() - (RETENTION_DAYS - 1) * MS_PER_DAY).toISOString().slice(0, 10);
  const rangeDays = rangeDayCount(range);

  const { totals } = summary;

  // The dimension the user picked may carry no rows in a shorter range; fall
  // back to whatever the proxy did answer rather than showing an empty card.
  const activeDimension =
    summary.availableDimensions.includes(dimension) || summary.availableDimensions.length === 0
      ? dimension
      : (summary.availableDimensions[0] ?? dimension);

  // The prior window is measured off the *trimmed* spine, so it is exactly as
  // long as what is on screen — and it is only asked for when it is inside
  // retention, where an empty answer would mean "nothing spent" rather than
  // "never synced".
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
          onClick={sync.sync}
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
              {compactCount(totals.cacheReadTokens)} of {compactCount(totals.promptTokens + totals.cacheReadTokens)} input tokens served from cache
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

          <GatewayBudgetCard
            scopes={budgets.scopes}
            scope={budgetScope}
            onScope={setBudgetScope}
            loaded={!budgetsQuery.isPending}
          />

          <GatewayChargebackCard
            statement={statement}
            months={billMonths}
            onMonth={setBillMonth}
            onDimension={setBillDimension}
            available={billDimensions}
            loading={billQuery.isPending}
          />


          <div className={styles.chartRow}>
            <GatewayTrendCard title="Daily gateway spend" sub={rangeLabel(range)} chart={charts.spend} />
            <GatewayTrendCard title="Daily tokens" sub="input + output" chart={charts.tokens} />
          </div>

          <GatewayTrendCard title="Daily requests" sub="successes + failures" chart={charts.requests} />

          <GatewayAnomalyCard
            anomalies={anomalies}
            dimension={activeDimension}
            selectedDate={openAnomaly}
            onSelect={(date) => setSelectedDay((current) => (current === date ? null : date))}
            attribution={attribution}
          />

          <GatewayReliabilityCard summary={reliability} />

          {hasCacheActivity(cache) && <GatewayCacheCard summary={cache} />}

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
