import { cx } from '../../lib/cx.js';
import { relativeTime } from '../../lib/format.js';
import { deploymentsOf, HEALTH_STALE_HOURS } from '../../lib/metrics/gatewayHealth.js';
import type { HealthView } from '../../lib/metrics/gatewayHealth.js';
import { Card } from '../Card.js';
import styles from './GatewayHealthCard.module.css';

/**
 * Which deployments behind each alias are answering.
 *
 * This is the only card on the page keyed *below* the model alias, and the only
 * one that can produce a **degraded** finding: LiteLLM fails over silently
 * between the deployments behind one alias, so an alias with a dead region
 * bills normally, fails nothing, and is invisible on every other card here. A
 * **down** alias the usage payload does eventually show — as failures,
 * tomorrow — which makes this the earlier of the two answers rather than the
 * only one.
 *
 * Two things the card must not do:
 *
 *  - **present itself as live.** The reading is taken once a night, because
 *    `/health` issues a real test call to every deployment while answering. The
 *    age is therefore the first thing on the card and not a footnote, and a
 *    reading older than a working sync would leave it says so.
 *  - **read an empty table as health.** A backfill skips `/health` and a failed
 *    read is swallowed rather than failing the sync, so "no deployment is
 *    failing" and "nobody has ever asked" are different answers. The second one
 *    is not this card at all: the page stands it down and the digest above
 *    names the unread route, because a card claiming "all up" over a reading
 *    nobody took is the one way this feature could mislead.
 */

interface GatewayHealthCardProps {
  view: HealthView;
}

/** Longer than this and the error text is the card rather than a line on it. */
const MAX_ERROR = 160;

const STATE_LABEL = { down: 'down', degraded: 'degraded', up: 'up' } as const;

function shorten(error: string): string {
  return error.length <= MAX_ERROR ? error : `${error.slice(0, MAX_ERROR - 1)}…`;
}

