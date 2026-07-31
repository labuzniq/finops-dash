import { describeGatewayNotification } from '@dash/shared';
import type { GatewayNotification, GatewayNotifications } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { relativeTime } from '../../lib/format.js';
import { useGatewayNotifications } from '../../hooks/useGatewayData.js';
import styles from './GatewayAlertPanel.module.css';

/**
 * Gateway alerting, and whether it is actually reaching anybody.
 *
 * The gateway page's attention digest already lists every finding the page's
 * cards make — but only *on the page*, and only while somebody is looking at it.
 * Two of its sources do not need a browser, and it is the same property in both
 * cases: budgets and the nightly `/health` reading are *tables*, so the API
 * assesses them at the end of every full sync and can send what it finds
 * somewhere. This panel is the record of that: which findings are open, which
 * are new, and whether they left the building.
 *
 * The one thing it exists to make impossible is a silent alerting channel. An
 * unconfigured target is stated in the header rather than implied by an empty
 * list, and a finding that has been recorded but never delivered says so on its
 * own row — including the target's own error, because "the webhook 404s" and
 * "there is nothing to report" look identical in a quiet channel.
 *
 * Cleared episodes are listed beside open ones deliberately: one that opened and
 * closed between two visits is invisible in the budget card, whose snapshot has
 * already moved on, and it is exactly what "did anything happen last week" means.
 */

/** How far back a closed episode is still worth listing. */
const WINDOW_DAYS = 30;

/** Enough to read at a glance; the counts above stay whole. */
const MAX_ROWS = 12;

function Row({ notification }: { notification: GatewayNotification }) {
  const cleared = notification.clearedAt !== null;
  const delivery = cleared
    ? notification.deliveredAt === null
      ? 'Not sent'
      : 'Sent'
    : notification.deliveredAt === null
      ? notification.deliveryError === null
        ? 'Pending'
        : 'Failed'
      : 'Sent';

  return (
    <div className={styles.row}>
      <div
        className={cx(
          styles.dot,
          cleared && styles.dotCleared,
          !cleared && notification.severity === 'critical' && styles.dotCritical,
        )}
      />
      <div className={styles.rowBody}>
        <div className={cx(styles.summary, cleared && styles.summaryCleared)}>
          {describeGatewayNotification(notification)}
        </div>
        <div className={styles.meta}>
          {cleared
            ? `open ${relativeTime(notification.firstSeenAt)} → cleared ${relativeTime(
                notification.clearedAt ?? notification.lastSeenAt,
              )}`
            : `first seen ${relativeTime(notification.firstSeenAt)}`}
          {notification.deliveryAttempts > 0 &&
            ` · ${notification.deliveryAttempts} delivery attempt${
              notification.deliveryAttempts === 1 ? '' : 's'
            }`}
        </div>
        {notification.deliveryError !== null && !cleared && (
          <div className={styles.error}>{notification.deliveryError}</div>
        )}
      </div>
      <div
        className={cx(
          styles.delivery,
          delivery === 'Pending' && styles.deliveryPending,
          delivery === 'Failed' && styles.deliveryFailed,
          delivery === 'Not sent' && styles.deliveryPending,
        )}
      >
        {delivery}
      </div>
    </div>
  );
}

function Result({ data }: { data: GatewayNotifications }) {
  const rows = data.notifications.slice(0, MAX_ROWS);
  const hidden = data.notifications.length - rows.length;

  return (
    <div className={styles.result}>
      <div className={styles.stats}>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Open findings</div>
          <div className={styles.statValue}>{data.open}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Awaiting delivery</div>
          <div className={cx(styles.statValue, data.pending > 0 && styles.statValueWarn)}>
            {data.pending}
          </div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Last evaluated</div>
          <div className={styles.statValue}>
            {data.evaluatedAt === null ? 'Never' : relativeTime(data.evaluatedAt)}
          </div>
        </div>
      </div>

      {rows.length > 0 && (
        <div className={styles.rows}>
          {rows.map((notification) => (
            <Row key={notification.fingerprint} notification={notification} />
          ))}
        </div>
      )}

      {hidden > 0 && (
        <div className={styles.note}>
          {hidden} more finding{hidden === 1 ? '' : 's'} in the last {WINDOW_DAYS} days — the counts
          above are whole.
        </div>
      )}

      {data.notifications.length === 0 && (
        <div className={styles.note}>
          {data.evaluatedAt === null
            ? 'Nothing has been evaluated yet — it runs at the end of the next full sync.'
            : `Nothing over a cap, past a soft budget, pacing past one, or serving on fewer deployments than it has in the last ${WINDOW_DAYS} days.`}
        </div>
      )}

      {!data.deliveryConfigured && data.pending > 0 && (
        <div className={styles.note}>
          These are recorded but not sent. Set <code>GATEWAY_ALERT_WEBHOOK_URL</code> and they go out
          on the next sync — nothing found while it was unset is lost.
        </div>
      )}
    </div>
  );
}

export function GatewayAlertPanel({ enabled }: { enabled: boolean }) {
  const notifications = useGatewayNotifications(WINDOW_DAYS, enabled);

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.body}>
          <div className={styles.title}>Gateway alerts</div>
          <div className={styles.sub}>
            Every full sync assesses the budget snapshot and the deployment-health reading, and
            records what it finds — over a cap, blocked, past a soft budget, pacing past one, or an
            alias whose deployments are failing. Each finding is sent once; a counter climbing
            further is the same finding, and crossing into a worse state is a new one.
          </div>
        </div>
        <div
          className={cx(
            styles.target,
            !(notifications.data?.deliveryConfigured ?? false) && styles.targetOff,
          )}
        >
          {notifications.data?.deliveryConfigured ?? false ? 'Webhook set' : 'No target'}
        </div>
      </div>

      {notifications.error !== null && (
        <div className={styles.result}>
          <div className={styles.note}>
            {notifications.error instanceof Error
              ? notifications.error.message
              : 'Findings could not be read.'}
          </div>
        </div>
      )}
      {notifications.data !== undefined && <Result data={notifications.data} />}
    </div>
  );
}
