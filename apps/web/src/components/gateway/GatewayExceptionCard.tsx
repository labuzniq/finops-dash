import { EXCEPTION_MAX_WINDOW_DAYS } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, count, relativeTime } from '../../lib/format.js';
import type {
  ExceptionClassRow,
  ExceptionDeploymentRow,
  ExceptionView,
} from '../../lib/metrics/gatewayExceptions.js';
import { Card } from '../Card.js';
import styles from './GatewayExceptionCard.module.css';

/**
 * Why the failed calls failed.
 *
 * The reliability card above says *how many* and *where*: a failure rate per
 * day, a rate per key, a badge when one deployment is materially worse than the
 * gateway. It cannot say what any of them were, because the daily aggregates
 * have no error column — a rate limit and an expired Azure credential are the
 * same `failed_requests` there, and they are two different pieces of work for
 * two different people. This card is the only place the reason exists.
 *
 * It sits *beside* that card rather than replacing it, and the wording matters
 * more here than anywhere else on the page:
 *
 *  - the numbers are **exceptions recorded**, never failures. A third table, a
 *    third switch (`disable_error_logs`), a third retention schedule — so there
 *    is no failure rate and no share-of-traffic anywhere on this card, and the
 *    one figure that touches the ledger is shown as a disagreement between two
 *    tables rather than as coverage;
 *  - an alias the sweep did not reach is **unread**, not clean;
 *  - and an empty answer means "no errors *recorded*", which on a proxy running
 *    `disable_error_logs` is a different claim from none happening.
 *
 * What it adds that nothing else on this page can: two classes that appear on
 * no other surface at all (`auth`, `budget`), and a deployment refusing on
 * quota behind an alias that bills and fails normally — named as a quota rather
 * than left as a mystery.
 */

