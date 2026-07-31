import { summarizeDeploymentHealth } from '@dash/shared';
import type { GatewayDeployment, GatewayHealth, GatewayHealthSummary } from '@dash/shared';

/**
 * The stored `/health` reading, as the page reads it.
 *
 * Deliberately thin: the up/degraded/down rule lives in
 * `summarizeDeploymentHealth` in `@dash/shared` — one statement, read by the
 * API's own verification and by this card — and everything this module adds is
 * about the *reading* rather than about the proxy:
 *
 *  - **how old it is.** `/health` issues a live test call to every deployment
 *    while answering, which is why the sync takes it once a night and the API
 *    stores the answer instead of forwarding the route. A card that did not
 *    lead with the reading's age would be read as live, and a deployment that
 *    failed an hour ago is not on it.
 *  - **whether it was ever taken.** A backfill skips `/health` and its failure
 *    is swallowed rather than failing the sync, so "the proxy routes nothing"
 *    and "we have never asked" are genuinely different answers and must not
 *    collapse into one empty table — the same rule `checkedAt` follows on the
 *    route and `evaluatedAt` follows on the notifications one.
 *
 * `now` is a parameter rather than `Date.now()` so the derivation stays pure
 * and the staleness boundary is assertable.
 */

/**
 * Past this the reading stops describing the gateway and starts describing the
 * scheduler.
 *
 * The full sync runs once a day, so anything under ~24h is the ordinary state
 * of a working pipeline. 36 hours is one missed run plus the slack a retry
 * needs: it cannot fire on a healthy nightly cadence and it cannot stay quiet
 * through a scheduler that stopped.
 */
export const HEALTH_STALE_HOURS = 36;

export interface HealthView {
  /**
   * Whether `GET /api/gateway/health` has answered — a fact about this query,
   * not about the proxy. False while it is in flight.
   */
  answered: boolean;
  /** The alias-level reading. Empty (and harmless) until the query answers. */
  summary: GatewayHealthSummary;
  /** Every deployment as stored, so the card can name the ones that are failing. */
  deployments: readonly GatewayDeployment[];
  /** Hours since the reading was taken, null when there has never been one. */
  ageHours: number | null;
  /** The reading is older than a working nightly sync would leave it. */
  stale: boolean;
  /** Answered, but `/health` has never been read into the table. */
  neverChecked: boolean;
  /** Answered and read, and the router reports no deployment at all. */
  isEmpty: boolean;
}

const EMPTY_SUMMARY: GatewayHealthSummary = {
  checkedAt: null,
  deployments: 0,
  unhealthy: 0,
  models: [],
  down: [],
  degraded: [],
  providers: [],
  unnamed: 0,
};

export function deriveGatewayHealth(
  health: GatewayHealth | null | undefined,
  now: Date,
): HealthView {
  if (health === null || health === undefined) {
    return {
      answered: false,
      summary: EMPTY_SUMMARY,
      deployments: [],
      ageHours: null,
      stale: false,
      neverChecked: false,
      isEmpty: false,
    };
  }

  const summary = summarizeDeploymentHealth(health.deployments, health.checkedAt);
  const ageHours =
    health.checkedAt === null
      ? null
      : Math.max(0, (now.getTime() - new Date(health.checkedAt).getTime()) / 3_600_000);

  return {
    answered: true,
    summary,
    deployments: health.deployments,
    ageHours,
    stale: ageHours !== null && ageHours > HEALTH_STALE_HOURS,
    neverChecked: health.checkedAt === null,
    isEmpty: health.deployments.length === 0,
  };
}

/** The deployments behind one alias, in the order the card lists them: failing first. */
export function deploymentsOf(
  view: HealthView,
  model: string | null,
): readonly GatewayDeployment[] {
  return view.deployments
    .filter((deployment) => deployment.model === model)
    .slice()
    .sort((left, right) => {
      if (left.healthy !== right.healthy) return left.healthy ? 1 : -1;
      return left.backend.localeCompare(right.backend);
    });
}
