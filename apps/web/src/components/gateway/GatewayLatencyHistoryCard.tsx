import { LATENCY_ELEVATED_RATIO, LATENCY_MIN_DAYS, LATENCY_TREND_MIN_DAYS } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { isoDateLabel } from '../../lib/format.js';
import {
  LATENCY_HISTORY_DAYS,
  latencyHistoryBadgeReason,
  latencyTrendReason,
} from '../../lib/metrics/gatewayLatencyHistory.js';
import type {
  LatencyHistoryRow,
  LatencyHistoryView,
} from '../../lib/metrics/gatewayLatencyHistory.js';
import { Card } from '../Card.js';
import styles from './GatewayLatencyHistoryCard.module.css';

/**
 * What the nightly latency sweeps read over the window.
 *
 * The card above this one reads `/model/metrics` for the days on screen when
 * somebody presses it, and it is a good answer to "how slowly did the backends
 * answer" and no answer at all to "is that how they usually answer" — the route
 * aggregates whatever window it is handed and has no memory. This one is the
 * same sweep kept, one reading per alias per endpoint per UTC night.
 *
 * Four things the card must not do, all of them consequences of what is stored:
 *
 *  - **render anything as a duration.** The reading is
 *    `AVG(seconds / completion_tokens)` over requests. Sixty nights of a rate is
 *    still a rate, and the only transformation that adds no claim is its
 *    reciprocal — which is why the two units on this card are ms/tok and tok/s
 *    and there is no "a call took" anywhere on it.
 *  - **pool two nights.** The proxy averaged the request counts away, so no
 *    night carries a weight and a mean of two nights is unavailable in principle
 *    rather than merely unimplemented. Every figure here is a **median** — of a
 *    night's pairs, of a pair's nights, of the pair medians gateway-wide.
 *  - **draw an unread night as a fast one.** Every strip has three states. A
 *    sweep that did not run, a deployment that served no completion tokens that
 *    day (`HAVING SUM(...) > 0`), and a proxy running `disable_spend_logs` all
 *    leave the same absence behind — and none of them is a fast night.
 *  - **read a short recording as an unchanged one.** Under
 *    {@link LATENCY_TREND_MIN_DAYS} observed nights the direction is withheld
 *    and the card says why, because "unchanged" would be a fact about the age of
 *    the recording.
 *
 * The trend it does draw is a **ratio**, not percentage points — the opposite
 * choice from the hang and exception history cards and forced by the unit: those
 * compare shares, where a difference is points, while a difference of two rates
 * is a number in seconds-per-token whose size depends on which models the
 * gateway happens to run.
 */

interface GatewayLatencyHistoryCardProps {
  view: LatencyHistoryView;
}

/** Longer than this and a deployment key is the row rather than a label in it. */
const MAX_KEY = 46;

function shorten(key: string): string {
  return key.length <= MAX_KEY ? key : `${key.slice(0, MAX_KEY - 1)}…`;
}

/** The stored rate, in the unit the live card uses. Never a duration. */
function msPerToken(seconds: number | null): string {
  return seconds === null ? '—' : `${(seconds * 1000).toFixed(1)} ms/tok`;
}