export function GatewayHealthCard({ view }: GatewayHealthCardProps) {
  const { summary } = view;
  const failing = summary.down.length + summary.degraded.length;
  const healthyProviders = summary.providers.filter((row) => row.unhealthy === 0).length;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Deployment health</div>
          <div className={styles.sub}>
            one row per public alias, over the deployments the router has behind it · the proxy
            fails over between them silently, so an alias that has lost a region still bills and
            still succeeds — this is the only place that shows
          </div>
        </div>
        <div className={styles.headline}>
          <div
            className={cx(
              styles.headlineValue,
              summary.down.length > 0 && styles.bad,
              summary.down.length === 0 && summary.degraded.length > 0 && styles.warn,
              failing === 0 && styles.good,
            )}
          >
            {failing === 0 ? 'all up' : `${failing} alias${failing === 1 ? '' : 'es'}`}
          </div>
          {/*
            The age is the first thing on the card rather than a footnote. The
            page renders this card only on a reading that exists, so `checkedAt`
            is present here by construction — a gateway nobody has ever asked
            about is a blind spot on the digest above, not an empty table.
          */}
          <div className={styles.headlineNote}>
            read {summary.checkedAt === null ? 'never' : relativeTime(summary.checkedAt)} · a
            nightly reading, not a live one
            {view.stale && (
              <span className={styles.staleFlag}>
                {' '}
                · older than {HEALTH_STALE_HOURS}h, so a deployment that has failed since is not on
                this list
              </span>
            )}
          </div>
        </div>
      </div>

      <div className={styles.stats}>
        <Stat
          label="Down"
          value={String(summary.down.length)}
          sub={
            summary.down.length === 0
              ? 'no alias has lost every deployment behind it'
              : 'nothing routed to these can succeed — the usage payload will show it as failures tomorrow'
          }
          tone={summary.down.length === 0 ? 'good' : 'bad'}
        />
        <Stat
          label="Degraded"
          value={String(summary.degraded.length)}
          sub={
            summary.degraded.length === 0
              ? 'every alias with a healthy deployment has all of them'
              : 'still answering on their remaining deployments, so they bill normally and fail nothing'
          }
          tone={summary.degraded.length === 0 ? 'good' : 'warn'}
        />
        <Stat
          label="Deployments"
          value={`${summary.deployments - summary.unhealthy}/${summary.deployments}`}
          sub={`answering, across ${summary.providers.length} backend${
            summary.providers.length === 1 ? '' : 's'
          } · ${healthyProviders} with nothing failing`}
        />
        <Stat
          label="Unnamed"
          value={summary.unnamed === 0 ? 'none' : String(summary.unnamed)}
          sub={
            summary.unnamed === 0
              ? 'every deployment resolves to an alias in the price catalogue'
              : 'the catalogue names no alias for these, so they are counted rather than filed under a near-match'
          }
          tone={summary.unnamed === 0 ? 'good' : undefined}
        />
      </div>

      <div className={styles.providers}>
        {summary.providers.map((provider) => (
          <div
            key={provider.provider ?? '(unknown)'}
            className={cx(styles.provider, provider.unhealthy > 0 && styles.providerBad)}
          >
            <span className={styles.providerName}>{provider.provider ?? 'unknown backend'}</span>
            <span className={styles.providerCount}>
              {provider.deployments - provider.unhealthy}/{provider.deployments} up
            </span>
          </div>
        ))}
      </div>

      <div className={cx(styles.row, styles.headerStrip)}>
        <div>ALIAS</div>
        <div>BACKENDS</div>
        <div className={styles.right}>DEPLOYMENTS</div>
      </div>

      {summary.models.map((model) => {
        const deployments = deploymentsOf(view, model.model);
        return (
          <div
            key={model.model ?? '(unnamed)'}
            className={cx(
              styles.row,
              model.state === 'down' && styles.rowDown,
              model.state === 'degraded' && styles.rowDegraded,
            )}
          >
            <div className={styles.name}>
              <span className={styles.key}>
                {model.model ?? <span className={styles.muted}>unnamed deployments</span>}
              </span>
              <span className={styles.sublabel}>
                <span
                  className={cx(
                    styles.badge,
                    model.state === 'down' && styles.badgeBad,
                    model.state === 'degraded' && styles.badgeWarn,
                  )}
                >
                  {STATE_LABEL[model.state]}
                </span>
                {model.providers.length > 0 && <>{model.providers.join(' · ')}</>}
              </span>
            </div>

            <div className={styles.detail}>
              {deployments.map((deployment) => (
                <div key={deployment.id} className={styles.deployment}>
                  <span
                    className={cx(styles.dot, deployment.healthy ? styles.dotUp : styles.dotDown)}
                  />
                  <span className={styles.backend} title={deployment.apiBase ?? deployment.backend}>
                    {deployment.backend}
                  </span>
                  {!deployment.healthy && (
                    <span className={styles.error}>
                      {deployment.errorStatus !== null && (
                        <span className={styles.status}>{deployment.errorStatus}</span>
                      )}
                      {deployment.error === null
                        ? 'no error text — the proxy is configured to strip it'
                        : shorten(deployment.error)}
                    </span>
                  )}
                </div>
              ))}
            </div>

            <div className={styles.right}>
              {model.deployments - model.unhealthy}/{model.deployments}
              <span className={styles.share}>
                {model.unhealthy === 0
                  ? 'answering'
                  : `${model.unhealthy} failing${model.providers.length > 1 ? ' · cross-cloud alias' : ''}`}
              </span>
            </div>
          </div>
        );
      })}

      <div className={styles.footer}>
        The reading is taken by the nightly sync and stored, never fetched when this page opens:
        without <code>background_health_checks</code> the proxy issues a live test call to every
        deployment while answering <code>/health</code>, so pressing it costs a token per deployment.
        An alias is <strong>down</strong> only when every deployment behind it is failing, and{' '}
        <strong>degraded</strong> when some are — the second is the finding nothing else on this
        page can make. The alias itself is resolved through the price catalogue rather than reported
        by <code>/health</code>, which names routing strings only.
      </div>
    </Card>
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
  // absent case has to be spelled out rather than omitted.
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
