import { SLOW_RESPONSE_ELEVATED_RATIO, SLOW_RESPONSE_MAX_WINDOW_DAYS } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, count, relativeTime } from '../../lib/format.js';
import {
  SLOW_RESPONSE_THRESHOLD_NOTE,
  slowResponseBadgeReason,
  type SlowResponseRow,
  type SlowResponseView,
} from '../../lib/metrics/gatewaySlowResponses.js';
import { Card } from '../Card.js';
import styles from './GatewaySlowResponseCard.module.css';

/**
 * How many calls hung.
 *
 * The fourth and last question this page asks about one window of traffic, and
 * the only one about wall clock. Above it: how many calls failed, why they
 * failed, and how many seconds per completion token the rest averaged. A
 * request that ran for four minutes and then answered is a success on the
 * first, wrote nothing for the second, and reads as an ordinary long generation
 * on the third — while being the one request somebody was waiting on.
 *
 * Two things about the reading are on the card rather than in a footnote,
 * because both change what the numbers mean:
 *
 *  - **There is no duration here and there cannot be.** The proxy counts
 *    against its own `alerting_threshold` and never reports it, so "slow" is
 *    whatever this proxy was configured to consider slow. The card says that in
 *    words and never puts a number of seconds on a count.
 *  - **The percentages are of the route's own denominator.** `total_count` is
 *    the request-log rows it grouped, cache hits excluded upstream — not gateway
 *    requests. The ledger's count for the same days sits beside it as a
 *    disagreement between two tables, never as the denominator.
 *
 * It is also the only live read whose badge can afford both gates: the payload
 * carries hits and trials, so a Wilson bound can ask whether a difference is
 * real and a materiality ratio can ask whether it is worth acting on. An
 * unbadged row says which gate rejected it.
 */

interface GatewaySlowResponseCardProps {
  view: SlowResponseView;
  /** Reads the window. The card never fetches on its own. */
  onRead: () => void;
  loading: boolean;
  error: Error | null;
  /** False while the gateway source is off, or the spine is empty — nothing to ask about. */
  enabled: boolean;
}

/** Longer than this and a deployment key is the row rather than a label in it. */
const MAX_KEY = 52;

function shorten(key: string): string {
  return key.length <= MAX_KEY ? key : `${key.slice(0, MAX_KEY - 1)}…`;
}

function share(value: number | null, decimals = 2): string {
  return value === null ? '—' : `${(value * 100).toFixed(decimals)}%`;
}

