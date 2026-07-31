import { LATENCY_ELEVATED_RATIO, LATENCY_MAX_WINDOW_DAYS } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { isoDateLabel, relativeTime } from '../../lib/format.js';
import {
  latencyBadgeReason,
  type LatencyDay,
  type LatencyRow,
  type LatencyView,
} from '../../lib/metrics/gatewayLatency.js';
import { Card } from '../Card.js';
import styles from './GatewayLatencyCard.module.css';

/**
 * How slowly the backends answered.
 *
 * The page's only card about *time*, and the only one whose unit has to be
 * spelled out on the card itself: the proxy answers seconds per completion
 * token, averaged per request, so every figure here is a **rate**. There is no
 * request duration anywhere on this card, no percentile and no SLA figure —
 * those are claims the payload cannot support, and the one re-reading that adds
 * nothing is the reciprocal, tokens per second.
 *
 * What it adds that no other surface can:
 *
 *  - the reliability card counts calls that failed and the exception card says
 *    why; a deployment that answers every call *slowly* fails nothing, bills
 *    normally and is invisible on both;
 *  - it is keyed at a deployment, so a reserved-throughput pool crawling behind
 *    an alias whose sibling is fine reads as itself rather than as an average;
 *  - and it joins to the nightly `/health` reading, which is where "slow now"
 *    and "refusing now" turn out to be the same deployment twice.
 *
 * The join carries a state the exception card did not need. This route's key is
 * an `api_base` alone, so two backend models behind one endpoint collapse onto
 * one key upstream: when the health reading names several deployments there and
 * disagrees about them, the row reads `mixed` rather than picking one.
 */

