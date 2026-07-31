import { cx } from '../../lib/cx.js';
import { compactCount, count, EMPTY, percent, usd } from '../../lib/format.js';
import type { AdoptionDay, AdoptionSummary } from '../../lib/metrics/gatewayAdoption.js';
import { Card } from '../Card.js';
import styles from './GatewayAdoptionCard.module.css';

/**
 * The gateway read as people rather than as workloads.
 *
 * Two questions no spend chart on this page can answer, and both of them decide
 * how the platform gets funded: how many people actually use the single
 * corporate endpoint, and how evenly the bill is spread across them. A gateway
 * where nine users are 80% of the spend is a chargeback conversation with three
 * teams; one where four hundred people each spend a little is a per-seat
 * economics conversation with finance. The concentration read is the number
 * that tells those two gateways apart.
 *
 * The card leads with attribution coverage rather than burying it, because
 * everything below it is scoped by that number. LiteLLM only carries a user on
 * a call whose caller passed one — a service key acting on nobody's behalf
 * carries none — so a per-user table on a gateway at 40% coverage is describing
 * a minority of the money, and reading it as the whole is the mistake this card
 * is most able to cause.
 */

/** Enough to name the heavy users; past this the table stops being a finding. */
const MAX_ROWS = 8;

interface GatewayAdoptionCardProps {
  summary: AdoptionSummary;
}

/** 0..1 → `18.4%`, or `—` when there was no denominator. */
function share(value: number | null): string {
  return value === null ? EMPTY : percent(value * 100);
}

/** Mean actives, to one decimal — a mean of counts is not itself a count. */
function mean(value: number | null): string {
  return value === null ? EMPTY : value.toFixed(1);
}

/**
 * How concentrated the bill is, in a sentence someone can act on.
 *
 * The threshold is deliberately generous: at these volumes a top decile under a
 * third is already an unusually flat gateway, and calling anything above it
 * "concentrated" would make the sentence a constant.
 */
function concentrationNote(summary: AdoptionSummary): string {
  const { topDecileShare, usersForMost, users } = summary.concentration;
  if (topDecileShare === null || usersForMost === null || users === 0) {
    return 'nothing attributed to a user in this range';
  }
  const shape =
    topDecileShare >= 0.6
      ? 'a small group carries the gateway'
      : topDecileShare >= 0.33
        ? 'usage leans on its heaviest users'
        : 'spend is spread broadly across the population';
  return `${shape} — the top ${percent(topDecileShare * 100)} of spend sits with ${count(Math.max(1, Math.ceil(users / 10)))} of ${count(users)} users`;
}

