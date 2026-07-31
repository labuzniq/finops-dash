import { SLOW_RESPONSE_ELEVATED_RATIO, SLOW_RESPONSE_TREND_MIN_DAYS } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, count, isoDateLabel } from '../../lib/format.js';
import { SLOW_RESPONSE_THRESHOLD_NOTE } from '../../lib/metrics/gatewaySlowResponses.js';
import {
  SLOW_RESPONSE_HISTORY_DAYS,
  hangBadgeReason,
} from '../../lib/metrics/gatewaySlowResponseHistory.js';
import type {
  HangHistoryRow,
  SlowResponseHistoryView,
} from '../../lib/metrics/gatewaySlowResponseHistory.js';
import { Card } from '../Card.js';
import styles from './GatewaySlowResponseHistoryCard.module.css';

/**
 * What the nightly hang sweeps did over the window.
 *
 * The card above this one reads `/model/metrics/slow_responses` for the days on
 * screen when somebody presses it, and it is a good answer to "how many calls
 * hung" and no answer at all to "is that the usual number". This one is the same
 * sweep kept — one row per alias per endpoint per UTC night — and it is the only
 * one of the page's four live reads that has a history, because it is the only
 * one whose payload may be added up across nights: disjoint request-log counts
 * beside their own denominator, where a mean of per-request ratios and a total
 * with no denominator cannot be accumulated into anything actionable.
 *
 * Four things the card must not do, all of them consequences of what is stored:
 *
 *  - **attach a duration to anything.** The proxy counts against its own
 *    `alerting_threshold` and never reports it. Sixty nights of counts against
 *    an invisible line is still a count against an invisible line.
 *  - **draw an unread night as a clean one.** Every strip here has three states.
 *    A sweep that did not run, one the proxy refused, and one that found
 *    `disable_spend_logs` set all leave the same absence of rows behind — and
 *    none of them is a night on which nothing hung.
 *  - **divide by gateway traffic.** Every share is of `total_count`, the route's
 *    own denominator, with cache hits excluded upstream.
 *  - **read a short recording as a flat trend.** Under
 *    {@link SLOW_RESPONSE_TREND_MIN_DAYS} observed nights the direction is
 *    withheld and the card says why, because "no change" would be a fact about
 *    the age of the recording.
 */

interface GatewaySlowResponseHistoryCardProps {
  view: SlowResponseHistoryView;
}

/** Longer than this and a deployment key is the row rather than a label in it. */
const MAX_KEY = 52;

function shorten(key: string): string {
  return key.length <= MAX_KEY ? key : `${key.slice(0, MAX_KEY - 1)}…`;
}

function share(value: number | null, decimals = 2): string {
  return value === null ? '—' : `${(value * 100).toFixed(decimals)}%`;
}

