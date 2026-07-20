import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { RANGE_DAYS, rangeDayCount } from '@dash/shared';
import type { DateRange } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, count, EMPTY, lastActiveLabel, rangeLabel, usd } from '../../lib/format.js';
import { buildChartGeometry, CHART_VIEWBOX } from '../../lib/metrics/chart.js';
import type { ChartGeometry } from '../../lib/metrics/chart.js';
import { ALL } from '../../lib/metrics/filter.js';
import { deriveTelemetry } from '../../lib/metrics/telemetry.js';
import type { TelemetryUserRow } from '../../lib/metrics/telemetry.js';
import { buildTokenChartGeometry } from '../../lib/metrics/tokenChart.js';
import { useTelemetryRollup } from '../../hooks/useTelemetry.js';
import { Card } from '../Card.js';
import { ChartHoverLayer } from '../ChartHoverLayer.js';
import { DateRangePicker } from '../DateRangePicker.js';
import { TokenLeaderboard } from './TokenLeaderboard.js';
import { TokenUsageChart } from './TokenUsageChart.js';
import styles from './ClaudeCodePage.module.css';

/**
 * Claude Code usage — the OTLP telemetry view. Everything below the filter
 * bar derives client-side from one rollup fetch, mirroring the Copilot page:
 * range re-slicing and the user/model filters never hit the API.
 */

const EMPTY_ROWS = [] as const;
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

