import { FLAPPING_OUTAGES, STANDING_OUTAGE_READINGS, summarizeDeploymentHistory } from '@dash/shared';
import type {
  GatewayDeploymentHistory,
  GatewayDeploymentHistorySummary,
  GatewayDeploymentObservation,
  GatewayDeploymentUptime,
} from '@dash/shared';

/**
 * The nightly `/health` readings read as a sequence — what the snapshot card
 * structurally cannot say.
 *
 * `gatewayHealth.ts` renders one reading and is deliberately about that reading:
 * which pools are refusing, how old the answer is. It can say a deployment is
 * failing *tonight* and it can never say it has been failing all week, and those
 * are different findings with different owners — one is an evening's trouble
 * that will have cleared by morning, the other is a fault somebody has to route
 * around.
 *
 * Like `gatewayHealth.ts` this module adds **no rule about the gateway**:
 * `summarizeDeploymentHistory` in `@dash/shared` is the single statement of what
 * a run of readings may be read to mean (a run is broken by an observed recovery
 * and by nothing else; every figure is a count of readings; a deployment with no
 * reading is absent rather than healthy), and it is shared with the API's own
 * verification so the two cannot disagree. What is added here is only what the
 * *card* needs and what only the browser knows:
 *
 *  - **a spine to draw against**, clamped forward to `recordingSince`. There is
 *    no backfill for this table and never can be — the proxy serves current
 *    state only — so a 60-day window on a dashboard recording for four days is
 *    drawn as four days rather than as 56 empty ones.
 *  - **three states per cell, not two.** A day with no reading is a hole. Drawing
 *    it as healthy asserts a success nobody saw, which is the same invention as
 *    splitting a run there, and the strip is the one place a reader would never
 *    notice the difference.
 *  - **whether the window can express the layer's own finding at all.** Below
 *    `STANDING_OUTAGE_READINGS` recorded days, "nothing is standing" is a fact
 *    about how long we have been watching and not about the gateway — the same
 *    distinction `recordingSince` exists to keep open on the route.
 *
 * Nothing here converts readings to hours, days of downtime or an availability
 * percentage, for the reason stated on the table: a deployment can fail and
 * recover between two nightly readings and leave nothing behind, so a duration
 * would be an invention and a percentage would be a duration wearing a hat.
 */

/**
 * The window the card asks for.
 *
 * Two months: long enough that a standing fault, a recovery and a re-alias all
 * fit inside it, short enough that the payload stays deployments × days. It is
 * the route's own default, restated here because the card names it.
 */
export const HEALTH_HISTORY_DAYS = 60;

/** One deployment on one day of the drawn spine. Three states, never two. */
export type ReadingState = 'healthy' | 'failing' | 'unobserved';

export interface HealthHistoryCell {
  date: string;
  state: ReadingState;
  /** The proxy's own text on a failing reading. Null when healthy or unread. */
  error: string | null;
}

/**
 * What a deployment did across the window, as the card ranks it.
 *
 * `standing` is the layer's own finding and outranks everything: an open run
 * long enough that a single evening cannot explain it. `failing` is the same
 * shape with fewer readings behind it — real, but the snapshot already says so.
 * `flapping` sits below both because an intermittent deployment is answering
 * right now, and `recovered` / `past` are history rather than findings.
 */
export type DeploymentVerdict =
  | 'standing'
  | 'failing'
  | 'flapping'
  | 'recovered'
  | 'past'
  | 'clear';

export interface HealthHistoryRow extends GatewayDeploymentUptime {
  /** One cell per day of the drawn spine, ascending. */
  cells: HealthHistoryCell[];
  /** Days inside this deployment's *own* span carrying no reading of it. */
  unobservedDays: number;
  verdict: DeploymentVerdict;
  /** It is failing now and long enough that the run is a fault, not an evening. */
  isStanding: boolean;
}

/** Gateway-wide, aligned to the spine — so an unread day is a hole here too. */
export interface HealthHistoryDay {
  date: string;
  observed: boolean;
  deployments: number;
  unhealthy: number;
}

export interface HealthHistoryView {
  /** Whether the query has answered. False while it is in flight. */
  answered: boolean;
  /** Answered, and no reading has ever been filed. Not "everything is fine". */
  isEmpty: boolean;
  /**
   * Fewer than `STANDING_OUTAGE_READINGS` days carry a reading, so the strongest
   * statement this layer makes cannot be made yet whatever the gateway is doing.
   */
  tooShort: boolean;
  /** The shared derivation, verbatim. Every claim about the gateway lives here. */
  summary: GatewayDeploymentHistorySummary;
  /** The window asked for. */
  from: string;
  to: string;
  /** The window drawn — clamped forward to the first reading ever filed. */
  spineFrom: string;
  recordingSince: string | null;
  dates: string[];
  days: HealthHistoryDay[];
  /** Days of the drawn spine carrying at least one reading of anything. */
  daysRecorded: number;
  /** Days of the drawn spine carrying none — nights the sync did not file one. */
  daysMissed: number;
  rows: HealthHistoryRow[];
  standing: number;
  flapping: number;
  /** Healthy at the previous reading, failing at the newest. */
  newlyFailing: number;
  /** Failing at the previous reading, healthy at the newest. */
  recovered: number;
  /** Deployments whose alias changed inside the window. */
  renamed: number;
  /** Distinct runs across every deployment, from the shared derivation. */
  outages: number;
}

