import { STANDING_OUTAGE_READINGS } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { isoDateLabel } from '../../lib/format.js';
import { HEALTH_HISTORY_DAYS } from '../../lib/metrics/gatewayHealthHistory.js';
import type {
  DeploymentVerdict,
  HealthHistoryRow,
  HealthHistoryView,
} from '../../lib/metrics/gatewayHealthHistory.js';
import { Card } from '../Card.js';
import styles from './GatewayHealthHistoryCard.module.css';

/**
 * What the nightly `/health` readings did over the window.
 *
 * The card above this one renders tonight's reading; this one renders the
 * sequence, and the whole reason it exists is the pair of findings a snapshot
 * cannot tell apart: a pool that refused once and a pool that has refused every
 * night since Tuesday look identical in a single reading, and only the second is
 * a fault somebody has to route around.
 *
 * Three things the card must not do, all of them consequences of the reading
 * being a **sample**:
 *
 *  - **draw an unread day as a healthy one.** Every strip here has three states,
 *    and the hatched one is a night the sync did not file a reading. A green
 *    cell would assert a success nobody observed.
 *  - **report a duration or an availability figure.** A deployment can fail and
 *    recover between two nightly readings and leave nothing behind, so "failing
 *    at 9 of 14 readings" is a fact and "64% uptime" is not — every number on
 *    the card is a count of readings.
 *  - **read a short recording as a clean sheet.** Under
 *    {@link STANDING_OUTAGE_READINGS} recorded days the layer's own finding
 *    cannot be expressed at all, so the card says so instead of reporting that
 *    nothing is standing.
 */

interface GatewayHealthHistoryCardProps {
  view: HealthHistoryView;
}

/** Longer than this and the error text is the row rather than a line in it. */
const MAX_ERROR = 120;

const VERDICT_LABEL: Record<DeploymentVerdict, string> = {
  standing: 'standing',
  failing: 'failing',
  flapping: 'flapping',
  recovered: 'recovered',
  past: 'was failing',
  clear: 'clear',
};

function shorten(error: string): string {
  return error.length <= MAX_ERROR ? error : `${error.slice(0, MAX_ERROR - 1)}…`;
}

