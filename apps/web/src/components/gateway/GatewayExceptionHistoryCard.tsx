import { EXCEPTION_TREND_MIN_DAYS } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, count, isoDateLabel } from '../../lib/format.js';
import {
  EXCEPTION_HISTORY_DAYS,
  mixShiftReason,
} from '../../lib/metrics/gatewayExceptionHistory.js';
import type {
  ExceptionHistoryClassRow,
  ExceptionHistoryDeploymentRow,
  ExceptionHistoryView,
} from '../../lib/metrics/gatewayExceptionHistory.js';
import { Card } from '../Card.js';
import styles from './GatewayExceptionHistoryCard.module.css';

/**
 * What has been breaking, night after night.
 *
 * The card above this one sweeps `/model/metrics/exceptions` for the days on
 * screen when somebody presses it, and it is a good answer to "why did those
 * calls fail" and no answer at all to "is that what usually fails here". This one
 * is the same sweep kept — one row per alias per deployment per exception type
 * per UTC night — beside a **receipt** per night the sweep ran, which is the one
 * thing that makes the sequence readable: this route answers rows only where
 * something faulted, so a clean gateway and a refused sweep both file nothing.
 *
 * Four things the card must not do, all of them consequences of what is stored:
 *
 *  - **report a rate.** The error log carries no denominator, so sixty nights of
 *    counts is a bigger count with nothing under it. Every share here is of what
 *    was *recorded*, and there is no badge anywhere on the card because there is
 *    nothing to be significant against.
 *  - **draw an unread night as a clean one.** Every strip has three states, and
 *    the receipt is the only reason the middle one exists at all.
 *  - **read a rise in the count as a finding.** More exceptions is
 *    indistinguishable from more traffic, which is exactly why the one trend the
 *    layer states is a **mix shift**: a class going from a fifth of recorded
 *    errors to half of them is a change in what is breaking, and ten times the
 *    traffic moves it by nothing.
 *  - **read a short recording as a stable mix.** Under
 *    {@link EXCEPTION_TREND_MIN_DAYS} swept nights the shift is withheld and the
 *    card says why, because "nothing moved" would be a fact about the age of the
 *    recording.
 */

interface GatewayExceptionHistoryCardProps {
  view: ExceptionHistoryView;
}

/** Longer than this and a deployment key is the row rather than a label in it. */
const MAX_KEY = 52;

function shorten(key: string): string {
  return key.length <= MAX_KEY ? key : `${key.slice(0, MAX_KEY - 1)}…`;
}

function share(value: number | null, decimals = 1): string {
  return value === null ? '—' : `${(value * 100).toFixed(decimals)}%`;
}

