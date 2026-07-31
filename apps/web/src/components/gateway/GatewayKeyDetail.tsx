import { useMemo, useState } from 'react';
import {
  cacheHitRate,
  costPerMillionTokens,
  costPerRequest,
  GATEWAY_DIMENSION_LABELS,
  successRate,
} from '@dash/shared';
import type { GatewayDailyPoint, GatewayDimension } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, count, EMPTY, percent, usd } from '../../lib/format.js';
import type { GatewayBreakdownRow } from '../../lib/metrics/gateway.js';
import { buildGatewayChartGeometry } from '../../lib/metrics/gatewayChart.js';
import type { GatewaySeries } from '../../lib/metrics/gatewayChart.js';
import { GatewayTrendCard } from './GatewayTrendCard.js';
import styles from './GatewayKeyDetail.module.css';

/**
 * One breakdown key, opened up: its own daily trend and its own unit
 * economics, over the same range and the same axis as the totals above.
 *
 * This is the question the ranked table always provokes — "gpt-4o is 41% of
 * the bill, but is it climbing?" — and it needs no extra fetch: the payload
 * already carries every breakdown row per day, so the whole panel is a
 * derivation. Cross-dimension drill-down (this team's model mix) is *not*
 * possible from LiteLLM's daily aggregates; each dimension is reported
 * independently, with no joint key. Showing it would mean inventing it.
 *
 * The rates here are the ones that only make sense per key: a blended
 * $/1M across the gateway says little, but $/1M for one model is that model's
 * effective price, and its cache-hit rate is the lever someone can actually
 * pull.
 */

const SERIES_OPTIONS: ReadonlyArray<{ series: GatewaySeries; label: string }> = [
  { series: 'spend', label: 'Spend' },
  { series: 'totalTokens', label: 'Tokens' },
  { series: 'requests', label: 'Requests' },
];

/** Percentages that are only meaningful when something happened. */
function optionalRate(value: number | null): string {
  return value === null ? EMPTY : `${value.toFixed(1)}%`;
}

function Stat({ kicker, value, sub }: { kicker: string; value: string; sub: string }) {
  return (
    <div className={styles.stat}>
      <div className={styles.kicker}>{kicker}</div>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statSub}>{sub}</div>
    </div>
  );
}

interface GatewayKeyDetailProps {
  dimension: GatewayDimension;
  row: GatewayBreakdownRow;
  /** The key's series, already aligned to the page's trimmed spine. */
  daily: readonly GatewayDailyPoint[];
  /** Caption for the chart — the same range label the totals carry. */
  rangeLabel: string;
  onClose: () => void;
}

export function GatewayKeyDetail({
  dimension,
  row,
  daily,
  rangeLabel,
  onClose,
}: GatewayKeyDetailProps) {
  const [series, setSeries] = useState<GatewaySeries>('spend');
  const chart = useMemo(() => buildGatewayChartGeometry(daily, series), [daily, series]);

  const { metrics } = row;
  const perMillion = costPerMillionTokens(metrics);
  const perRequest = costPerRequest(metrics);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.identity}>
          <div className={styles.kicker}>{GATEWAY_DIMENSION_LABELS[dimension].toUpperCase()}</div>
          <div className={styles.key} title={row.key}>
            {row.key}
          </div>
          <div className={styles.label}>
            {row.label !== null && row.label !== row.key ? `${row.label} · ` : ''}
            {row.share === 0 ? EMPTY : percent(row.share * 100)} of gateway spend
          </div>
        </div>

        <div className={styles.controls}>
          <div className={styles.segmented} role="group" aria-label="Series">
            {SERIES_OPTIONS.map((option) => {
              const active = option.series === series;
              return (
                <button
                  key={option.series}
                  type="button"
                  className={cx(styles.segment, active && styles.segmentActive)}
                  aria-pressed={active}
                  onClick={() => setSeries(option.series)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <button type="button" className={styles.close} onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <div className={styles.statRow}>
        <Stat
          kicker="SPEND"
          value={usd(metrics.spend, 2)}
          sub={`${count(metrics.requests)} requests`}
        />
        <Stat
          kicker="COST PER 1M TOKENS"
          value={perMillion === null ? EMPTY : usd(perMillion, 2)}
          sub="this key's effective price"
        />
        <Stat
          kicker="COST PER REQUEST"
          value={perRequest === null ? EMPTY : usd(perRequest, 4)}
          sub="average across the range"
        />
        <Stat
          kicker="TOKENS"
          value={compactCount(metrics.totalTokens)}
          sub={`${compactCount(metrics.promptTokens)} in · ${compactCount(metrics.completionTokens)} out`}
        />
        <Stat
          kicker="PROMPT CACHE HIT RATE"
          value={optionalRate(cacheHitRate(metrics))}
          sub={`${compactCount(metrics.cacheReadTokens)} tokens from cache`}
        />
        <Stat
          kicker="SUCCESS RATE"
          value={optionalRate(successRate(metrics))}
          sub={`${count(metrics.failedRequests)} failed`}
        />
      </div>

      <GatewayTrendCard
        title={`Daily ${SERIES_OPTIONS.find((option) => option.series === series)?.label.toLowerCase() ?? 'spend'} · ${row.key}`}
        sub={rangeLabel}
        chart={chart}
      />
    </div>
  );
}
