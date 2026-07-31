import { GATEWAY_DIMENSION_LABELS } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, EMPTY, percent, usd } from '../../lib/format.js';
import { downloadChargebackCsv } from '../../lib/exportCsv.js';
import {
  CHARGEBACK_DIMENSIONS,
  monthLabel,
  shortMonthLabel,
} from '../../lib/metrics/gatewayChargeback.js';
import type {
  ChargebackDimension,
  ChargebackStatement,
  MonthKey,
} from '../../lib/metrics/gatewayChargeback.js';
import { Card } from '../Card.js';
import styles from './GatewayChargebackCard.module.css';

/**
 * The month's bill, split across the units that will pay it.
 *
 * The one card on this page that is a *statement* rather than an analysis, and
 * the only one built to be read outside the dashboard. Three things follow
 * from that and are visible in the markup:
 *
 * - Every line is shown, with no top-N cap. A department missing from its own
 *   statement is a bug in a way a department missing from a ranked table is
 *   not.
 * - The unallocated remainder is a row of the table, in its own hue, so the
 *   column adds up to the gateway total on screen exactly as it does in the
 *   exported file.
 * - The period is a month, picked here, and independent of the page's range
 *   picker — with a month in flight labelled as a preview rather than quietly
 *   presented as a bill.
 */

/** Length of the `--chart-N` ramp in tokens.css; rows past it cycle. */
const CHART_HUES = 8;

interface GatewayChargebackCardProps {
  statement: ChargebackStatement;
  /** Months inside the proxy's retention, newest first. */
  months: readonly MonthKey[];
  onMonth: (month: MonthKey) => void;
  onDimension: (dimension: ChargebackDimension) => void;
  /** The dimensions the proxy actually answered for this window. */
  available: readonly ChargebackDimension[];
  loading: boolean;
}