interface GatewayLatencyCardProps {
  view: LatencyView;
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

/**
 * Seconds per completion token, in the unit a reader can hold.
 *
 * Milliseconds per token is the same rate with the decimal point moved — a unit
 * change, not a transformation. Multiplying by a token count would be a claim
 * about completion length and is exactly what this layer forbids.
 */
function msPerToken(seconds: number): string {
  return `${(seconds * 1000).toFixed(1)} ms/tok`;
}

function tps(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(0)} tok/s`;
}

export function GatewayLatencyCard({
  view,
  onRead,
  loading,
  error,
  enabled,
}: GatewayLatencyCardProps) {
  const { window: readWindow } = view;
  const windowLabel =
    readWindow === null ? 'this window' : `${readWindow.from} → ${readWindow.to}`;
  const worstDay = view.daily.reduce<LatencyDay | null>(
    (slowest, day) =>
      slowest === null || day.medianSecondsPerToken > slowest.medianSecondsPerToken ? day : slowest,
    null,
  );

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>How slowly the backends answered</div>
          <div className={styles.sub}>
            seconds per completion token from <code>/model/metrics</code>, per deployment per day,
            read from the proxy live and stored nowhere · a <strong>rate</strong>, never a request
            duration — the cards above count calls that failed, a deployment that merely crawls
            fails none of them
          </div>
        </div>
        <button
          type="button"
          className={styles.run}
          onClick={onRead}
          disabled={!enabled || loading}
        >
          {loading ? 'Reading…' : view.answered ? 'Read again' : 'Read latency'}
        </button>
      </div>

      {error !== null && <div className={styles.failed}>{error.message}</div>}

      {!view.answered && error === null && (
        <div className={styles.idle}>
          Nothing is fetched until this is pressed. The proxy's latency route filters on one model
          at a time with no wildcard, so a read is one round trip per alias in the window — the API
          picks them from the window's own usage, ranked by spend, and says which it left out. The
          window is the last {LATENCY_MAX_WINDOW_DAYS} days of the range on screen at most, because
          the table underneath is the request log rather than the daily aggregates.
        </div>
      )}

      {view.answered && !view.available && (
        <div className={styles.idle}>
          The proxy did not answer <code>/model/metrics</code>. That most often means{' '}
          <code>disable_spend_logs</code> is set — this route aggregates the request log rather than
          the daily rows — or the credential is not an admin one.{' '}
          <strong>It never means the gateway was fast.</strong>
        </div>
      )}

      {view.answered && view.available && view.empty && (
        <div className={styles.idle}>
          The proxy answered and measured nothing over {windowLabel}. The query excludes cache hits
          and requires completion tokens (<code>HAVING SUM(completion_tokens) &gt; 0</code>), so a
          window served from cache or spent entirely on embeddings reads as silence here — which is
          not the same as instant.
        </div>
      )}

      {view.answered && view.available && !view.empty && (
        <>
          <div className={styles.disclosure}>
            <span className={styles.flag}>rate</span>
            {view.observedKeys} deployment key{view.observedKeys === 1 ? '' : 's'} measured over{' '}
            {windowLabel} · gateway median{' '}
            {view.medianSecondsPerToken === null ? '—' : msPerToken(view.medianSecondsPerToken)} (
            {tps(view.medianTokensPerSecond)}) — seconds of wall clock per completion token,
            averaged per request, so a one-token answer carries its whole connection overhead and
            counts as much as a long generation
            {view.fetchedAt !== null && <> · read {relativeTime(view.fetchedAt)}</>}
          </div>

          <div className={styles.stats}>
            <Stat
              label="Gateway median"
              value={
                view.medianSecondsPerToken === null ? '—' : msPerToken(view.medianSecondsPerToken)
              }
              sub={`${tps(view.medianTokensPerSecond)} · a median across keys, never a sum — rates do not add`}
            />
            <Stat
              label="Slowest key"
              value={view.slowest === null ? '—' : msPerToken(view.slowest.meanSecondsPerToken)}
              sub={
                view.slowest === null
                  ? 'nothing measured'
                  : `${shorten(view.slowest.key)} · ${view.slowest.model}${
                      view.slowest.ratioToMedian === null
                        ? ''
                        : ` · ${view.slowest.ratioToMedian.toFixed(2)}× the median`
                    }`
              }
              tone={view.slowest?.elevated === true ? 'bad' : undefined}
            />
            <Stat
              label="Materially slower"
              value={String(view.elevatedKeys)}
              sub={`at or above ${LATENCY_ELEVATED_RATIO}× the gateway median · ${view.joinedKeys} key${
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
                  : `${view.skippedModels.length} not asked about — unmeasured, not fast: ${view.skippedModels.slice(0, 3).join(', ')}${view.skippedModels.length > 3 ? ' …' : ''}`
              }
              tone={view.skippedModels.length === 0 ? undefined : 'warn'}
            />
          </div>

          <div className={styles.sectionTitle}>Per day, median across the keys that reported</div>
          <div className={styles.sectionSub}>
            a median and never a sum, because rates do not add · a day where fewer keys reported is
            a thinner reading rather than a faster one, and the strip dims it instead of filling it
            in
          </div>

          <div className={styles.strip}>
            {view.daily.map((day) => (
              <DayCell
                key={day.date}
                day={day}
                worst={worstDay?.medianSecondsPerToken ?? day.medianSecondsPerToken}
                observedKeys={view.observedKeys}
              />
            ))}
          </div>

          <div className={styles.sectionTitle}>By deployment</div>
          <div className={styles.sectionSub}>
            the key is an <code>api_base</code> where there is one and the backend model where there
            is not — so a pool crawling behind an alias that bills normally is visible as itself,
            and two models behind one Azure endpoint are one row because the proxy collapsed them
            before we saw them
          </div>

          <div className={styles.rows}>
            {view.rows.map((row) => (
              <DeploymentRow
                key={`${row.model}::${row.key}`}
                row={row}
                median={view.medianSecondsPerToken}
                worst={view.slowest?.meanSecondsPerToken ?? row.meanSecondsPerToken}
              />
            ))}
          </div>

