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
import type { DateRange, GatewayDimension } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, count, EMPTY, percent, rangeLabel, relativeTime, usd } from '../../lib/format.js';
import { breakdownDailySeries, deriveGateway } from '../../lib/metrics/gateway.js';
import { buildGatewayChartGeometry } from '../../lib/metrics/gatewayChart.js';
import { useGatewayData, useGatewayStatus } from '../../hooks/useGatewayData.js';
import { useLatestJob } from '../../hooks/useCopilotData.js';
import type { UseSyncJob } from '../../hooks/useCopilotData.js';
import { spendRangeBounds } from '../../hooks/useSpendData.js';
import { Card } from '../Card.js';
import { DateRangePicker } from '../DateRangePicker.js';
import { GatewayBreakdownCard } from './GatewayBreakdownCard.js';
import { GatewayKeyDetail } from './GatewayKeyDetail.js';
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

function KpiCard({ kicker, value, children }: { kicker: string; value: ReactNode; children: ReactNode }) {
  return (
    <Card padded={false} className={styles.kpiCard}>
      <div className={styles.kicker}>{kicker}</div>
      <div className={styles.kpiValue}>{value}</div>
      <div className={styles.kpiSub}>{children}</div>
    </Card>
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
  const configured = statusQuery.data?.configured ?? false;
  const source = statusQuery.data?.source ?? 'off';
  const latestJob = latestJobQuery.data ?? null;
  const hasData = totals.requests > 0 || totals.spend > 0;

  // The dimension the user picked may carry no rows in a shorter range; fall
  // back to whatever the proxy did answer rather than showing an empty card.
  const activeDimension =
    summary.availableDimensions.includes(dimension) || summary.availableDimensions.length === 0
      ? dimension
      : (summary.availableDimensions[0] ?? dimension);

  // Resolving the selection against the *current* rows is what makes switching
  // dimension or shortening the range close the drill-down by itself: a key
  // that is no longer ranked simply stops resolving, and nothing stale renders.
  const selectedRow =
    summary.breakdowns[activeDimension].find((row) => row.key === selectedKey) ?? null;

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
          <div className={styles.kpiRow}>
            <KpiCard kicker={`GATEWAY SPEND · ${rangeDays}d`} value={usd(totals.spend, 2)}>
              per-token cost across every provider
            </KpiCard>
            <KpiCard kicker="REQUESTS" value={compactCount(totals.requests)}>
              {optionalRate(successRate(totals))} succeeded
            </KpiCard>
            <KpiCard kicker="TOKENS" value={compactCount(totals.totalTokens)}>
              {compactCount(totals.promptTokens)} in · {compactCount(totals.completionTokens)} out
            </KpiCard>
            <KpiCard
              kicker="COST PER 1M TOKENS"
              value={
                costPerMillionTokens(totals) === null
                  ? EMPTY
                  : usd(costPerMillionTokens(totals) ?? 0, 2)
              }
            >
              blended across models and providers
            </KpiCard>
          </div>

          <div className={styles.kpiRowSecondary}>
            <KpiCard kicker="PROMPT CACHE HIT RATE" value={optionalRate(cacheHitRate(totals))}>
              {compactCount(totals.cacheReadTokens)} of {compactCount(totals.promptTokens + totals.cacheReadTokens)} input tokens served from cache
            </KpiCard>
            <KpiCard
              kicker="COST PER REQUEST"
              value={costPerRequest(totals) === null ? EMPTY : usd(costPerRequest(totals) ?? 0, 4)}
            >
              average across the range
            </KpiCard>
            <KpiCard kicker="FAILED REQUESTS" value={count(totals.failedRequests)}>
              {totals.requests === 0
                ? EMPTY
                : `${percent((totals.failedRequests / totals.requests) * 100)} of all calls`}
            </KpiCard>
          </div>

          <div className={styles.chartRow}>
            <GatewayTrendCard title="Daily gateway spend" sub={rangeLabel(range)} chart={charts.spend} />
            <GatewayTrendCard title="Daily tokens" sub="input + output" chart={charts.tokens} />
          </div>

          <GatewayTrendCard title="Daily requests" sub="successes + failures" chart={charts.requests} />

          <GatewayBreakdownCard
            rows={summary.breakdowns[activeDimension]}
            dimension={activeDimension}
            available={summary.availableDimensions}
            onDimension={setDimension}
            selectedKey={selectedRow?.key ?? null}
            onSelect={(key) => setSelectedKey((current) => (current === key ? null : key))}
          />

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