function signedPoints(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} pts`;
}

export function GatewaySlowResponseHistoryCard({ view }: GatewaySlowResponseHistoryCardProps) {
  const { trend } = view.summary;
  // Height is the night's pooled share; opacity is how much of the router
  // reported it. A night two of nine endpoints answered has a perfectly valid
  // share that describes almost nothing, and drawing it at full strength is the
  // same class of lie as drawing an unread night as clean.
  const worstShare = view.worstDay?.share ?? 0;
  const mostKeys = view.days.reduce((most, day) => (day.keys > most ? day.keys : most), 0);

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Hangs over time</div>
          <div className={styles.sub}>
            the same nightly sweep kept, one row per endpoint per alias per UTC night · the card
            above says how many calls hung over the days on screen, this says whether that is the
            usual number — pooled, because counts of request-log rows add across nights where the
            rates on the two cards above them do not
          </div>
        </div>
        <div className={styles.headline}>
          <div
            className={cx(
              styles.headlineValue,
              view.elevatedKeys > 0 && styles.warn,
              view.elevatedKeys === 0 && view.slow === 0 && styles.good,
            )}
          >
            {share(view.share)}
          </div>
          <div className={styles.headlineNote}>
            {count(view.slow)} of {compactCount(view.total)} requests, pooled over{' '}
            {view.daysRecorded} of the last {SLOW_RESPONSE_HISTORY_DAYS} nights
            {view.recordingSince !== null && <> · since {isoDateLabel(view.recordingSince)}</>}
          </div>
        </div>
      </div>

      {/*
        Not a footnote: with fewer observed nights than a split needs, the one
        statement this card adds over the live read cannot be made, and a card
        that simply drew no direction would read as "no change".
      */}
      {view.tooShort && (
        <div className={styles.warning}>
          <strong>Too short for a direction.</strong> A trend here needs{' '}
          {SLOW_RESPONSE_TREND_MIN_DAYS} observed nights so each half is three, and only{' '}
          {view.daysRecorded} night{view.daysRecorded === 1 ? ' carries' : 's carry'} a reading so
          far. There is no backfill for this — the sweep asks the proxy about one settled day and
          files what it answered — so the window fills in one night at a time.
        </div>
      )}

      <div className={styles.disclosure}>
        <span className={styles.flag}>no duration</span>
        Every count here is of requests that reached {SLOW_RESPONSE_THRESHOLD_NOTE}. Stacking sixty
        nights of them does not turn the count into seconds, and the same workload on another proxy
        would answer a different number.
      </div>

      <div className={styles.stats}>
        <Stat
          label="Trend"
          value={trend === null ? '—' : signedPoints(trend.deltaPoints)}
          sub={
            trend === null
              ? `withheld under ${SLOW_RESPONSE_TREND_MIN_DAYS} observed nights — a split of three against three is one busy afternoon against another`
              : `${share(trend.earlier.share)} over ${trend.earlier.days} night${trend.earlier.days === 1 ? '' : 's'} to ${isoDateLabel(trend.earlier.to)}, ${share(trend.recent.share)} over ${trend.recent.days} since · each half pooled, never a mean of nightly shares`
          }
          tone={trend === null ? undefined : trend.deltaPoints > 0 ? 'bad' : 'good'}
        />
        <Stat
          label="Materially worse"
          value={String(view.elevatedKeys)}
          sub={`both of the live card's gates over the pooled counts: measurably above the window rate and at or past ${SLOW_RESPONSE_ELEVATED_RATIO}× it · this card adds no threshold of its own`}
          tone={view.elevatedKeys > 0 ? 'warn' : undefined}
        />
        <Stat
          label="Worst night"
          value={view.worstDay === null ? '—' : share(view.worstDay.share)}
          sub={
            view.worstDay === null
              ? 'no observed night recorded a hang'
              : `${isoDateLabel(view.worstDay.date)} · ${count(view.worstDay.slow)} of ${compactCount(view.worstDay.total)} requests · ${view.worstDay.keys} endpoint${view.worstDay.keys === 1 ? '' : 's'} reported it`
          }
          tone={view.worstDay === null ? 'good' : undefined}
        />
        <Stat
          label="Nights recorded"
          value={`${view.daysRecorded}/${view.dates.length}`}
          sub={
            view.daysMissed === 0
              ? `every night of the drawn window carries a sweep · the window ends yesterday, because today has not settled`
              : `${view.daysMissed} night${view.daysMissed === 1 ? '' : 's'} filed none — a sync that did not run, a refused route or disable_spend_logs, never a night nothing hung`
          }
          tone={view.daysMissed === 0 ? 'good' : undefined}
        />
      </div>

      <div className={styles.strip}>
        {view.days.map((day) => (
          <div
            key={day.date}
            className={styles.slot}
            title={
              day.observed
                ? `${isoDateLabel(day.date)} · ${day.slow} of ${day.total} requests hung (${share(day.share)}) · ${day.keys} endpoint${day.keys === 1 ? '' : 's'}, ${day.models} alias${day.models === 1 ? '' : 'es'} swept`
                : `${isoDateLabel(day.date)} · no sweep filed`
            }
          >
            {day.observed ? (
              <div
                className={cx(styles.bar, (day.slow ?? 0) > 0 && styles.barBad)}
                style={{
                  height:
                    day.slow === 0 || worstShare === 0
                      ? '2px'
                      : `${Math.max(10, ((day.share ?? 0) / worstShare) * 100)}%`,
                  opacity: mostKeys === 0 ? 1 : Math.max(0.3, day.keys / mostKeys),
                }}
              />
            ) : (
              <div className={styles.hole} />
            )}
          </div>
        ))}
      </div>
      <div className={styles.stripAxis}>
        <span>{view.dates.length > 0 ? isoDateLabel(view.spineFrom) : ''}</span>
        <span className={styles.stripLegend}>
          hang share per night, faded by how many endpoints reported it · hatched is a night with no
          sweep
        </span>
        <span>{view.dates.length > 0 ? isoDateLabel(view.to) : ''}</span>
      </div>

      <div className={cx(styles.row, styles.headerStrip)}>
        <div>ENDPOINT</div>
        <div>NIGHTS</div>
        <div className={styles.right}>HANGS</div>
      </div>

      {view.rows.map((row) => (
        <EndpointRow key={row.key} row={row} windowShare={view.share} />
      ))}

      <div className={styles.footer}>
        One row per endpoint per alias per UTC night, appended by the full sync for the day usage has
        settled for — a backfill, a refused route, <code>disable_spend_logs</code> and a swallowed
        failure all file nothing, so a missing night is a night nobody read rather than a night
        nothing hung, and a total read off this table is a <strong>floor</strong>. Nights are pooled
        rather than averaged: the denominators differ by orders of magnitude, so a quiet Sunday's two
        hangs out of eight would otherwise outvote a Wednesday's forty out of ninety thousand. The
        badge is the live card's own two gates restated over the pooled counts — more evidence, not a
        different question — and nothing here feeds the digest at the top, because the finding it
        would raise is one this dashboard cannot put a number of seconds on.
      </div>
    </Card>
  );
}

