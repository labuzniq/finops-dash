import { GATEWAY_DIMENSION_LABELS, GATEWAY_PROBE_STATUS_LABELS } from '@dash/shared';
import type { GatewayProbe, GatewayProbeRoute, GatewayProbeStatus } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { relativeTime } from '../../lib/format.js';
import { useGatewayProbe } from '../../hooks/useGatewayData.js';
import styles from './GatewayProbePanel.module.css';

/**
 * The gateway's connection check, run on demand from Data sources.
 *
 * Every other affordance on this page reports the last *sync* — did the job
 * succeed, how long ago. This reports the *proxy*: which of LiteLLM's routes
 * the configured credential can actually reach right now, and which of the
 * dashboard's dimensions and cards that leaves with nothing to draw.
 *
 * It exists because the whole gateway integration is a draft written against
 * published docs. The two questions it answers first — is this key scoped to
 * the whole gateway or to one team, and will the proxy let it read the
 * management routes the budget card needs — currently have no answer anywhere
 * else in the product except by starting a 90-day sync and reading the job's
 * error string.
 *
 * Nothing here is stored. The panel is empty until someone presses the button,
 * and what it then shows is true of one moment.
 */

/** Warnings on a working gateway; failures where a required route is out. */
function toneFor(status: GatewayProbeStatus): 'ok' | 'warn' | 'bad' {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'empty':
    case 'absent':
      return 'warn';
    case 'denied':
    case 'malformed':
    case 'unreachable':
      return 'bad';
  }
}

function RouteRow({ route }: { route: GatewayProbeRoute }) {
  const tone = toneFor(route.status);
  return (
    <div className={styles.route}>
      <div
        className={cx(
          styles.dot,
          tone === 'ok' && styles.dotOk,
          tone === 'warn' && styles.dotWarn,
          tone === 'bad' && styles.dotBad,
        )}
      />
      <div className={styles.routeBody}>
        <div className={styles.routeHead}>
          <span className={styles.path}>{route.path}</span>
          {route.required && <span className={styles.required}>required</span>}
          <span className={styles.duration}>{route.durationMs} ms</span>
        </div>
        {route.detail !== null && <div className={styles.detail}>{route.detail}</div>}
        {route.dimensions.length > 0 && (
          <div className={styles.dimensions}>
            {route.dimensions.map((coverage) => (
              <span
                key={coverage.dimension}
                className={cx(
                  styles.dimension,
                  coverage.keys === 0 && coverage.expected && styles.dimensionMissing,
                )}
              >
                {GATEWAY_DIMENSION_LABELS[coverage.dimension]} · {coverage.keys}
              </span>
            ))}
          </div>
        )}
      </div>
      <div
        className={cx(
          styles.status,
          tone === 'warn' && styles.statusWarn,
          tone === 'bad' && styles.statusBad,
        )}
      >
        {GATEWAY_PROBE_STATUS_LABELS[route.status]}
        {route.httpStatus !== null && <span className={styles.code}> {route.httpStatus}</span>}
      </div>
    </div>
  );
}

function Result({ probe }: { probe: GatewayProbe }) {
  return (
    <div className={styles.result}>
      <div className={styles.verdictRow}>
        <div className={cx(styles.verdict, !probe.usable && styles.verdictBad)}>
          {probe.usable ? 'Can sync' : 'Cannot sync'}
        </div>
        <div className={styles.meta}>
          {probe.target ?? 'no target'}
          {probe.probedDay !== null && ` · probed ${probe.probedDay}`} ·{' '}
          {relativeTime(probe.checkedAt)}
        </div>
      </div>

      {probe.routes.length > 0 && (
        <div className={styles.routes}>
          {probe.routes.map((route) => (
            <RouteRow key={route.path} route={route} />
          ))}
        </div>
      )}

      {probe.warnings.length > 0 && (
        <ul className={styles.warnings}>
          {probe.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      {probe.usable && probe.warnings.length === 0 && (
        <div className={styles.clean}>
          Every route answered and every dimension carried keys — the gateway page will render in
          full.
        </div>
      )}
    </div>
  );
}

export function GatewayProbePanel({ enabled }: { enabled: boolean }) {
  const probe = useGatewayProbe();

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.body}>
          <div className={styles.title}>Connection check</div>
          <div className={styles.sub}>
            Calls every route the sync depends on once, for yesterday, and reports what each
            answered. Reads nothing from the database and stores nothing.
          </div>
        </div>
        <button
          type="button"
          className={styles.run}
          onClick={() => void probe.refetch()}
          disabled={!enabled || probe.isFetching}
        >
          {probe.isFetching ? 'Checking…' : 'Test connection'}
        </button>
      </div>

      {probe.error !== null && (
        <div className={styles.failed}>
          {probe.error instanceof Error ? probe.error.message : 'The check could not be run.'}
        </div>
      )}
      {probe.data !== undefined && <Result probe={probe.data} />}
    </div>
  );
}
