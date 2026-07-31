import { cx } from '../../lib/cx.js';
import { compactCount, EMPTY, relativeTime, usd, usdCompact } from '../../lib/format.js';
import { ledgerPeak, MAX_LEDGER_MONTHS } from '../../lib/metrics/gatewayHistory.js';
import type { GatewayLedger, LedgerMonth } from '../../lib/metrics/gatewayHistory.js';
import { Card } from '../Card.js';
import styles from './GatewayHistoryCard.module.css';

/**
 * What the gateway has cost, month by month, for as long as this database has
 * been sealing months.
 *
 * Every other card on this page is bounded by the range picker, and the range
 * picker is bounded by what `gateway_daily` still holds — which LiteLLM prunes
 * at 90 days. This one reads `gateway_month` instead, so it answers the question
 * a budget conversation actually opens with ("what were we spending in March")
 * long after March's days have gone.
 *
 * Two things it must not do:
 *
 *  - **draw an unsealed month as a cheap one.** A month with no statement is a
 *    hole — the month had a gap in it when it closed, or this dashboard was not
 *    running yet, and neither is distinguishable from here. It gets a marked
 *    slot in the strip and a named row in the table, never a short bar.
 *  - **re-add the days to check itself.** The seal is the record. Where the daily
 *    rows still exist, the comparison is `sealDrift` on the statement card above;
 *    doing it again here would give a reader two histories and no way to choose.
 */

interface GatewayHistoryCardProps {
  ledger: GatewayLedger;
}

const ORIGIN_LABEL = { scheduler: 'at month close', manual: 'by hand' } as const;