const EMPTY_SUMMARY: GatewayDeploymentHistorySummary = {
  from: '',
  to: '',
  recordingSince: null,
  observedDays: [],
  days: [],
  deployments: [],
  standing: [],
  flapping: [],
  outages: 0,
};

function shiftIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDiff(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00.000Z`).getTime();
  const b = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * Standing first, then anything failing now, then intermittence, then history.
 *
 * The order is the order somebody acts in, and it deliberately does not read
 * `failingShare`: a deployment failing at 100% of two readings is a smaller
 * finding than one failing at 40% of thirty, and the run lengths already say so.
 */
function verdictOf(row: GatewayDeploymentUptime): DeploymentVerdict {
  if (row.standing !== null && row.standing.readings >= STANDING_OUTAGE_READINGS) return 'standing';
  if (!row.lastHealthy) return 'failing';
  if (row.outages.length >= FLAPPING_OUTAGES) return 'flapping';
  if (row.recovered) return 'recovered';
  if (row.outages.length > 0) return 'past';
  return 'clear';
}

export function deriveHealthHistory(
  history: GatewayDeploymentHistory | null | undefined,
): HealthHistoryView {
  if (history === null || history === undefined) {
    return {
      answered: false,
      isEmpty: false,
      tooShort: false,
      summary: EMPTY_SUMMARY,
      from: '',
      to: '',
      spineFrom: '',
      recordingSince: null,
      dates: [],
      days: [],
      daysRecorded: 0,
      daysMissed: 0,
      rows: [],
      standing: 0,
      flapping: 0,
      newlyFailing: 0,
      recovered: 0,
      renamed: 0,
      outages: 0,
    };
  }

  const summary = summarizeDeploymentHistory(history);

  // The spine starts at the later of the window and the first reading ever
  // filed. Padding backwards would draw the weeks before this dashboard existed
  // as weeks nobody looked, which is true of the scheduler and misleading about
  // the gateway.
  const { from, to } = history;
  const recordingSince = history.recordingSince;
  const spineFrom = recordingSince !== null && recordingSince > from ? recordingSince : from;
  const dates: string[] = [];
  if (from !== '' && to !== '' && spineFrom <= to) {
    for (let date = spineFrom; date <= to; date = shiftIso(date, 1)) dates.push(date);
  }

  const observedDays = new Set(summary.observedDays);
  const dayByDate = new Map(summary.days.map((day) => [day.date, day]));
  const days: HealthHistoryDay[] = dates.map((date) => {
    const day = dayByDate.get(date);
    if (day === undefined) return { date, observed: false, deployments: 0, unhealthy: 0 };
    return { date, observed: true, deployments: day.deployments, unhealthy: day.unhealthy };
  });

  const byDeployment = new Map<string, Map<string, GatewayDeploymentObservation>>();
  for (const observation of history.observations) {
    const bucket = byDeployment.get(observation.id) ?? new Map();
    bucket.set(observation.date, observation);
    byDeployment.set(observation.id, bucket);
  }

  const rows: HealthHistoryRow[] = summary.deployments.map((deployment) => {
    const readings = byDeployment.get(deployment.id) ?? new Map();
    const cells: HealthHistoryCell[] = dates.map((date) => {
      const observation = readings.get(date);
      if (observation === undefined) return { date, state: 'unobserved', error: null };
      return {
        date,
        state: observation.healthy ? 'healthy' : 'failing',
        error: observation.healthy ? null : observation.error,
      };
    });

    // Counted over the deployment's own span rather than the window's: a
    // deployment the router only gained last Tuesday has no missing readings
    // before it existed, exactly as a key created last Tuesday has none on the
    // budget history card.
    const span = dayDiff(deployment.firstSeen, deployment.lastSeen) + 1;

    return {
      ...deployment,
      cells,
      unobservedDays: Math.max(0, span - deployment.readings),
      verdict: verdictOf(deployment),
      isStanding:
        deployment.standing !== null && deployment.standing.readings >= STANDING_OUTAGE_READINGS,
    };
  });

  return {
    answered: true,
    isEmpty: history.observations.length === 0,
    // A window that cannot hold a standing run says nothing about whether one
    // exists. The card leads with that rather than reporting a clean sheet.
    tooShort: observedDays.size < STANDING_OUTAGE_READINGS,
    summary,
    from,
    to,
    spineFrom,
    recordingSince,
    dates,
    days,
    daysRecorded: observedDays.size,
    daysMissed: dates.filter((date) => !observedDays.has(date)).length,
    rows,
    standing: summary.standing.length,
    flapping: summary.flapping.length,
    newlyFailing: rows.filter((row) => row.newlyFailing).length,
    recovered: rows.filter((row) => row.recovered).length,
    renamed: rows.filter((row) => row.renamed).length,
    outages: summary.outages,
  };
}

/** Whether the card has anything to draw at all. */
export function hasHealthHistory(view: HealthHistoryView): boolean {
  return view.answered && !view.isEmpty && view.rows.length > 0;
}