interface GatewayExceptionCardProps {
  view: ExceptionView;
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

/** A fraction as a percentage with one decimal — class shares sit under 1% routinely. */
function share(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function GatewayExceptionCard({
  view,
  onRead,
  loading,
  error,
  enabled,
}: GatewayExceptionCardProps) {
  const { window: readWindow } = view;
  const windowLabel =
    readWindow === null ? 'this window' : `${readWindow.from} → ${readWindow.to}`;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Why calls failed</div>
          <div className={styles.sub}>
            exception classes from <code>LiteLLM_ErrorLogs</code>, per deployment, read from the
            proxy live and stored nowhere · the card above counts failures, this one is the only
            place the gateway says what they were
          </div>
        </div>
        <button
          type="button"
          className={styles.run}
          onClick={onRead}
          disabled={!enabled || loading}
        >
          {loading ? 'Reading…' : view.answered ? 'Read again' : 'Read reasons'}
        </button>
      </div>

      {error !== null && <div className={styles.failed}>{error.message}</div>}

      {!view.answered && error === null && (
        <div className={styles.idle}>
          Nothing is fetched until this is pressed. The proxy's exception route filters on one model
          at a time with no wildcard, so a read is one round trip per alias in the window — the API
          picks them from the window's own usage, ranked by spend, and says which it left out. The
          window is the last {EXCEPTION_MAX_WINDOW_DAYS} days of the range on screen at most.
        </div>
      )}

      {view.answered && !view.available && (
        <div className={styles.idle}>
          The proxy does not serve <code>/model/metrics/exceptions</code>. That most often means
          <code>disable_error_logs</code> is set or the credential is not an admin one — the reasons
          simply are not being recorded, and every failure the reliability card counts is still real.
        </div>
      )}

      {view.answered && view.available && view.empty && (
        <div className={styles.idle}>
          The proxy answered and recorded no exceptions for {windowLabel}.{' '}
          <strong>No errors recorded is not the same as no errors.</strong>{' '}
          <code>LiteLLM_ErrorLogs</code> has its own switch and its own retention, and the ledger
          counted{' '}
          {view.ledgerFailures === null
            ? 'failures over the same days'
            : `${count(view.ledgerFailures)} failed request${view.ledgerFailures === 1 ? '' : 's'} over the same days`}
          .
        </div>
      )}

      {view.answered && view.available && !view.empty && (
        <>
          <div className={styles.disclosure}>
            <span className={styles.flag}>reasons</span>
            {count(view.total)} exceptions recorded over {windowLabel}
            {view.ledgerFailures !== null && (
              <>
                {' '}
                · the ledger counted {compactCount(view.ledgerFailures)} failed requests for the same
                days
                {view.recordedShare !== null && <> ({share(view.recordedShare)})</>} — two tables,
                switched and pruned independently, so they are not expected to agree
              </>
            )}
            {view.fetchedAt !== null && <> · read {relativeTime(view.fetchedAt)}</>}
          </div>

          <div className={styles.stats}>
            <Stat
              label="Dominant class"
              value={view.dominant === null ? '—' : view.dominant.label}
              sub={
                view.dominant === null
                  ? 'nothing recorded'
                  : `${share(view.dominant.share)} of what was recorded · owned by ${view.dominant.owner}`
              }
            />
            <Stat
              label="Classes"
              value={String(view.classes.length)}
              sub="distinct kinds of fault in the window — each one a different person's job, and one number in the ledger"
            />
            <Stat
              label="Deployments"
              value={String(view.deployments.length)}
              sub={`recorded at least one · ${view.joinedDeployments} of them named by tonight's health reading${
                view.failingJoined > 0 ? `, ${view.failingJoined} of those failing now` : ''
              }`}
              tone={view.failingJoined > 0 ? 'bad' : undefined}
            />
            <Stat
              label="Aliases read"
              value={`${view.models.length}${view.skippedModels.length > 0 ? ` / ${view.models.length + view.skippedModels.length}` : ''}`}
              sub={
                view.skippedModels.length === 0
                  ? 'every model with usage in the window was asked about'
                  : `${view.skippedModels.length} not asked about — unread, not clean: ${view.skippedModels.slice(0, 3).join(', ')}${view.skippedModels.length > 3 ? ' …' : ''}`
              }
              tone={view.skippedModels.length === 0 ? undefined : 'warn'}
            />
          </div>

          <div className={styles.sectionTitle}>By class, and who owns it</div>
          <div className={styles.sectionSub}>
            shares are of the exceptions recorded, never of traffic — this table carries no
            denominator, which is exactly why the rate stays on the card above
          </div>

          <div className={styles.classes}>
            {view.classes.map((row) => (
              <ClassRow key={row.class} row={row} />
            ))}
          </div>

          <div className={styles.sectionTitle}>By deployment</div>
          <div className={styles.sectionSub}>
            the row key is a <em>deployment</em>, not an alias — the resolution the daily aggregates
            do not have and the one the health reading is keyed at, so a reserved-throughput pool
            refusing behind an alias that bills normally is finally visible as itself
          </div>

          <div className={styles.deployments}>
            {view.deployments.map((row) => (
              <DeploymentRow key={row.deployment} row={row} total={view.total} />
            ))}
          </div>

          <div className={styles.footer}>
            These are <strong>reasons, not counts</strong>. LiteLLM writes them to a table of its
            own, switchable with <code>disable_error_logs</code> and pruned on its own schedule, and
            the proxy's own <code>total_exceptions</code> field counts distinct classes rather than
            exceptions — so the totals here are ours, they are a floor, and they may disagree with
            the ledger in either direction. What they carry that no other surface does is the kind
            of fault: a quota, a credential, a cap this proxy enforces, a provider fault, or a
            caller sending something the model would not take.
          </div>
        </>
      )}
    </Card>
  );
}

function ClassRow({ row }: { row: ExceptionClassRow }) {
  return (
    <div className={styles.classRow}>
      <div className={styles.classHead}>
        <span className={styles.className}>{row.label}</span>
        <span className={styles.owner}>{row.owner}</span>
        <span className={styles.classCount}>{count(row.count)}</span>
        <span className={styles.classShare}>{share(row.share)}</span>
      </div>
      <div className={styles.bar}>
        <span className={styles.barFill} style={{ width: `${Math.max(1, row.share * 100)}%` }} />
      </div>
      <div className={styles.classSub}>
        {row.docs} · {row.deployments} deployment{row.deployments === 1 ? '' : 's'} ·{' '}
        {row.types.map((type) => `${type.type} ${compactCount(type.count)}`).join(' · ')}
      </div>
    </div>
  );
}

function DeploymentRow({ row, total }: { row: ExceptionDeploymentRow; total: number }) {
  return (
    <div className={styles.deployment}>
      <div className={styles.deploymentHead}>
        <span className={styles.deploymentKey} title={row.deployment}>
          {shorten(row.deployment)}
        </span>
        <span className={styles.alias}>{row.model}</span>
        <HealthFlag health={row.health} />
        <span className={styles.deploymentCount}>{count(row.total)}</span>
        <span className={styles.deploymentShare}>{share(row.share)}</span>
      </div>
      <div className={styles.bar}>
        <span
          className={styles.barFill}
          style={{ width: `${total === 0 ? 1 : Math.max(1, (row.total / total) * 100)}%` }}
        />
      </div>
      <div className={styles.deploymentSub}>
        {row.dominantClass !== null && row.dominantShare !== null && (
          <>
            mostly {row.dominantClass} ({share(row.dominantShare)})
            {' · '}
          </>
        )}
        {row.exceptions
          .slice(0, 4)
          .map((entry) => `${entry.type} ${compactCount(entry.count)}`)
          .join(' · ')}
        {row.healthError !== null && (
          <span className={styles.healthError}> · health says: {row.healthError}</span>
        )}
        {/*
          The proxy's own field, kept as evidence and never as a total: upstream
          it is a COUNT(*) over rows already grouped by class, so it reports how
          many *kinds* this deployment produced.
        */}
        {row.reportedTotal !== row.total && (
          <span className={styles.reported}>
            {' '}
            · proxy reports total_exceptions {row.reportedTotal} — that field counts classes
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * What tonight's health reading says about the same deployment.
 *
 * `unread` rather than a neutral blank: an absent health row means the reading
 * does not name this deployment — no reading taken, an alias outside the
 * catalogue, or a proxy that strips `api_base` so the key cannot be rebuilt —
 * and silence must not read as health.
 */
function HealthFlag({ health }: { health: ExceptionDeploymentRow['health'] }) {
  if (health === 'failing') {
    return <span className={cx(styles.health, styles.healthBad)}>failing now</span>;
  }
  if (health === 'healthy') {
    return <span className={cx(styles.health, styles.healthGood)}>healthy now</span>;
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