function signedPoints(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)} pts`;
}

export function GatewayExceptionHistoryCard({ view }: GatewayExceptionHistoryCardProps) {
  const { trend } = view.summary;
  const { biggestShift } = view;
  const worstNight = view.worstDay?.total ?? 0;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>What broke over time</div>
          <div className={styles.sub}>
            the same nightly sweep kept, one row per alias per deployment per exception type per UTC
            night, beside a receipt per night it ran · the card above says why the failed calls
            failed over the days on screen, this says whether that is what usually fails here
          </div>
        </div>
        <div className={styles.headline}>
          <div className={styles.headlineValue}>{compactCount(view.total)}</div>
          <div className={styles.headlineNote}>
            exceptions recorded across {view.daysSwept} swept night
            {view.daysSwept === 1 ? '' : 's'} of the last {EXCEPTION_HISTORY_DAYS}
            {view.recordingSince !== null && <> · since {isoDateLabel(view.recordingSince)}</>}
          </div>
        </div>
      </div>

      {/*
        Not a footnote: with fewer swept nights than a split needs, the one
        statement this card adds over the live read cannot be made, and a card
        that simply drew no direction would read as "the mix is stable".
      */}
      {view.tooShort && (
        <div className={styles.warning}>
          <strong>Too short for a mix shift.</strong> Splitting the window in half needs{' '}
          {EXCEPTION_TREND_MIN_DAYS} swept nights so each half is three, and only {view.daysSwept}{' '}
          night{view.daysSwept === 1 ? ' carries' : 's carry'} a sweep so far. There is no backfill
          for this — the sweep asks the proxy about one settled day and files what it answered — so
          the window fills in one night at a time.
        </div>
      )}

      <div className={styles.disclosure}>
        <span className={styles.flag}>no denominator</span>
        The error log counts exceptions and nothing else — no requests, no failures, no traffic — so
        nothing here is a failure rate and every share is a share of what was <em>recorded</em>. That
        is also why the trend is a shift in the <em>mix</em> rather than in the counts: a busy week
        multiplies every class and means nothing, while a class taking a bigger slice of the same
        errors is a change in what is breaking.
      </div>

      <div className={styles.stats}>
        <Stat
          label="Biggest mix shift"
          value={biggestShift === null ? '—' : signedPoints(biggestShift.deltaPoints)}
          sub={
            biggestShift === null || trend === null
              ? `withheld under ${EXCEPTION_TREND_MIN_DAYS} swept nights — a split of three against three is one afternoon's incident against another`
              : `${biggestShift.label} (${biggestShift.owner}) · ${share(biggestShift.earlierShare)} of the ${trend.earlier.days} night${trend.earlier.days === 1 ? '' : 's'} to ${isoDateLabel(trend.earlier.to)}, ${share(biggestShift.recentShare)} of the ${trend.recent.days} since · each half pooled, never a mean of nightly mixes`
          }
          tone={biggestShift === null ? undefined : biggestShift.deltaPoints > 0 ? 'warn' : 'good'}
        />
        <Stat
          label="Classes recorded"
          value={String(view.classes.length)}
          sub={
            view.classes.length === 0
              ? 'nothing has been recorded on a swept night'
              : `${view.classes[0]?.label ?? ''} leads at ${share(view.classes[0]?.share ?? null)} of everything recorded · a class is derived on read from the stored exception type, so a taxonomy fix re-files the history`
          }
        />
        <Stat
          label="Clean nights"
          value={`${view.daysClean}/${view.daysSwept}`}
          sub={
            view.daysSwept === 0
              ? 'no night carries a sweep yet'
              : 'swept and recorded nothing — a finding this table can make only because the sweep files a receipt whether or not it found rows'
          }
          tone={view.daysClean > 0 ? 'good' : undefined}
        />
        <Stat
          label="Nights swept"
          value={`${view.daysSwept}/${view.dates.length}`}
          sub={
            view.daysMissed === 0
              ? 'every night of the drawn window carries a sweep · the window ends yesterday, because today has not settled'
              : `${view.daysMissed} night${view.daysMissed === 1 ? '' : 's'} filed none — a sync that did not run, a refused route or disable_error_logs, never a night nothing failed`
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
              !day.observed
                ? `${isoDateLabel(day.date)} · no sweep filed`
                : day.clean
                  ? `${isoDateLabel(day.date)} · swept ${day.models} alias${day.models === 1 ? '' : 'es'} and recorded nothing`
                  : `${isoDateLabel(day.date)} · ${count(day.total)} exception${day.total === 1 ? '' : 's'} across ${day.deployments} deployment${day.deployments === 1 ? '' : 's'}${day.dominantClass === null ? '' : `, mostly ${day.dominantClass}`} · ${day.models} alias${day.models === 1 ? '' : 'es'} swept`
            }
          >
            {day.observed ? (
              <div
                className={cx(styles.bar, day.clean && styles.barClean)}
                style={{
                  height:
                    day.total === 0 || worstNight === 0
                      ? '2px'
                      : `${Math.max(10, (day.total / worstNight) * 100)}%`,
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
          exceptions recorded per night · flat green is a swept night that found none, hatched is a
          night with no sweep
        </span>
        <span>{view.dates.length > 0 ? isoDateLabel(view.to) : ''}</span>
      </div>

      <div className={cx(styles.row, styles.headerStrip)}>
        <div>CLASS</div>
        <div>NIGHTS</div>
        <div className={styles.right}>RECORDED</div>
      </div>

      {view.classes.map((row) => (
        <ClassRow key={row.class} row={row} view={view} />
      ))}

      {view.classes.length === 0 && (
        <div className={styles.sectionNote}>
          Every swept night recorded nothing. That is a reading rather than an absence — the sweep
          ran and the proxy had no error rows to answer with.
        </div>
      )}

      {view.deployments.length > 0 && (
        <>
          <div className={cx(styles.row, styles.headerStrip)}>
            <div>DEPLOYMENT</div>
            <div>WHAT AND WHEN</div>
            <div className={styles.right}>RECORDED</div>
          </div>
          {view.deployments.map((row) => (
            <DeploymentRow key={row.deployment} row={row} />
          ))}
        </>
      )}

      <div className={styles.footer}>
        Appended by the full sync for the day usage has settled for — a backfill, a refused route,{' '}
        <code>disable_error_logs</code> and a swallowed failure all file nothing, so a missing night
        is a night nobody read rather than a night nothing failed, and a total read off this table is
        a <strong>floor</strong>. Halves are pooled rather than averaged: nightly totals differ by
        orders of magnitude, so a quiet Sunday's two timeouts would otherwise outvote a Wednesday's
        four hundred rate limits. Nothing here feeds the digest at the top — a standing fault names
        the deployment tonight's health reading is already reporting, and a rise in the count is
        indistinguishable from a rise in traffic.
      </div>
    </Card>
  );
}

function ClassRow({ row, view }: { row: ExceptionHistoryClassRow; view: ExceptionHistoryView }) {
  const moved = row.shiftPoints !== null && Math.abs(row.shiftPoints) >= 1;
  return (
    <div className={cx(styles.row, moved && styles.rowMoved)}>
      <div className={styles.name}>
        <span className={styles.label} title={row.docs}>
          {row.label}
        </span>
        <span className={styles.sublabel}>
          <span className={styles.badge}>{row.owner}</span>
          {row.newInRecentHalf === true && (
            <span className={cx(styles.badge, styles.badgeBad)}>new</span>
          )}
          <span className={styles.backend} title={row.types.map((type) => type.type).join(', ')}>
            {row.types
              .slice(0, 2)
              .map((type) => type.type)
              .join(', ')}
            {row.types.length > 2 && ` +${row.types.length - 2}`}
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
                cell.state === 'recorded' && styles.cellRecorded,
                cell.state === 'unobserved' && styles.cellNone,
              )}
              title={
                cell.state === 'unobserved'
                  ? `${isoDateLabel(cell.date)} · no sweep`
                  : cell.state === 'clean'
                    ? `${isoDateLabel(cell.date)} · swept, none of these`
                    : `${isoDateLabel(cell.date)} · ${count(cell.count)}`
              }
            />
          ))}
        </div>
        <div className={styles.note}>
          {row.daysPresent} night{row.daysPresent === 1 ? '' : 's'} carried one, across{' '}
          {row.deployments} deployment{row.deployments === 1 ? '' : 's'} · {isoDateLabel(row.firstDate)}{' '}
          to {isoDateLabel(row.lastDate)}
          <span className={styles.reason}> · {mixShiftReason(view, row)}</span>
        </div>
      </div>

      <div className={styles.right}>
        {count(row.count)}
        <span className={styles.share}>
          {share(row.share)} of recorded
          {row.shiftPoints !== null && ` · ${signedPoints(row.shiftPoints)}`}
        </span>
      </div>
    </div>
  );
}