function tps(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(0)} tok/s`;
}

const HEALTH_LABEL: Record<LatencyHistoryRow['health'], string> = {
  failing: 'failing tonight',
  healthy: 'healthy tonight',
  mixed: 'reading disagrees',
  unread: 'not in tonight’s reading',
};

export function GatewayLatencyHistoryCard({ view }: GatewayLatencyHistoryCardProps) {
  const { trend } = view.summary;
  // Height is the night's gateway median against the slowest night recorded;
  // opacity is how many pairs reported it. A night two of nine endpoints
  // answered has a perfectly valid median that describes almost nothing, and
  // drawing it at full strength is the same class of lie as drawing an unread
  // night as fast — the second channel is borrowed from the live card for that
  // reason.
  const worstReading = view.worstDay?.medianSecondsPerToken ?? 0;
  const mostKeys = view.days.reduce((most, day) => (day.keys > most ? day.keys : most), 0);

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Latency over time</div>
          <div className={styles.sub}>
            the same nightly sweep kept, one reading per endpoint per alias per UTC night · the card
            above says how slowly the backends answered the days on screen, this says whether that is
            how they usually answer — every figure a median, because the proxy averaged the request
            counts away and there is no weight left with which to pool two nights
          </div>
        </div>
        <div className={styles.headline}>
          <div className={cx(styles.headlineValue, view.elevatedKeys > 0 && styles.warn)}>
            {msPerToken(view.medianSecondsPerToken)}
          </div>
          <div className={styles.headlineNote}>
            {tps(view.medianTokensPerSecond)} · median of {view.summary.observedKeys} endpoint
            {view.summary.observedKeys === 1 ? '' : 's'} across {view.daysRecorded} of the last{' '}
            {LATENCY_HISTORY_DAYS} nights
            {view.recordingSince !== null && <> · since {isoDateLabel(view.recordingSince)}</>}
          </div>
        </div>
      </div>

      {/*
        Not a footnote: with fewer observed nights than a split needs, the one
        statement this card adds over the live read cannot be made, and a card
        that simply drew no direction would read as "unchanged".
      */}
      {view.tooShort && (
        <div className={styles.warning}>
          <strong>Too short for a direction.</strong> A trend here needs {LATENCY_TREND_MIN_DAYS}{' '}
          observed nights so each half is three, and only {view.daysRecorded} night
          {view.daysRecorded === 1 ? ' carries' : 's carry'} a reading so far. There is no backfill
          for this — the sweep asks the proxy about one settled day and files what it answered — so
          the window fills in one night at a time.
        </div>
      )}

      <div className={styles.disclosure}>
        <span className={styles.flag}>a rate, not a duration</span>
        Every reading is seconds of wall clock per completion token, averaged per request by the
        proxy. Stacking sixty nights of it does not turn it into how long a call took, and a
        deployment answering in one token carries its whole connection overhead in the ratio.
      </div>

      <div className={styles.stats}>
        <Stat
          label="Trend"
          value={trend === null ? '—' : `${trend.ratio.toFixed(2)}×`}
          sub={
            trend === null
              ? `withheld — ${latencyTrendReason(view)}`
              : `${msPerToken(trend.earlier.medianSecondsPerToken)} over ${trend.earlier.days} night${trend.earlier.days === 1 ? '' : 's'} to ${isoDateLabel(trend.earlier.to)}, ${msPerToken(trend.recent.medianSecondsPerToken)} over ${trend.recent.days} since · a ratio, because a difference of two rates has no readable unit`
          }
          tone={trend === null ? undefined : trend.ratio > 1 ? 'bad' : 'good'}
        />
        <Stat
          label="Materially slower"
          value={String(view.elevatedKeys)}
          sub={`at or past ${LATENCY_ELEVATED_RATIO}× the gateway median on ${LATENCY_MIN_DAYS}+ recorded nights · the live card's own gates restated, never a significance test — this payload carries no counts`}
          tone={view.elevatedKeys > 0 ? 'warn' : undefined}
        />
        <Stat
          label="Slowest night"
          value={view.worstDay === null ? '—' : msPerToken(view.worstDay.medianSecondsPerToken)}
          sub={
            view.worstDay === null
              ? 'no night carries a reading yet'
              : `${isoDateLabel(view.worstDay.date)} · ${view.worstDay.keys} endpoint${view.worstDay.keys === 1 ? '' : 's'} across ${view.worstDay.models} alias${view.worstDay.models === 1 ? '' : 'es'} reported it`
          }
        />
        <Stat
          label="Nights recorded"
          value={`${view.daysRecorded}/${view.dates.length}`}
          sub={
            view.daysMissed === 0
              ? 'every night of the drawn window carries a sweep · the window ends yesterday, because today has not settled'
              : `${view.daysMissed} night${view.daysMissed === 1 ? '' : 's'} filed none — a sync that did not run, a refused route or disable_spend_logs, never a fast night`
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
                ? `${isoDateLabel(day.date)} · ${msPerToken(day.medianSecondsPerToken)} median across ${day.keys} endpoint${day.keys === 1 ? '' : 's'}, ${day.models} alias${day.models === 1 ? '' : 'es'} swept`
                : `${isoDateLabel(day.date)} · no sweep filed`
            }
          >
            {day.observed ? (
              <div
                className={styles.bar}
                style={{
                  height:
                    worstReading === 0
                      ? '2px'
                      : `${Math.max(8, ((day.medianSecondsPerToken ?? 0) / worstReading) * 100)}%`,
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
          median ms/tok per night, faded by how many endpoints reported it · hatched is a night with
          no sweep
        </span>
        <span>{view.dates.length > 0 ? isoDateLabel(view.to) : ''}</span>
      </div>

      <div className={cx(styles.row, styles.headerStrip)}>
        <div>ENDPOINT · ALIAS</div>
        <div>NIGHTS</div>
        <div className={styles.right}>MEDIAN</div>
      </div>

      {view.rows.map((row) => (
        <PairRow key={`${row.model} ${row.key}`} row={row} />
      ))}

      <div className={styles.footer}>
        One reading per endpoint per alias per UTC night, appended by the full sync for the day usage
        has settled for — a backfill, a refused route, <code>disable_spend_logs</code> and a
        swallowed failure all file nothing, so a missing night is a night nobody read rather than a
        fast one. The grain keeps the alias: two aliases behind one endpoint are two averages over
        two workloads, and there is no request count anywhere in this layer with which to combine
        them — which is also why nothing here is summed, weighted or filled in. The badge is the live
        card's own ratio and days-observed gate restated over the stored nights, and nothing here
        feeds the digest at the top: a standing fault names the deployment tonight’s health snapshot
        is already reporting, and a rise in this number can be a classifier answering in one token
        rather than a backend that got slower.
      </div>
    </Card>
  );
}

function PairRow({ row }: { row: LatencyHistoryRow }) {
  return (
    <div className={cx(styles.row, row.elevated && styles.rowBad)}>
      <div className={styles.name}>
        <span className={styles.key} title={row.key}>
          {shorten(row.key)}
        </span>
        <span className={styles.sublabel}>
          {row.elevated && <span className={cx(styles.badge, styles.badgeBad)}>slow</span>}
          <span
            className={cx(
              styles.badge,
              row.health === 'failing' && styles.badgeBad,
              row.health === 'unread' && styles.badgeMuted,
            )}
            title={
              row.health === 'mixed'
                ? `${row.behindKey} deployments answer on this endpoint and tonight’s reading disagrees about them — the rate belongs to none of them`
                : row.health === 'unread'
                  ? 'tonight’s /health reading does not name this endpoint — silence, not health'
                  : `tonight’s /health reading, across ${row.behindKey} deployment${row.behindKey === 1 ? '' : 's'} on this endpoint`
            }
          >
            {HEALTH_LABEL[row.health]}
          </span>
          <span className={styles.backend} title={row.model}>
            {row.model}
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
                cell.state === 'fast' && styles.cellFast,
                cell.state === 'slow' && styles.cellSlow,
                cell.state === 'unobserved' && styles.cellNone,
              )}
              title={
                cell.state === 'unobserved'
                  ? `${isoDateLabel(cell.date)} · no reading`
                  : `${isoDateLabel(cell.date)} · ${msPerToken(cell.secondsPerToken)}${cell.ratioToOwnMedian === null ? '' : ` · ${cell.ratioToOwnMedian.toFixed(2)}× its own median`}`
              }
            />
          ))}
        </div>
        <div className={styles.note}>
          {row.daysObserved} night{row.daysObserved === 1 ? '' : 's'} recorded
          {row.unobservedDays > 0 && <> · {row.unobservedDays} unread inside its own span</>} ·
          slowest {msPerToken(row.worstDay.secondsPerToken)} ({isoDateLabel(row.worstDay.date)}),
          fastest {msPerToken(row.bestDay.secondsPerToken)} ({isoDateLabel(row.bestDay.date)})
          <span className={styles.reason}> · {latencyHistoryBadgeReason(row)}</span>
        </div>
      </div>

      <div className={styles.right}>
        {msPerToken(row.medianSecondsPerToken)}
        <span className={styles.share}>
          {tps(row.tokensPerSecond)}
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