export function GatewaySlowResponseCard({
  view,
  onRead,
  loading,
  error,
  enabled,
}: GatewaySlowResponseCardProps) {
  const { window: readWindow } = view;
  const windowLabel =
    readWindow === null ? 'this window' : `${readWindow.from} → ${readWindow.to}`;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>How many calls hung</div>
          <div className={styles.sub}>
            requests that ran past the proxy's own alerting threshold, from{' '}
            <code>/model/metrics/slow_responses</code>, per endpoint · read live and stored nowhere ·
            a call that hung and then <strong>succeeded</strong> fails nothing, writes no error log
            and — if the answer was long — reads as ordinary latency
          </div>
        </div>
        <button
          type="button"
          className={styles.run}
          onClick={onRead}
          disabled={!enabled || loading}
        >
          {loading ? 'Reading…' : view.answered ? 'Read again' : 'Read hangs'}
        </button>
      </div>

      {error !== null && <div className={styles.failed}>{error.message}</div>}

      {!view.answered && error === null && (
        <div className={styles.idle}>
          Nothing is fetched until this is pressed. The route filters on one model at a time with no
          wildcard, so a read is one round trip per alias in the window — the API picks them from
          the window's own usage, ranked by spend, and says which it left out. The window is the
          last {SLOW_RESPONSE_MAX_WINDOW_DAYS} days of the range on screen at most, because the
          table underneath is the request log rather than the daily aggregates.
        </div>
      )}

      {view.answered && !view.available && (
        <div className={styles.idle}>
          The proxy did not answer <code>/model/metrics/slow_responses</code>. That most often means{' '}
          <code>disable_spend_logs</code> is set — this route counts request-log rows — or the
          credential is not an admin one. <strong>It never means nothing hung.</strong>
        </div>
      )}

      {view.answered && view.available && view.empty && (
        <div className={styles.idle}>
          The proxy answered and grouped no requests at all over {windowLabel}. Cache hits are
          excluded upstream, and the request log is pruned on its own schedule rather than the
          aggregates' ninety days, so a window served from cache or older than that retention reads
          as silence here — which is not the same as a window in which nothing hung.
        </div>
      )}

      {view.answered && view.available && !view.empty && (
        <>
          <div className={styles.disclosure}>
            <span className={styles.flag}>no duration</span>
            {count(view.slow)} of {count(view.total)} requests reached {SLOW_RESPONSE_THRESHOLD_NOTE}
            . So this is a count against a line nobody here can see: no seconds are attached to it
            anywhere on this card, and the same workload on another proxy would answer a different
            number.
            {view.fetchedAt !== null && <> · read {relativeTime(view.fetchedAt)}</>}
          </div>

          <div className={styles.stats}>
            <Stat
              label="Hang rate"
              value={share(view.slowShare)}
              sub={`${count(view.slow)} of ${count(view.total)} requests the route grouped — its own denominator, with cache hits excluded upstream, never a share of gateway traffic`}
              tone={view.slowShare !== null && view.slowShare > 0 ? 'warn' : undefined}
            />
            <Stat
              label="Most hangs"
              value={view.mostHangs === null ? '—' : count(view.mostHangs.slow)}
              sub={
                view.mostHangs === null
                  ? 'nothing grouped'
                  : `${shorten(view.mostHangs.key)} · ${share(view.mostHangs.slowShare)} of its own ${count(view.mostHangs.total)} requests · ${view.mostHangs.models.length} alias${view.mostHangs.models.length === 1 ? '' : 'es'} routed here`
              }
              tone={view.mostHangs?.elevated === true ? 'bad' : undefined}
            />
            <Stat
              label="Materially worse"
              value={String(view.elevatedKeys)}
              sub={`both gates: measurably above the gateway rate and at or past ${SLOW_RESPONSE_ELEVATED_RATIO}× it · ${view.joinedKeys} key${
                view.joinedKeys === 1 ? '' : 's'
              } named by tonight's health reading${
                view.failingJoined > 0 ? `, ${view.failingJoined} of those failing now` : ''
              }`}
              tone={view.elevatedKeys > 0 ? 'warn' : undefined}
            />
            <Stat
              label="Aliases read"
              value={`${view.models.length}${view.skippedModels.length > 0 ? ` / ${view.models.length + view.skippedModels.length}` : ''}`}
              sub={
                view.skippedModels.length === 0
                  ? 'every model with usage in the window was asked about'
                  : `${view.skippedModels.length} not asked about — unswept, not healthy: ${view.skippedModels.slice(0, 3).join(', ')}${view.skippedModels.length > 3 ? ' …' : ''}`
              }
              tone={view.skippedModels.length === 0 ? undefined : 'warn'}
            />
          </div>

          {view.ledgerShare !== null && (
            <div className={styles.ledger}>
              The route grouped {compactCount(view.total)} requests over these days; the daily
              aggregates count {compactCount(view.ledgerRequests ?? 0)} for the same days —{' '}
              {share(view.ledgerShare, 1)}. Two tables, switched and pruned independently, and cache
              hits are in one of them and not the other: this is a disagreement worth seeing and not
              a coverage figure. Nothing on this card is divided by the ledger's number.
            </div>
          )}

          <div className={styles.sectionTitle}>By endpoint</div>
          <div className={styles.sectionSub}>
            the key is the <code>api_base</code> alone — coarser than either card above, with no
            fallback to a backend model string — so several models behind one Azure endpoint are one
            row, and every deployment addressed by region rather than by URL arrives in a single
            bucket that cannot be attributed to any of them
          </div>

          <div className={styles.rows}>
            {view.rows.map((row) => (
              <EndpointRow
                key={row.key}
                row={row}
                gatewayShare={view.slowShare}
                worst={view.worstShare ?? row.slowShare ?? 0}
              />
            ))}
          </div>

          <div className={styles.footer}>
            The threshold is the proxy's and is <strong>not in the response</strong>, so no figure
            here carries a duration and two proxies' counts are not comparable. The denominator is
            the route's own — request-log rows, cache hits excluded — which is what lets a badge
            here use both a significance test and a materiality ratio, where the latency card above
            can only use the second and the exception card can use neither. Nothing here feeds the
            digest at the top: a source that is unread until somebody presses a button would report
            a blind spot on every visit.
          </div>
        </>
      )}
    </Card>
  );
}