export function GatewayHistoryCard({ ledger }: GatewayHistoryCardProps) {
  const peak = ledgerPeak(ledger);
  const oldestFirst = [...ledger.months].reverse();
  const latest = ledger.months.find((row) => row.sealed) ?? null;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Monthly ledger</div>
          <div className={styles.sub}>
            one row per <em>sealed</em> month — the statement taken when the month closed, kept
            whether or not the proxy can still reproduce it · this is the only card here that is not
            bounded by the range picker, because it reads the record rather than the days
          </div>
        </div>
        <div className={styles.headline}>
          <div className={styles.headlineValue}>{usd(ledger.totalSpend, 0)}</div>
          <div className={styles.headlineNote}>
            across {ledger.sealedCount} sealed month{ledger.sealedCount === 1 ? '' : 's'}
            {ledger.from !== null && ledger.to !== null && (
              <>
                {' '}
                ({ledger.from}
                {ledger.to === ledger.from ? '' : ` … ${ledger.to}`})
              </>
            )}
            {ledger.unsealedCount > 0 && (
              <span className={styles.warnNote}>
                {' '}
                · {ledger.unsealedCount} closed month{ledger.unsealedCount === 1 ? '' : 's'} in this
                span carry no statement and are not in that total
              </span>
            )}
          </div>
        </div>
      </div>

      <div className={styles.stats}>
        <Stat
          label="Average month"
          value={ledger.meanMonthlySpend === null ? EMPTY : usd(ledger.meanMonthlySpend, 0)}
          sub={
            ledger.sealedCount < 2
              ? 'one month sealed so far — a mean of one is that month'
              : `over the ${ledger.sealedCount} months that were sealed, unsealed ones excluded rather than counted as zero`
          }
        />
        <Stat
          label="Latest sealed"
          value={latest === null || latest.total === null ? EMPTY : usd(latest.total.spend, 0)}
          sub={
            latest === null
              ? 'nothing sealed yet'
              : latest.spendPercent === null
                ? `${latest.month} · no statement for the month before it, so there is nothing to compare against`
                : `${latest.month} · ${signed(latest.spendPercent)} against ${latest.comparedWith}`
          }
          tone={
            latest?.spendPercent === null || latest?.spendPercent === undefined
              ? undefined
              : latest.spendPercent > 0
                ? 'bad'
                : 'good'
          }
        />
        <Stat
          label="Trend"
          value={
            ledger.trend === null ? EMPTY : `${signed(ledger.trend.percentPerMonth)}${' '}/mo`
          }
          sub={
            ledger.trend === null
              ? 'two consecutive sealed months are needed before a direction means anything'
              : `compounded across ${ledger.trend.months} unbroken months (${ledger.trend.from} … ${ledger.trend.to}) — a run that jumped a hole would not be one`
          }
          tone={
            ledger.trend === null || ledger.trend.direction === 'flat'
              ? undefined
              : ledger.trend.direction === 'rising'
                ? 'bad'
                : 'good'
          }
        />
        <Stat
          label="Only we hold"
          value={ledger.beyondRetentionCount === 0 ? 'none' : String(ledger.beyondRetentionCount)}
          sub={
            ledger.beyondRetentionCount === 0
              ? 'every sealed month is still inside the proxy’s 90-day window, so it could be re-derived'
              : 'sealed months whose days LiteLLM has since pruned — these totals exist nowhere else'
          }
        />
      </div>

      {/*
        Oldest on the left so the strip reads as time, while the table below is
        newest-first the way a ledger is read. An unsealed month is a marked slot
        rather than a zero-height bar: the two are drawn identically otherwise,
        and they mean opposite things.
      */}
      <div className={styles.strip}>
        {oldestFirst.map((row) => (
          <div key={row.month} className={styles.slot} title={tooltip(row)}>
            <div className={styles.bar}>
              {row.sealed && row.total !== null ? (
                <div
                  className={cx(styles.fill, !row.reproducible && styles.fillArchive)}
                  style={{ height: `${peak === 0 ? 0 : (row.total.spend / peak) * 100}%` }}
                />
              ) : (
                <div className={styles.hole} />
              )}
            </div>
            <div className={cx(styles.slotLabel, !row.sealed && styles.slotLabelMuted)}>
              {row.month.slice(5)}
            </div>
          </div>
        ))}
      </div>

      <div className={cx(styles.row, styles.headerStrip)}>
        <div>MONTH</div>
        <div className={styles.right}>SPEND</div>
        <div className={styles.right}>VS PREVIOUS</div>
        <div className={styles.right}>TOKENS · CALLS</div>
        <div className={styles.right}>$/1M</div>
      </div>

      {ledger.months.map((row) => (
        <div key={row.month} className={cx(styles.row, !row.sealed && styles.rowHole)}>
          <div className={styles.name}>
            <span className={styles.key}>{row.month}</span>
            <span className={styles.sublabel}>
              {row.sealed ? (
                <>
                  {row.revision !== null && row.revision > 1 && (
                    <span className={cx(styles.badge, styles.badgeWarn)}>rev {row.revision}</span>
                  )}
                  {!row.reproducible && <span className={styles.badge}>archive</span>}
                  {row.sealedAt !== null && row.sealedBy !== null && (
                    <>
                      sealed {relativeTime(row.sealedAt)} {ORIGIN_LABEL[row.sealedBy]}
                    </>
                  )}
                </>
              ) : (
                <span className={styles.muted}>
                  no statement — the month closed with a gap in it, or this dashboard was not
                  running yet
                </span>
              )}
            </span>
          </div>

          <div className={styles.right}>
            {row.total === null ? (
              <span className={styles.muted}>{EMPTY}</span>
            ) : (
              usd(row.total.spend, 2)
            )}
          </div>

          <div className={styles.right}>
            {row.spendDelta === null || row.spendPercent === null ? (
              <span className={styles.muted}>{EMPTY}</span>
            ) : (
              <>
                <span className={cx(row.spendDelta > 0 ? styles.bad : styles.good)}>
                  {signed(row.spendPercent)}
                </span>
                <span className={styles.share}>
                  {row.spendDelta > 0 ? '+' : '−'}
                  {usdCompact(Math.abs(row.spendDelta))} vs {row.comparedWith}
                </span>
              </>
            )}
          </div>

          <div className={styles.right}>
            {row.total === null ? (
              <span className={styles.muted}>{EMPTY}</span>
            ) : (
              <>
                {compactCount(row.total.totalTokens)}
                <span className={styles.share}>{compactCount(row.total.requests)} calls</span>
              </>
            )}
          </div>

          <div className={styles.right}>
            {row.costPerMillion === null ? (
              <span className={styles.muted}>{EMPTY}</span>
            ) : (
              usd(row.costPerMillion, 2)
            )}
          </div>
        </div>
      ))}

      <div className={styles.footer}>
        A month is sealed once every one of its days is stored, so a total here is the whole month
        or nothing — there is no short bill. {ledger.revisedCount > 0 && (
          <>
            {ledger.revisedCount} month{ledger.revisedCount === 1 ? ' has' : 's have'} been re-issued
            since; the ledger shows the current statement, and the chain of superseded ones is on the
            statement card above.{' '}
          </>
        )}
        {ledger.truncated > 0 && (
          <>
            {ledger.truncated} sealed month{ledger.truncated === 1 ? '' : 's'} older than the last{' '}
            {MAX_LEDGER_MONTHS} are held but not drawn here, and the totals above are over the
            months shown.{' '}
          </>
        )}
        Months are the one axis on this page that may be added together: the breakdown dimensions
        overlap and budget counters run on their own periods, but calendar months are disjoint spans
        of the same gateway.
      </div>
    </Card>
  );
}

/** A signed percentage, in the voice the movers and comparison notes use. */
function signed(value: number): string {
  const rounded = Math.abs(value) >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${rounded.replace('-', '')}%`;
}

function tooltip(row: LedgerMonth): string {
  if (row.total === null) return `${row.month} — not sealed`;
  return `${row.month} — ${usd(row.total.spend, 2)} over ${row.days ?? 0} days`;
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  // `exactOptionalPropertyTypes` is on and every tone here is computed, so the
  // absent case has to be spelled out rather than omitted.
  tone?: 'good' | 'bad' | undefined;
}) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={cx(styles.statValue, tone === 'bad' && styles.bad, tone === 'good' && styles.good)}>
        {value}
      </div>
      <div className={styles.statSub}>{sub}</div>
    </div>
  );
}