export function GatewayHealthHistoryCard({ view }: GatewayHealthHistoryCardProps) {
  const worstDay = view.days.reduce(
    (worst, day) => (day.observed && day.unhealthy > worst ? day.unhealthy : worst),
    0,
  );

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Deployment health over time</div>
          <div className={styles.sub}>
            the same nightly reading kept, one row per deployment per day · the snapshot above says
            which pools are refusing tonight, this says which have been refusing all week — counted
            in readings, because a deployment that failed and recovered overnight left nothing
            behind
          </div>
        </div>
        <div className={styles.headline}>
          <div
            className={cx(
              styles.headlineValue,
              view.standing > 0 && styles.bad,
              view.standing === 0 && view.flapping > 0 && styles.warn,
              view.standing === 0 && view.flapping === 0 && !view.tooShort && styles.good,
            )}
          >
            {view.standing === 0
              ? 'none standing'
              : `${view.standing} standing fault${view.standing === 1 ? '' : 's'}`}
          </div>
          <div className={styles.headlineNote}>
            {view.daysRecorded} reading{view.daysRecorded === 1 ? '' : 's'} over the last{' '}
            {HEALTH_HISTORY_DAYS} days
            {view.recordingSince !== null && <> · since {isoDateLabel(view.recordingSince)}</>}
          </div>
        </div>
      </div>

      {/*
        Not a footnote: with fewer recorded days than a standing run needs, the
        headline above is a statement about how long this dashboard has been
        watching. The findings it does hold are still shown below.
      */}
      {view.tooShort && (
        <div className={styles.warning}>
          <strong>Too short to tell.</strong> A standing fault needs {STANDING_OUTAGE_READINGS}{' '}
          consecutive failing readings and only {view.daysRecorded} day
          {view.daysRecorded === 1 ? ' carries' : 's carry'} a reading so far. There is no backfill
          for this — the proxy serves current state only — so the window fills in one night at a
          time.
        </div>
      )}

      <div className={styles.stats}>
        <Stat
          label="Standing"
          value={String(view.standing)}
          sub={
            view.standing === 0
              ? `no deployment has failed ${STANDING_OUTAGE_READINGS} readings running`
              : `failing now, and for longer than one evening can explain`
          }
          tone={view.standing === 0 ? 'good' : 'bad'}
        />
        <Stat
          label="Flapping"
          value={String(view.flapping)}
          sub={
            view.flapping === 0
              ? 'no deployment has more than one distinct episode here'
              : 'more than one episode in the window — intermittent rather than broken'
          }
          tone={view.flapping === 0 ? 'good' : 'warn'}
        />
        <Stat
          label="Episodes"
          value={String(view.outages)}
          sub={`across ${view.rows.length} deployment${view.rows.length === 1 ? '' : 's'} · ${
            view.recovered
          } recovered at the newest reading, ${view.newlyFailing} newly failing`}
        />
        <Stat
          label="Readings"
          value={`${view.daysRecorded}/${view.dates.length}`}
          sub={
            view.daysMissed === 0
              ? 'every day of the drawn window carries a reading'
              : `${view.daysMissed} night${view.daysMissed === 1 ? '' : 's'} filed none — a sync that did not run, not a gateway that was fine`
          }
          tone={view.daysMissed === 0 ? 'good' : undefined}
        />
      </div>

      {/*
        Gateway-wide first: several deployments failing on one night is an
        incident, and the same count spread across a month is a flaky pool.
        Scaled to the worst observed day so a one-deployment fault is visible.
      */}
      <div className={styles.strip}>
        {view.days.map((day) => (
          <div
            key={day.date}
            className={styles.slot}
            title={
              day.observed
                ? `${isoDateLabel(day.date)} · ${day.unhealthy}/${day.deployments} failing`
                : `${isoDateLabel(day.date)} · no reading filed`
            }
          >
            {day.observed ? (
              <div
                className={cx(styles.bar, day.unhealthy > 0 && styles.barBad)}
                style={{
                  height:
                    day.unhealthy === 0 || worstDay === 0
                      ? '2px'
                      : `${Math.max(12, (day.unhealthy / worstDay) * 100)}%`,
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
          failing deployments per night · hatched is a night with no reading
        </span>
        <span>{view.dates.length > 0 ? isoDateLabel(view.to) : ''}</span>
      </div>

      <div className={cx(styles.row, styles.headerStrip)}>
        <div>DEPLOYMENT</div>
        <div>READINGS</div>
        <div className={styles.right}>FAILING</div>
      </div>

      {view.rows.map((row) => (
        <DeploymentRow key={row.id} row={row} />
      ))}

      <div className={styles.footer}>
        One row per deployment per UTC day, appended by the nightly sync and only when{' '}
        <code>/health</code> actually answered — a backfill files none, so a missing night is a
        night nobody looked rather than a night everything worked. A run of failing readings is
        broken by an <strong>observed recovery</strong> and by nothing else: an unread day inside a
        run is counted and reported, never used to split it, because splitting asserts a recovery
        nobody saw exactly as filling it in would assert a failure nobody saw. The alias is the one
        resolved on the day of the reading, so a deployment moved to another alias reads as the
        change it was.
      </div>
    </Card>
  );
}

function DeploymentRow({ row }: { row: HealthHistoryRow }) {
  const standing = row.standing;
  return (
    <div
      className={cx(
        styles.row,
        row.verdict === 'standing' && styles.rowBad,
        row.verdict === 'failing' && styles.rowBad,
        row.verdict === 'flapping' && styles.rowWarn,
      )}
    >
      <div className={styles.name}>
        <span className={styles.key}>
          {row.model ?? <span className={styles.muted}>unnamed deployment</span>}
        </span>
        <span className={styles.sublabel}>
          <span
            className={cx(
              styles.badge,
              (row.verdict === 'standing' || row.verdict === 'failing') && styles.badgeBad,
              row.verdict === 'flapping' && styles.badgeWarn,
              (row.verdict === 'recovered' || row.verdict === 'clear') && styles.badgeGood,
            )}
          >
            {VERDICT_LABEL[row.verdict]}
          </span>
          <span className={styles.backend} title={row.id}>
            {row.backend}
          </span>
          {row.renamed && <span className={styles.badge}>re-aliased</span>}
        </span>
      </div>

      <div className={styles.cellsColumn}>
        <div className={styles.cells}>
          {row.cells.map((cell) => (
            <span
              key={cell.date}
              className={cx(
                styles.cell,
                cell.state === 'healthy' && styles.cellUp,
                cell.state === 'failing' && styles.cellDown,
                cell.state === 'unobserved' && styles.cellNone,
              )}
              title={
                cell.state === 'unobserved'
                  ? `${isoDateLabel(cell.date)} · no reading`
                  : cell.state === 'healthy'
                    ? `${isoDateLabel(cell.date)} · answering`
                    : `${isoDateLabel(cell.date)} · failing${cell.error === null ? '' : ` · ${shorten(cell.error)}`}`
              }
            />
          ))}
        </div>
        <div className={styles.note}>
          {standing !== null ? (
            <>
              failing since {isoDateLabel(standing.from)} · {standing.readings} reading
              {standing.readings === 1 ? '' : 's'}
              {standing.unobservedDays > 0 && (
                <> · {standing.unobservedDays} unread night inside the run</>
              )}
              {standing.errors.length > 0 && (
                <span className={styles.error}> · {shorten(standing.errors[0] ?? '')}</span>
              )}
            </>
          ) : row.longest !== null ? (
            <>
              worst run {row.longest.readings} reading{row.longest.readings === 1 ? '' : 's'} to{' '}
              {isoDateLabel(row.longest.to)} · {row.outages.length} episode
              {row.outages.length === 1 ? '' : 's'} · {row.transitions} change
              {row.transitions === 1 ? '' : 's'}
            </>
          ) : (
            <>
              answering at every one of its {row.readings} reading
              {row.readings === 1 ? '' : 's'}
              {row.unobservedDays > 0 && <> · {row.unobservedDays} unread</>}
            </>
          )}
        </div>
      </div>

      <div className={styles.right}>
        {row.failingReadings}/{row.readings}
        <span className={styles.share}>
          {row.failingReadings === 0 ? 'readings' : 'readings, never a duration'}
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