function EndpointRow({
  row,
  gatewayShare,
  worst,
}: {
  row: SlowResponseRow;
  gatewayShare: number | null;
  worst: number;
}) {
  const value = row.slowShare ?? 0;
  const width = worst <= 0 ? 1 : Math.max(1, (value / worst) * 100);
  return (
    <div className={styles.row}>
      <div className={styles.rowHead}>
        <span className={styles.key} title={row.key}>
          {shorten(row.key)}
        </span>
        <span className={styles.alias}>{row.models.join(', ')}</span>
        <HealthFlag health={row.health} behindKey={row.behindKey} />
        {row.elevated && <span className={styles.badge}>hangs</span>}
        <span className={styles.rate}>{share(row.slowShare)}</span>
        <span className={styles.ratio}>
          {row.ratioToGateway === null ? '—' : `${row.ratioToGateway.toFixed(2)}×`}
        </span>
      </div>
      <div className={styles.bar}>
        <span
          className={cx(styles.barFill, row.elevated && styles.barBad)}
          style={{ width: `${width}%` }}
        />
        {/*
          The gateway rate as a tick on every row's own scale: the ratio column
          is the number, this is the same number readable at a glance.
        */}
        {gatewayShare !== null && worst > 0 && (
          <span className={styles.gatewayTick} style={{ left: `${(gatewayShare / worst) * 100}%` }} />
        )}
      </div>
      <div className={styles.rowSub}>
        {count(row.slow)} of {count(row.total)} requests · {share(row.shareOfSlow, 1)} of every hang
        counted · {slowResponseBadgeReason(row, gatewayShare)}
        {row.healthError !== null && (
          <span className={styles.healthError}> · health says: {row.healthError}</span>
        )}
      </div>
    </div>
  );
}

/**
 * What tonight's health reading says about the same endpoint.
 *
 * Five states rather than the latency card's four. `unkeyed` is this route's
 * `GROUP BY api_base` bucket — every deployment of an alias that is addressed by
 * region rather than by URL, in one row — and it takes no verdict at all: there
 * is no endpoint to look up, so the reading is not silent about it, it simply
 * cannot be asked. `unread` remains silence, and neither is `healthy`.
 */
function HealthFlag({
  health,
  behindKey,
}: {
  health: SlowResponseRow['health'];
  behindKey: number;
}) {
  if (health === 'failing') {
    return <span className={cx(styles.health, styles.healthBad)}>failing now</span>;
  }
  if (health === 'healthy') {
    return <span className={cx(styles.health, styles.healthGood)}>healthy now</span>;
  }
  if (health === 'mixed') {
    return (
      <span
        className={cx(styles.health, styles.healthMixed)}
        title={`${behindKey} deployments share this endpoint and the reading disagrees about them`}
      >
        {behindKey} behind this endpoint
      </span>
    );
  }
  if (health === 'unkeyed') {
    return (
      <span
        className={cx(styles.health, styles.healthUnkeyed)}
        title="The proxy groups every deployment without an api_base into one bucket per alias — there is no endpoint here to look up in the health reading"
      >
        no endpoint to join
      </span>
    );
  }
  return <span className={cx(styles.health, styles.healthUnread)}>not in the reading</span>;
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