function EndpointRow({
  row,
  windowShare,
}: {
  row: HangHistoryRow;
  windowShare: number | null;
}) {
  return (
    <div className={cx(styles.row, row.elevated && styles.rowBad)}>
      <div className={styles.name}>
        <span className={styles.key} title={row.key}>
          {row.isUnkeyed ? (
            <span className={styles.muted}>every endpoint without a URL</span>
          ) : (
            shorten(row.key)
          )}
        </span>
        <span className={styles.sublabel}>
          {row.elevated && <span className={cx(styles.badge, styles.badgeBad)}>hangs</span>}
          {row.isUnkeyed && (
            <span
              className={styles.badge}
              title="The proxy groups every deployment with no api_base into one bucket per alias — there is no endpoint here to attribute the hangs to"
            >
              unattributable
            </span>
          )}
          <span className={styles.backend} title={row.models.join(', ')}>
            {row.models.join(', ')}
          </span>
        </span>
      </div>

      <div className={styles.cellsColumn}>
        <div className={styles.cells}>
          {row.cells.map((cell) => (
            <span
              key={cell.date}
              className={cx(
                styles.cell,
                cell.state === 'clean' && styles.cellClean,
                cell.state === 'hangs' && styles.cellHangs,
                cell.state === 'unobserved' && styles.cellNone,
              )}
              title={
                cell.state === 'unobserved'
                  ? `${isoDateLabel(cell.date)} · no sweep`
                  : `${isoDateLabel(cell.date)} · ${cell.slow} of ${cell.total} requests (${share(cell.share)})`
              }
            />
          ))}
        </div>
        <div className={styles.note}>
          {row.daysWithHangs} of {row.daysObserved} observed night
          {row.daysObserved === 1 ? '' : 's'} recorded a hang
          {row.unobservedDays > 0 && <> · {row.unobservedDays} unread inside its own span</>}
          {row.worstDay !== null && (
            <>
              {' '}
              · worst {isoDateLabel(row.worstDay.date)} at {share(row.worstDay.share)}
            </>
          )}
          <span className={styles.reason}> · {hangBadgeReason(row, windowShare)}</span>
        </div>
      </div>

      <div className={styles.right}>
        {count(row.slow)}
        <span className={styles.share}>
          {share(row.share)} of {compactCount(row.total)}
          {row.ratioToGateway !== null && ` · ${row.ratioToGateway.toFixed(2)}×`}
        </span>
      </div>
    </div>
  );
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
  // absent case is spelled out rather than omitted.
  tone?: 'good' | 'warn' | 'bad' | undefined;
}) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div
        className={cx(
          styles.statValue,
          tone === 'bad' && styles.bad,
          tone === 'warn' && styles.warn,
          tone === 'good' && styles.good,
        )}
      >
        {value}
      </div>
      <div className={styles.statSub}>{sub}</div>
    </div>
  );
}