function CostChart({ chart }: { chart: ChartGeometry }) {
  return (
    <Card>
      <div className={styles.chartHeader}>
        <div className={styles.chartTitle}>Daily cost</div>
      </div>
      <div className={styles.plot}>
        {chart.gridLines.map((line) => (
          <div key={line.topPercent} className={styles.gridLine} style={{ top: line.topPercent }}>
            <span className={styles.gridLabel}>{line.label}</span>
          </div>
        ))}
        <svg className={styles.svg} viewBox={CHART_VIEWBOX} preserveAspectRatio="none" aria-hidden>
          <path className={styles.area} d={chart.areaPath} />
          <path className={styles.line} d={chart.linePath} vectorEffect="non-scaling-stroke" />
        </svg>
        <ChartHoverLayer points={chart.hoverPoints} />
        <div className={styles.xLabels}>
          {chart.xLabels.map((label, index) => (
            // Dates can repeat across a short range, so pair them with position.
            <div key={`${label}-${index}`} className={styles.xLabel}>
              {label}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

/** Whole days since an ISO date, for the "2d ago" voice of the table. */
function daysSinceIso(iso: string | null): number | null {
  if (iso === null) return null;
  const [year, month, day] = iso.split('-');
  const then = new Date(Number(year), Number(month) - 1, Number(day));
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / MS_PER_DAY));
}

function UserRow({ row, hasPrData }: { row: TelemetryUserRow; hasPrData: boolean }) {
  return (
    <div className={cx(styles.columns, styles.row)}>
      <div className={styles.user}>{row.user}</div>
      <div className={styles.model}>{row.topModel ?? EMPTY}</div>
      <div className={styles.right}>{usd(row.costUsd, 2)}</div>
      <div className={styles.right}>{compactCount(row.tokens)}</div>
      <div className={styles.right}>{count(Math.round(row.sessions))}</div>
      <div className={cx(styles.right, styles.lines)}>
        <span className={styles.linesAdded}>+{compactCount(row.linesAdded)}</span>{' '}
        <span className={styles.linesRemoved}>−{compactCount(row.linesRemoved)}</span>
      </div>
      <div className={styles.right}>{count(Math.round(row.commits))}</div>
      <div className={styles.right}>{hasPrData ? count(Math.round(row.pullRequests)) : EMPTY}</div>
      <div className={styles.right}>{lastActiveLabel(daysSinceIso(row.lastActiveDate))}</div>
    </div>
  );
}

export function ClaudeCodePage() {
  const [range, setRange] = useState<DateRange>({ kind: 'preset', days: RANGE_DAYS[0] });
  const [user, setUser] = useState<string>(ALL);
  const [model, setModel] = useState<string>(ALL);

  // The rollup fetch reaches 90 days back; the picker is clamped to match.
  const maxIso = new Date().toISOString().slice(0, 10);
  const minIso = new Date(Date.now() - 89 * MS_PER_DAY).toISOString().slice(0, 10);
  const rangeDays = rangeDayCount(range);

  const rollupQuery = useTelemetryRollup();

  const summary = useMemo(
    () => deriveTelemetry(rollupQuery.data ?? EMPTY_ROWS, range, { user, model }),
    [rollupQuery.data, range, user, model],
  );
  const chart = useMemo(
    // Telemetry cost points carry no premium series, and daily API cost needs cents.
    () => buildChartGeometry(summary.points, { totalLabel: 'Cost', premiumLabel: null, decimals: 2 }),
    [summary.points],
  );
  const tokenCharts = useMemo(
    () => ({
      total: buildTokenChartGeometry(summary.dailyTokens, 'total'),
      input: buildTokenChartGeometry(summary.dailyTokens, 'input'),
      output: buildTokenChartGeometry(summary.dailyTokens, 'output'),
      cache: buildTokenChartGeometry(summary.dailyTokens, 'cache'),
    }),
    [summary.dailyTokens],
  );

  const hasAnyData = (rollupQuery.data?.length ?? 0) > 0;

  return (
    <>
      <div className={styles.header}>
        <div className={styles.title}>Claude Code usage</div>
        <div className={styles.sub}>OTLP telemetry · self-hosted ingest</div>
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
            onApply={(from, to) => setRange({ kind: 'custom', from, to })}
          />
        </div>

        <select
          className={styles.select}
          value={user}
          aria-label="Filter by user"
          onChange={(event) => setUser(event.target.value)}
        >
          <option value={ALL}>All users</option>
          {summary.userOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

        <select
          className={styles.select}
          value={model}
          aria-label="Filter by model"
          onChange={(event) => setModel(event.target.value)}
        >
          <option value={ALL}>All models</option>
          {summary.modelOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

        <div className={styles.spacer} />
        <div className={styles.ingestNote}>OTLP/HTTP · POST /v1/metrics · json</div>
      </div>

      {rollupQuery.error && (
        <div className={cx(styles.status, styles.error)}>
          Could not load telemetry: {rollupQuery.error.message}
        </div>
      )}

      {!rollupQuery.error && rollupQuery.isPending && (
        <div className={styles.status}>Loading telemetry…</div>
      )}

      {!rollupQuery.error && !rollupQuery.isPending && !hasAnyData && (
        <div className={styles.status}>
          No telemetry yet. Point Claude Code at this dashboard:{' '}
          <span className={styles.hint}>
            CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp
            OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4000
          </span>
        </div>
      )}

      {!rollupQuery.error && !rollupQuery.isPending && hasAnyData && (
        <>
          <div className={styles.kpiRow}>
            <KpiCard kicker={`TOTAL COST · ${rangeDays}d`} value={usd(summary.totalCostUsd, 2)}>
              API-equivalent spend reported by clients
            </KpiCard>
            <KpiCard kicker="TOKENS" value={compactCount(summary.totalTokens)}>
              input + output + cache
            </KpiCard>
            <KpiCard kicker="SESSIONS" value={count(Math.round(summary.sessions))}>
              CLI sessions started in range
            </KpiCard>
            <KpiCard kicker="ACTIVE USERS" value={count(summary.activeUsers)}>
              distinct users reporting telemetry
            </KpiCard>
          </div>

          <div className={styles.kpiRowOutput}>
            <KpiCard
              kicker={`LINES OF CODE · ${rangeDays}d`}
              value={
                summary.totals.linesAdded === null && summary.totals.linesRemoved === null ? (
                  EMPTY
                ) : (
                  <>
                    <span className={styles.linesAdded}>+{compactCount(summary.totals.linesAdded ?? 0)}</span>{' '}
                    <span className={styles.linesRemoved}>−{compactCount(summary.totals.linesRemoved ?? 0)}</span>
                  </>
                )
              }
            >
              added / removed by Claude Code
            </KpiCard>
            <KpiCard
              kicker={`COMMITS · ${rangeDays}d`}
              value={summary.totals.commits === null ? EMPTY : count(Math.round(summary.totals.commits))}
            >
              commits created via Claude Code
            </KpiCard>
            <KpiCard
              kicker={`PULL REQUESTS · ${rangeDays}d`}
              value={summary.totals.pullRequests === null ? EMPTY : count(Math.round(summary.totals.pullRequests))}
            >
              PRs opened via Claude Code
            </KpiCard>
          </div>

          <div className={styles.chartRow}>
            <CostChart chart={chart} />
            <TokenUsageChart title="Daily tokens" geometry={tokenCharts.total} />
          </div>

          <div className={styles.tokenKindRow}>
            <TokenUsageChart title="Input tokens" geometry={tokenCharts.input} small />
            <TokenUsageChart title="Output tokens" geometry={tokenCharts.output} small />
            <TokenUsageChart title="Cache tokens" geometry={tokenCharts.cache} small />
          </div>

          <TokenLeaderboard rows={summary.topUsersByTokens} />

          <Card padded={false} className={styles.tableCard}>
            <div className={styles.tableHeader}>
              <div className={styles.tableTitle}>Per-user usage</div>
              <div className={styles.tableSub}>cost, tokens and activity · {rangeLabel(range)}</div>
            </div>

            <div className={cx(styles.columns, styles.headerStrip)}>
              <div>USER</div>
              <div>TOP MODEL</div>
              <div className={styles.right}>COST</div>
              <div className={styles.right}>TOKENS</div>
              <div className={styles.right}>SESSIONS</div>
              <div className={styles.right}>LINES</div>
              <div className={styles.right}>COMMITS</div>
              <div className={styles.right}>PRS</div>
              <div className={styles.right}>LAST ACTIVE</div>
            </div>

            {summary.users.length === 0 ? (
              <div className={styles.empty}>No activity matches these filters.</div>
            ) : (
              summary.users.map((row) => (
                <UserRow key={row.user} row={row} hasPrData={summary.totals.pullRequests !== null} />
              ))
            )}
          </Card>
        </>
      )}
    </>
  );
}