export function GatewayChargebackCard({
  statement,
  months,
  onMonth,
  onDimension,
  available,
  loading,
}: GatewayChargebackCardProps) {
  const dimensionLabel = GATEWAY_DIMENSION_LABELS[statement.dimension];
  const max = statement.lines.reduce((peak, line) => Math.max(peak, line.metrics.spend), 0);
  const unallocatedShare =
    statement.total.spend > 0 ? statement.unallocated.spend / statement.total.spend : 0;
  const monthDelta =
    statement.priorTotalSpend !== null && statement.priorTotalSpend > 0
      ? (statement.total.spend - statement.priorTotalSpend) / statement.priorTotalSpend
      : null;
  // Named once, here and in the column head: a partial month is compared
  // against the same days of the month before it, so the header has to say so
  // or the reader will assume a whole month.
  const priorScope =
    statement.priorPartial && statement.through !== null
      ? `first ${Number(statement.through.slice(8, 10))} days of ${shortMonthLabel(statement.priorMonth)}`
      : shortMonthLabel(statement.priorMonth);

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Chargeback statement</div>
          <div className={styles.sub}>
            {monthLabel(statement.month)} ·{' '}
            {statement.complete
              ? 'complete month'
              : `in progress — reported through ${statement.through ?? 'no day yet'}`}{' '}
            · billed by {dimensionLabel.toLowerCase()}
          </div>
        </div>

        <div className={styles.controls}>
          <div className={styles.segmented} role="group" aria-label="Billing month">
            {months.map((month) => {
              const active = month === statement.month;
              return (
                <button
                  key={month}
                  type="button"
                  className={cx(styles.segment, active && styles.segmentActive)}
                  aria-pressed={active}
                  onClick={() => onMonth(month)}
                >
                  {shortMonthLabel(month)}
                </button>
              );
            })}
          </div>

          <div className={styles.segmented} role="group" aria-label="Billed by">
            {CHARGEBACK_DIMENSIONS.filter((option) => available.includes(option)).map((option) => {
              const active = option === statement.dimension;
              return (
                <button
                  key={option}
                  type="button"
                  className={cx(styles.segment, active && styles.segmentActive)}
                  aria-pressed={active}
                  onClick={() => onDimension(option)}
                >
                  {GATEWAY_DIMENSION_LABELS[option]}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            className={styles.export}
            disabled={statement.total.spend === 0}
            onClick={() => downloadChargebackCsv(statement)}
          >
            Export CSV
          </button>
        </div>
      </div>

      <div className={styles.summary}>
        <div className={styles.stat}>
          <div className={styles.statLabel}>GATEWAY SPEND</div>
          <div className={styles.statValue}>{usd(statement.total.spend, 2)}</div>
          <div className={styles.statNote}>
            {monthDelta === null
              ? statement.priorTotalSpend === null
                ? 'prior month outside retention'
                : 'no prior-month spend'
              : `${monthDelta >= 0 ? '+' : '−'}${Math.abs(monthDelta * 100).toFixed(1)}% vs ${priorScope}`}
          </div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>ALLOCATED</div>
          <div className={styles.statValue}>{usd(statement.allocated.spend, 2)}</div>
          <div className={styles.statNote}>
            {percent(statement.coverage * 100)} of the month carries a{' '}
            {dimensionLabel.toLowerCase()}
          </div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>UNALLOCATED</div>
          <div className={cx(styles.statValue, unallocatedShare > 0.05 && styles.warn)}>
            {usd(statement.unallocated.spend, 2)}
          </div>
          <div className={styles.statNote}>
            {unallocatedShare === 0
              ? 'every dollar is attributed'
              : 'shown as its own line — never spread across the others'}
          </div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>LINES</div>
          <div className={styles.statValue}>{statement.lines.length}</div>
          <div className={styles.statNote}>
            {statement.reportedDays} day{statement.reportedDays === 1 ? '' : 's'} reported
          </div>
        </div>
      </div>

      {!statement.reconciles && (
        <div className={styles.alert}>
          The {dimensionLabel.toLowerCase()} rows attribute more than the gateway reported for this
          month. The statement is not billable until that is resolved on the proxy.
        </div>
      )}

      <div className={cx(styles.row, styles.headerStrip)}>
        <div>{dimensionLabel.toUpperCase()}</div>
        <div />
        <div className={styles.right}>SPEND</div>
        <div className={styles.right}>SHARE</div>
        <div className={styles.right}>TOKENS</div>
        <div className={styles.right}>$/1M</div>
        <div className={styles.right}>{priorScope.toUpperCase()}</div>
      </div>

      {loading ? (
        <div className={styles.empty}>Loading {monthLabel(statement.month)}…</div>
      ) : statement.total.spend === 0 ? (
        <div className={styles.empty}>
          The gateway reported no spend in {monthLabel(statement.month)}.
        </div>
      ) : (
        <>
          {statement.lines.map((line, index) => (
            <div
              key={line.key}
              className={styles.row}
              style={{ ['--row-color' as string]: `var(--chart-${(index % CHART_HUES) + 1})` }}
            >
              <div className={styles.name} title={line.key}>
                <span className={styles.key}>{line.key}</span>
                {line.label !== null && line.label !== line.key && (
                  <span className={styles.label}>{line.label}</span>
                )}
              </div>

              <div className={styles.track}>
                <div
                  className={styles.fill}
                  style={{ width: max > 0 ? `${(line.metrics.spend / max) * 100}%` : '0%' }}
                />
              </div>

              <div className={styles.right}>{usd(line.metrics.spend, 2)}</div>
              <div className={cx(styles.right, styles.muted)}>
                {line.share === 0 ? EMPTY : percent(line.share * 100)}
              </div>
              <div className={cx(styles.right, styles.muted)}>
                {compactCount(line.metrics.totalTokens)}
              </div>
              <div className={cx(styles.right, styles.muted)}>
                {line.costPerMillion === null ? EMPTY : usd(line.costPerMillion, 2)}
              </div>
              <div className={styles.right}>
                {line.priorSpend === null ? (
                  <span className={styles.muted}>{EMPTY}</span>
                ) : (
                  <>
                    <span className={styles.muted}>{usd(line.priorSpend, 2)}</span>
                    {line.change !== null && (
                      <span
                        className={cx(styles.change, line.change > 0 ? styles.up : styles.down)}
                      >
                        {line.change > 0 ? '+' : '−'}
                        {Math.abs(line.change * 100).toFixed(0)}%
                      </span>
                    )}
                    {line.change === null && line.metrics.spend > 0 && (
                      <span className={cx(styles.change, styles.up)}>new</span>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}

          {/* Always drawn, including at zero: the column on screen must add up
              to the gateway total exactly as the exported file does. */}
          <div className={cx(styles.row, styles.remainder)}>
            <div className={styles.name}>
              <span className={styles.key}>unallocated</span>
              <span className={styles.label}>
                no {dimensionLabel.toLowerCase()} attributed by the proxy
              </span>
            </div>
            <div className={styles.track}>
              <div
                className={cx(styles.fill, styles.remainderFill)}
                style={{ width: max > 0 ? `${(statement.unallocated.spend / max) * 100}%` : '0%' }}
              />
            </div>
            <div className={styles.right}>{usd(statement.unallocated.spend, 2)}</div>
            <div className={cx(styles.right, styles.muted)}>
              {unallocatedShare === 0 ? EMPTY : percent(unallocatedShare * 100)}
            </div>
            <div className={cx(styles.right, styles.muted)}>
              {compactCount(statement.unallocated.totalTokens)}
            </div>
            <div className={cx(styles.right, styles.muted)}>{EMPTY}</div>
            <div className={cx(styles.right, styles.muted)}>{EMPTY}</div>
          </div>
        </>
      )}

      <div className={styles.footer}>
        Lines plus the remainder equal the month's gateway spend, which is what makes this
        billable. The dimensions overlap, so a month is billed by exactly one of them — never add a
        team statement to a tag statement.
        {!statement.complete &&
          ' This month is still running: the figures are a preview, not an invoice.'}
      </div>
    </Card>
  );
}