function DeploymentRow({ row }: { row: ExceptionHistoryDeploymentRow }) {
  return (
    <div className={cx(styles.row, row.health === 'failing' && styles.rowMoved)}>
      <div className={styles.name}>
        <span className={styles.key} title={row.deployment}>
          {shorten(row.deployment)}
        </span>
        <span className={styles.sublabel}>
          {row.health === 'failing' && (
            <span
              className={cx(styles.badge, styles.badgeBad)}
              title={row.healthError ?? 'the nightly /health reading found this deployment failing'}
            >
              failing tonight
            </span>
          )}
          {row.health === 'healthy' && (
            <span className={cx(styles.badge, styles.badgeGood)}>up tonight</span>
          )}
          {row.health === 'unread' && (
            <span
              className={styles.badge}
              title="Tonight's /health reading does not name this deployment — an alias out of the catalogue, a proxy running health_check_details: false, or a deployment that has since gone. Silence, never health."
            >
              not in the reading
            </span>
          )}
          <span className={styles.backend} title={row.models.join(', ')}>
            {row.models.join(', ')}
          </span>
        </span>
      </div>

      <div className={styles.cellsColumn}>
        <div className={styles.note}>
          {row.dominantClass === null ? (
            'nothing recorded'
          ) : (
            <>
              mostly <strong>{row.dominantClass}</strong> at {share(row.dominantShare)} of its own
            </>
          )}{' '}
          · {row.daysPresent} night{row.daysPresent === 1 ? '' : 's'} from{' '}
          {isoDateLabel(row.firstDate)} to {isoDateLabel(row.lastDate)}
          {row.quietDays > 0 && (
            <> · {row.quietDays} night{row.quietDays === 1 ? '' : 's'} inside that span recorded none</>
          )}
          {row.worstDay !== null && (
            <>
              {' '}
              · worst {isoDateLabel(row.worstDay.date)} at {count(row.worstDay.count)}
            </>
          )}
        </div>
      </div>

      <div className={styles.right}>
        {count(row.count)}
        <span className={styles.share}>{share(row.share)} of recorded</span>
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