          <div className={styles.footer}>
            This is a <strong>rate, per completion token</strong>, and the proxy averaged the
            request counts away before answering — so there is no percentile, no request duration
            and no significance test anywhere here: a badge can only ever say "a lot slower than the
            rest of this gateway", gated on days observed. It reads the request log, so{' '}
            <code>disable_spend_logs</code> empties it, cache hits are excluded upstream (a cached
            answer has no backend latency), and a deployment that served no completion tokens is
            absent rather than instant. Nothing here feeds the digest at the top: a source that is
            unread until somebody presses a button would report a blind spot on every visit.
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * One day of the gateway's own reading.
 *
 * Height is the day's median against the worst day, and opacity is how many
 * keys reported — the two are kept apart deliberately, because a day with two
 * of nine keys reporting is a thin reading and drawing it at full strength
 * would make a quiet Sunday look like a fast one.
 */
function DayCell({
  day,
  worst,
  observedKeys,
}: {
  day: LatencyDay;
  worst: number;
  observedKeys: number;
}) {
  const height = worst <= 0 ? 0 : Math.max(6, (day.medianSecondsPerToken / worst) * 100);
  return (
    <div
      className={styles.dayCell}
      title={`${isoDateLabel(day.date)} · ${msPerToken(day.medianSecondsPerToken)} · ${day.keys} of ${observedKeys} keys reported`}
    >
      <span
        className={styles.dayFill}
        style={{ height: `${height}%`, opacity: 0.35 + 0.65 * day.coverage }}
      />
    </div>
  );
}

function DeploymentRow({
  row,
  median,
  worst,
}: {
  row: LatencyRow;
  median: number | null;
  worst: number;
}) {
  const width = worst <= 0 ? 1 : Math.max(1, (row.meanSecondsPerToken / worst) * 100);
  return (
    <div className={styles.row}>
      <div className={styles.rowHead}>
        <span className={styles.key} title={row.key}>
          {shorten(row.key)}
        </span>
        <span className={styles.alias}>{row.model}</span>
        <HealthFlag health={row.health} behindKey={row.behindKey} />
        {row.elevated && <span className={styles.badge}>slow</span>}
        <span className={styles.rate}>{msPerToken(row.meanSecondsPerToken)}</span>
        <span className={styles.ratio}>
          {row.ratioToMedian === null ? '—' : `${row.ratioToMedian.toFixed(2)}×`}
        </span>
      </div>
      <div className={styles.bar}>
        <span
          className={cx(styles.barFill, row.elevated && styles.barBad)}
          style={{ width: `${width}%` }}
        />
        {/*
          The gateway median as a tick on every row's own scale: the ratio
          column is the number, this is the same number readable at a glance.
        */}
        {median !== null && worst > 0 && (
          <span className={styles.medianTick} style={{ left: `${(median / worst) * 100}%` }} />
        )}
      </div>
      <div className={styles.rowSub}>
        {tps(row.tokensPerSecond)} · {row.days} day{row.days === 1 ? '' : 's'} measured · fastest{' '}
        {msPerToken(row.best.secondsPerToken)} ({isoDateLabel(row.best.date)}) · slowest{' '}
        {msPerToken(row.worst.secondsPerToken)} ({isoDateLabel(row.worst.date)}) ·{' '}
        {latencyBadgeReason(row)}
        {row.healthError !== null && (
          <span className={styles.healthError}> · health says: {row.healthError}</span>
        )}
      </div>
    </div>
  );
}

/**
 * What tonight's health reading says about the same deployment.
 *
 * Four states rather than the exception card's three, and the extra one is
 * forced by this route's key: an `api_base` fronting several deployments
 * collapses upstream, so a reading that finds one of them failing and another
 * fine describes no single owner of this row. `unread` stays silence — an
 * absent row is not a healthy one.
 */
function HealthFlag({
  health,
  behindKey,
}: {
  health: LatencyRow['health'];
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