export function GatewayAdoptionCard({ summary }: GatewayAdoptionCardProps) {
  const { concentration, trend } = summary;

  const shown = summary.users.slice(0, MAX_ROWS);
  const hidden = summary.users.length - shown.length;
  const leader = shown[0]?.metrics.spend ?? 0;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>People on the gateway</div>
          <div className={styles.sub}>
            who the proxy attributed calls to, and how evenly the bill is spread across them
          </div>
        </div>
        <div className={styles.headline}>
          <div className={styles.kicker}>USERS IN RANGE</div>
          <div className={styles.headlineValue}>{count(summary.totalUsers)}</div>
          <div className={styles.headlineNote}>
            {mean(summary.meanDailyActive)} active on an average day
          </div>
        </div>
      </div>

      <div className={styles.body}>
        <div className={styles.coverage}>
          <span className={styles.coverageValue}>{share(summary.coverage)}</span> of gateway spend
          carries a user id ({usd(summary.attributed.spend, 2)} of {usd(summary.totals.spend, 2)}).
          Everything below is a read on that share, not on the whole bill.
        </div>

        <ActiveStrip days={summary.daily} />

        <div className={styles.statRow}>
          <div className={styles.stat}>
            <div className={styles.kicker}>SPEND PER USER</div>
            <div className={styles.statValue}>
              {summary.spendPerUser === null ? EMPTY : usd(summary.spendPerUser, 2)}
            </div>
            <div className={styles.statSub}>
              {summary.requestsPerUser === null
                ? EMPTY
                : `${compactCount(Math.round(summary.requestsPerUser))} calls each`}{' '}
              across the range
            </div>
          </div>
          <div className={styles.stat}>
            <div className={styles.kicker}>DAILY REACH</div>
            <div className={styles.statValue}>{share(summary.stickiness)}</div>
            <div className={styles.statSub}>
              of the population calls on an average day · peak {count(summary.peakDailyActive)}
            </div>
          </div>
          <div className={styles.stat}>
            <div className={styles.kicker}>NEW USERS</div>
            <div className={styles.statValue}>{count(summary.newUsers)}</div>
            <div className={styles.statSub}>first seen in the second half of this window</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.kicker}>DIRECTION</div>
            <TrendValue trend={trend} />
            <div className={styles.statSub}>
              {trend === null
                ? 'too few days on screen to compare halves'
                : `${mean(trend.firstHalfMeanActive)} daily over the first ${trend.firstHalfDays}d · ${mean(trend.secondHalfMeanActive)} over the last ${trend.secondHalfDays}d`}
            </div>
          </div>
        </div>

        {/* The concentration read: two counts and a sentence, rather than an
            index nobody can act on. A Gini coefficient would compress the same
            information into a number that needs a paragraph before it means
            anything. */}
        <div className={styles.concentration}>
          <div className={styles.concentrationMarks}>
            <div className={styles.mark}>
              <span className={styles.markValue}>
                {concentration.usersForHalf === null ? EMPTY : count(concentration.usersForHalf)}
              </span>
              <span className={styles.markLabel}>users are half the attributed spend</span>
            </div>
            <div className={styles.mark}>
              <span className={styles.markValue}>
                {concentration.usersForMost === null ? EMPTY : count(concentration.usersForMost)}
              </span>
              <span className={styles.markLabel}>are 80% of it</span>
            </div>
            <div className={styles.mark}>
              <span className={styles.markValue}>{share(concentration.topUserShare)}</span>
              <span className={styles.markLabel}>sits with the single heaviest user</span>
            </div>
          </div>
          <div className={styles.concentrationNote}>{concentrationNote(summary)}</div>
        </div>

        <div className={cx(styles.row, styles.headerStrip)}>
          <div>USER</div>
          <div />
          <div className={styles.right}>SPEND</div>
          <div className={styles.right}>OF ATTRIBUTED</div>
          <div className={styles.right}>CUMULATIVE</div>
          <div className={styles.right}>ACTIVE DAYS</div>
        </div>

        {shown.map((row) => (
          <div key={row.key} className={styles.row}>
            <div className={styles.name} title={row.key}>
              <span className={styles.key}>{row.label ?? row.key}</span>
              <span className={styles.sublabel}>
                {row.isNew ? 'new · ' : ''}
                {row.firstSeen} … {row.lastSeen}
              </span>
            </div>
            <div className={styles.trackCell}>
              <div className={styles.rowTrack}>
                <div
                  className={styles.rowFill}
                  style={{ width: leader > 0 ? `${(row.metrics.spend / leader) * 100}%` : '0%' }}
                />
              </div>
            </div>
            <div className={styles.right}>{usd(row.metrics.spend, 2)}</div>
            <div className={cx(styles.right, styles.muted)}>
              {percent(row.shareOfAttributed * 100)}
              <span className={styles.share}>{percent(row.share * 100)} of gateway</span>
            </div>
            <div className={cx(styles.right, styles.muted)}>
              {percent(row.cumulativeShare * 100)}
            </div>
            <div className={cx(styles.right, styles.muted)}>{count(row.activeDays)}</div>
          </div>
        ))}

        <div className={styles.footnote}>
          {hidden > 0 && `${hidden} more user${hidden === 1 ? '' : 's'} below the top ${MAX_ROWS}. `}
          A row here is whatever the caller passed as an end-user id, so a shared service key reads
          as one very heavy &ldquo;user&rdquo; and a person calling through two keys may read as
          two. &ldquo;New&rdquo; is bounded by the window on screen: someone who last called the
          week before it starts is indistinguishable from someone who never has.
        </div>
      </div>
    </Card>
  );
}

/** Half-over-half movement in daily actives, or a stand-down when the spine is short. */
function TrendValue({ trend }: { trend: AdoptionSummary['trend'] }) {
  if (trend === null || trend.deltaUsers === null) {
    return <div className={cx(styles.statValue, styles.muted)}>{EMPTY}</div>;
  }

  const direction = Math.sign(Number(trend.deltaUsers.toFixed(1)));
  return (
    <div className={cx(styles.statValue, direction > 0 && styles.rising)}>
      {direction > 0 ? '▲' : direction < 0 ? '▼' : '·'} {trend.deltaUsers >= 0 ? '+' : '−'}
      {Math.abs(trend.deltaUsers).toFixed(1)} users/day
    </div>
  );
}

/**
 * One bar per day: distinct users who actually called.
 *
 * A count rather than a rate here, unlike the reliability and agent strips: the
 * population is the quantity, and normalising it against anything would hide
 * exactly the weekend collapse and the onboarding ramp the strip exists to
 * show.
 */
function ActiveStrip({ days }: { days: readonly AdoptionDay[] }) {
  const peak = days.reduce((most, day) => Math.max(most, day.activeUsers), 0);
  if (peak === 0) return null;

  return (
    <div className={styles.strip}>
      <div className={styles.stripBars} role="img" aria-label="Distinct active users per day">
        {days.map((day) => (
          <div
            key={day.date}
            className={styles.stripSlot}
            title={`${day.date} · ${day.activeUsers} active · ${usd(day.attributedSpend, 2)} attributed${
              day.spendPerActiveUser === null
                ? ''
                : ` · ${usd(day.spendPerActiveUser, 2)} each`
            }`}
          >
            <div
              className={styles.stripBar}
              style={{ height: `${(day.activeUsers / peak) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className={styles.stripNote}>Distinct users calling per day · peaks at {peak}</div>
    </div>
  );
}
