import {
  GATEWAY_BUDGET_ALERT_SEVERITY,
  GATEWAY_BUDGET_SCOPE_LABELS,
  GATEWAY_DIMENSION_LABELS,
} from '@dash/shared';
import type { GatewayCoverage, GatewayDimension } from '@dash/shared';
import { compactCount, count, isoDateLabel, percent, usd } from '../format.js';
import type { SpendAnomaly } from './gatewayAnomaly.js';
import type { BudgetHistorySummary } from './gatewayBudgetHistory.js';
import type { BudgetRow, BudgetSummary } from './gatewayBudgets.js';
import type { CacheSummary } from './gatewayCache.js';
import { HEALTH_STALE_HOURS } from './gatewayHealth.js';
import type { HealthView } from './gatewayHealth.js';
import type { ReliabilitySummary } from './gatewayReliability.js';

/**
 * What on this page needs somebody, in one list.
 *
 * The gateway page now carries fifteen cards, each of which decides for itself
 * what is worth flagging — a budget past its cap, a day that ran away from its
 * trailing median, a key failing above the gateway rate, an alias serving on
 * fewer deployments than it has, a workload writing to a cache it never reads,
 * a fortnight the scheduler missed. Every one
 * of those findings is already derived and already on screen, and every one of
 * them is below the fold. This module reads the *derived summaries* and puts
 * their findings in one place at the top.
 *
 * The load-bearing rule is that **the digest adds no threshold of its own.**
 * It never re-reads the payload, never re-detects anything, and never decides a
 * key is interesting: it can only surface a state a source module has already
 * flagged, in that module's own words and with that module's own numbers. A
 * digest that could disagree with the card it points at would be worse than no
 * digest — the reader would have two answers and no way to choose. That is also
 * what makes the list verifiable: every alert must trace back to a row of the
 * summary it came from, and no flagged row may be missing from it.
 *
 * Severity is therefore an editorial mapping from a state to an urgency, not a
 * second test:
 *
 *  - `critical` — calls are being rejected, or money is already past a line
 *    somebody drew. Nothing gets more urgent by waiting; it is already spent.
 *  - `warning` — something happened that a person has to decide about: a day
 *    that overran, a key failing materially above the gateway, a gap a sync can
 *    still fill, a counter pacing past its cap.
 *  - `info` — a standing inefficiency with no deadline. A churning cache costs
 *    money every day and will cost the same tomorrow.
 *
 * Three things the digest deliberately does not do:
 *
 *  - **It carries no total.** The dollars on these rows come from different
 *    denominators — a budget row's counter covers that row's own period, an
 *    anomaly's excess covers one day, a cache row is not dollars at all — so
 *    there is no sum to take, exactly as on the budget card. It counts findings.
 *  - **It does not merge findings about the same key.** A key over its budget
 *    that also failed a lot is two facts with two fixes, and folding them into
 *    one row would hide one of them.
 *  - **It does not read silence as health.** Every input that could not be
 *    checked — a proxy that refused the management routes, a history too short
 *    to show a crossing, coverage that has not answered — is reported as a blind
 *    spot beside the list, because "nothing to report" and "nothing was read"
 *    look identical in an empty list and mean opposite things.
 */

export type AlertSeverity = 'critical' | 'warning' | 'info';

/** Which card explains the finding — what the row scrolls to. */
export type AlertSource = 'budget' | 'anomaly' | 'reliability' | 'cache' | 'coverage' | 'health';

export type AlertKind =
  | 'budget-blocked'
  | 'budget-over'
  | 'budget-soft'
  | 'budget-pacing'
  | 'budget-crossed'
  | 'deployment-down'
  | 'spend-anomaly'
  | 'reliability-elevated'
  | 'deployment-degraded'
  | 'coverage-gap'
  | 'cache-churn'
  | 'coverage-pruned';

/**
 * Editorial order, and the order findings are generated in.
 *
 * Within one severity band the list follows this order and then each source
 * module's own ranking, which is deliberate: those rankings were chosen for
 * their own card (budget rows by share of cap, anomalies by dollars overrun,
 * reliability keys by excess failures) and re-ranking them here would be the
 * digest forming an opinion the cards do not share.
 */
export const KIND_ORDER: readonly AlertKind[] = [
  'budget-blocked',
  'budget-over',
  'budget-soft',
  'budget-pacing',
  'budget-crossed',
  'deployment-down',
  'spend-anomaly',
  'reliability-elevated',
  'deployment-degraded',
  'coverage-gap',
  'cache-churn',
  'coverage-pruned',
];

export const KIND_SEVERITY: Record<AlertKind, AlertSeverity> = {
  // The four governance kinds take their severity from `@dash/shared`, because
  // the API derives the same four from the same snapshot after every sync and
  // delivers them off the page. A mailed alert and the card it names must not
  // disagree about how urgent the same state is.
  ...GATEWAY_BUDGET_ALERT_SEVERITY,
  'budget-crossed': 'warning',
  // An alias with no deployment left answering is rejecting calls right now,
  // which is the same urgency as a key the proxy is refusing on its budget.
  'deployment-down': 'critical',
  'spend-anomaly': 'warning',
  'reliability-elevated': 'warning',
  // Degraded is a capacity finding: the alias still answers, so nothing is
  // failing and somebody has to decide whether the remaining deployments carry
  // the load.
  'deployment-degraded': 'warning',
  'coverage-gap': 'warning',
  'cache-churn': 'info',
  'coverage-pruned': 'info',
};

const KIND_SOURCE: Record<AlertKind, AlertSource> = {
  'budget-blocked': 'budget',
  'budget-over': 'budget',
  'budget-soft': 'budget',
  'budget-pacing': 'budget',
  'budget-crossed': 'budget',
  'deployment-down': 'health',
  'deployment-degraded': 'health',
  'spend-anomaly': 'anomaly',
  'reliability-elevated': 'reliability',
  'coverage-gap': 'coverage',
  'cache-churn': 'cache',
  'coverage-pruned': 'coverage',
};

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

export interface GatewayAlert {
  /** Stable across re-derivations of the same state — the list's React key. */
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  source: AlertSource;
  /**
   * What the finding is about, in the source's own identifier: a budget key, an
   * ISO date, a breakdown key. Never formatted — the card renders `label` and
   * this is what a reader would search the card below for.
   */
  subject: string;
  /** Resolved alias where the source had one; null renders the subject alone. */
  label: string | null;
  /** The finding, short enough to scan a column of them. */
  title: string;
  /** The numbers behind it, taken verbatim from the source summary. */
  detail: string;
}

export interface GatewayAlertDigest {
  /** Worst first, capped — see `truncated`. */
  alerts: GatewayAlert[];
  critical: number;
  warning: number;
  info: number;
  /** Findings, not dollars. There is no dollar total on this card by design. */
  total: number;
  /** Findings held back by the cap. The count stays complete; the list is a sample. */
  truncated: number;
  /**
   * The dimension the reliability and cache findings were read through.
   *
   * Those two cards follow the page's breakdown switcher, so the digest does
   * too, and switching it can legitimately change which keys are named. Saying
   * so is the difference between a list that looks unstable and one that is
   * scoped.
   */
  dimension: GatewayDimension;
  /** Inputs that could not be read. An empty list beside a full one is an all-clear; beside this it is not. */
  blindSpots: string[];
  /** Nothing to report *and* nothing unchecked. */
  allClear: boolean;
}

export interface AlertInputs {
  budgets: BudgetSummary;
  /** False while the budgets query is still in flight — unanswered is a blind spot, not an all-clear. */
  budgetsLoaded: boolean;
  history: BudgetHistorySummary;
  anomalies: readonly SpendAnomaly[];
  reliability: ReliabilitySummary;
  cache: CacheSummary;
  /** Null until `GET /api/gateway/coverage` answers. */
  coverage: GatewayCoverage | null;
  /**
   * The stored `/health` reading, already derived.
   *
   * Unlike every other source here this one is a *snapshot* rather than a read
   * of the window on screen, so its findings do not move when the range picker
   * does — and its age is a blind spot rather than a finding, because a stale
   * reading says nothing about the gateway and everything about the sync.
   */
  health: HealthView;
}

export interface AlertOptions {
  /**
   * How many findings the list shows.
   *
   * A digest that runs to forty rows is the page it was meant to summarise. The
   * count is kept whole in `total` and the remainder in `truncated`, so the cap
   * costs the reader visibility and never accuracy — the same rule the coverage
   * note's gap sample follows.
   */
  maxAlerts: number;
}

export const DEFAULT_ALERT_OPTIONS: AlertOptions = { maxAlerts: 12 };

function alert(
  kind: AlertKind,
  subject: string,
  label: string | null,
  title: string,
  detail: string,
): GatewayAlert {
  return {
    id: `${kind}:${subject}`,
    kind,
    severity: KIND_SEVERITY[kind],
    source: KIND_SOURCE[kind],
    subject,
    label,
    title,
    detail,
  };
}

/** `Data Platform (api key)` — who is over, and in which scope. */
function budgetSubjectLabel(row: BudgetRow): string {
  const scope = GATEWAY_BUDGET_SCOPE_LABELS[row.budget.scope].toLowerCase();
  return `${row.budget.label ?? row.budget.key} · ${scope}`;
}

/** `$3,214.90 of $3,000 (107%)` — the row's own period, never compared to another's. */
function capPhrase(row: BudgetRow): string {
  const cap = row.budget.maxBudget;
  const spend = usd(row.budget.spend, 2);
  if (cap === null) return `${spend} spent, no cap configured`;
  const share = row.utilization === null ? '' : ` (${percent(row.utilization)})`;
  return `${spend} of ${usd(cap, 2)}${share}`;
}

/**
 * Governance findings, in the order the budget card itself ranks them.
 *
 * A row contributes at most one *state* finding (what it is now) and at most one
 * *pace* finding (where it is heading). The two are different claims — being
 * past an owner's soft budget is a fact, pacing past the hard cap is a
 * projection — and a row can honestly carry both.
 */
function fromBudgets(summary: BudgetSummary): GatewayAlert[] {
  const alerts: GatewayAlert[] = [];

  for (const scope of summary.scopes) {
    for (const row of scope.rows) {
      const subject = `${row.budget.scope}:${row.budget.key}`;
      const label = budgetSubjectLabel(row);

      if (row.state === 'blocked') {
        alerts.push(
          alert(
            'budget-blocked',
            subject,
            label,
            'Rejecting every call',
            row.blockReason === 'zero-cap'
              ? 'Budgeted at $0.00, which the proxy enforces as a block rather than a budget.'
              : 'Administratively disabled on the proxy — no call gets through regardless of budget.',
          ),
        );
      } else if (row.state === 'over') {
        alerts.push(
          alert(
            'budget-over',
            subject,
            label,
            'Over its budget',
            // The window the counter covers differs by scope, and a digest that
            // says "this period" over a counter that has never reset would be
            // making a claim the card it points at does not make.
            `${capPhrase(row)} ${row.spendIsCumulative ? 'since it was created; the proxy does not reset this counter, so it stays refused.' : 'this period.'}`,
          ),
        );
      } else if (row.state === 'soft') {
        alerts.push(
          alert(
            'budget-soft',
            subject,
            label,
            'Past its soft budget',
            `${capPhrase(row)} — past the ${usd(row.budget.softBudget ?? 0, 2)} alert threshold its owner set.`,
          ),
        );
      }

      // Pacing is only a finding while the cap has not been reached: a row
      // already over does not need to be told where it is heading.
      if (row.projectedOverrun && row.state !== 'over' && row.state !== 'blocked') {
        alerts.push(
          alert(
            'budget-pacing',
            subject,
            label,
            'Pacing past its cap',
            `${capPhrase(row)} at ${percent((row.periodElapsed ?? 0) * 100)} of the period — ${usd(
              row.projectedSpend ?? 0,
              2,
            )} if this pace holds.`,
          ),
        );
      }
    }
  }

  return alerts;
}

/**
 * Crossings seen on a previous day that today's snapshot no longer shows.
 *
 * This is the whole reason the history table exists: a counter that rolled over
 * a cap last Tuesday reads as a comfortable 12% today, and the only evidence it
 * was ever over is a reading nobody looks at. A row that is *currently* over is
 * deliberately skipped — the state finding above already says so, and saying it
 * twice would be the digest disagreeing with itself about how many problems
 * there are.
 */
function fromHistory(history: BudgetHistorySummary, budgets: BudgetSummary): GatewayAlert[] {
  const currentlyFlagged = new Set<string>();
  for (const scope of budgets.scopes) {
    for (const row of scope.rows) {
      if (row.state === 'over' || row.state === 'blocked') {
        currentlyFlagged.add(`${row.budget.scope}:${row.budget.key}`);
      }
    }
  }

  const alerts: GatewayAlert[] = [];
  for (const row of history.rows) {
    const subject = `${row.scope}:${row.key}`;
    if (currentlyFlagged.has(subject)) continue;

    // The most recent crossing only. Every one of them is the same finding
    // about the same object, and the newest is the one worth acting on.
    const crossing = [...row.events].reverse().find((event) => event.kind === 'over');
    if (crossing === undefined) continue;

    const scope = GATEWAY_BUDGET_SCOPE_LABELS[row.scope].toLowerCase();
    alerts.push(
      alert(
        'budget-crossed',
        subject,
        `${row.label ?? row.key} · ${scope}`,
        'Went over its cap while we were watching',
        `Seen at ${percent(crossing.to ?? 100)} of its cap on ${isoDateLabel(
          crossing.date,
        )}; it is not over now.`,
      ),
    );
  }

  return alerts;
}

function fromAnomalies(anomalies: readonly SpendAnomaly[]): GatewayAlert[] {
  return anomalies.map((anomaly) =>
    alert(
      'spend-anomaly',
      anomaly.date,
      isoDateLabel(anomaly.date),
      'Spend ran away from its baseline',
      `${usd(anomaly.spend, 2)} against a usual ${usd(anomaly.baseline, 2)} — ${usd(
        anomaly.excess,
        2,
      )} over, ${percent(anomaly.excessShare * 100)} above the trailing median.`,
    ),
  );
}

function fromReliability(summary: ReliabilitySummary): GatewayAlert[] {
  const dimension = GATEWAY_DIMENSION_LABELS[summary.dimension].toLowerCase();
  const gatewayRate = summary.failureRate === null ? null : percent(summary.failureRate * 100);

  return summary.rows
    .filter((row) => row.elevated)
    .map((row) =>
      alert(
        'reliability-elevated',
        `${summary.dimension}:${row.key}`,
        `${row.label ?? row.key} · ${dimension}`,
        'Failing above the gateway rate',
        `${percent((row.failureRate ?? 0) * 100)} of ${compactCount(row.requests)} calls failed${
          gatewayRate === null ? '' : `, against ${gatewayRate} gateway-wide`
        } — ${count(row.failedRequests)} failures, ${count(
          Math.round(row.excessFailures),
        )} more than this traffic should have produced.`,
      ),
    );
}

/**
 * Workloads writing to a prompt cache they do not read back.
 *
 * Info rather than warning on purpose: nothing is broken, nobody is blocked,
 * and it will cost exactly the same tomorrow. It is on the list at all because
 * it is invisible everywhere else — a churning key reads as busy on every
 * spend-shaped card on the page.
 */
function fromCache(summary: CacheSummary): GatewayAlert[] {
  const dimension = GATEWAY_DIMENSION_LABELS[summary.dimension].toLowerCase();

  return summary.rows
    .filter((row) => row.state === 'churning')
    .map((row) =>
      alert(
        'cache-churn',
        `${summary.dimension}:${row.key}`,
        `${row.label ?? row.key} · ${dimension}`,
        'Writing more cache than it reads',
        `${(row.reusePerWrite ?? 0).toFixed(2)} tokens read per token written — below the point where a cache pays for itself. ${compactCount(
          row.uncachedTokens,
        )} input tokens billed at the full rate.`,
      ),
    );
}

/**
 * Aliases that have lost deployments, in `summarizeDeploymentHealth`'s own order.
 *
 * The two states are two different findings rather than one severity scale.
 * **Down** is calls being rejected now — the usage payload will show it as
 * failures tomorrow, so the digest is merely the earlier answer. **Degraded**
 * is the answer nothing else on the page has at all: the alias still serves on
 * the deployments that are left, bills normally and fails nothing, so no
 * spend-shaped or failure-shaped card can see it.
 *
 * The unnamed bucket is deliberately eligible: a deployment the catalogue could
 * not name is still a deployment that is failing, and filing it under a
 * near-match is the one thing the health table refuses to do.
 */
function fromHealth(view: HealthView): GatewayAlert[] {
  if (!view.answered || view.neverChecked) return [];

  const alerts: GatewayAlert[] = [];
  const name = (model: string | null): string => model ?? 'unnamed deployments';
  const errors = (model: { errors: string[] }): string =>
    model.errors.length === 0
      ? 'The proxy reported no error text — it is configured to strip the detail.'
      : model.errors[0] ?? '';

  for (const model of view.summary.down) {
    alerts.push(
      alert(
        'deployment-down',
        `model:${name(model.model)}`,
        `${name(model.model)} · deployment`,
        'Every deployment behind it is failing',
        `${model.deployments} of ${model.deployments} failing across ${
          model.providers.length === 0 ? 'an unknown backend' : model.providers.join(', ')
        }. ${errors(model)}`,
      ),
    );
  }

  for (const model of view.summary.degraded) {
    alerts.push(
      alert(
        'deployment-degraded',
        `model:${name(model.model)}`,
        `${name(model.model)} · deployment`,
        'Serving on fewer deployments than it has',
        `${model.unhealthy} of ${model.deployments} failing; the alias still answers on the rest, so it bills normally and fails nothing. ${errors(model)}`,
      ),
    );
  }

  return alerts;
}

/**
 * Days the record is missing, split by whether anything can still be done.
 *
 * The split is the finding: a run newer than the retention floor is a Fill
 * button on the coverage note, and a run older than it is gone from the proxy
 * for good. They are the same hole in the data and completely different work.
 */
function fromCoverage(coverage: GatewayCoverage | null): GatewayAlert[] {
  if (coverage === null || coverage.missingDays === 0) return [];

  const fillable = coverage.gaps.filter((gap) => gap.to >= coverage.retentionFloor);
  const pruned = coverage.gaps.filter((gap) => gap.to < coverage.retentionFloor);
  const alerts: GatewayAlert[] = [];

  if (fillable.length > 0) {
    const days = fillable.reduce((total, gap) => total + gap.days, 0);
    alerts.push(
      alert(
        'coverage-gap',
        'fillable',
        null,
        'Days missing that a sync can still fill',
        `${days} day${days === 1 ? '' : 's'} across ${fillable.length} run${
          fillable.length === 1 ? '' : 's'
        } carry no rows — they draw as zero on every chart above. The newest starts ${
          fillable[0]?.from ?? ''
        }.`,
      ),
    );
  }

  if (pruned.length > 0) {
    const days = pruned.reduce((total, gap) => total + gap.days, 0);
    alerts.push(
      alert(
        'coverage-pruned',
        'pruned',
        null,
        'Days missing that the proxy has pruned',
        `${days} day${days === 1 ? '' : 's'} predate ${
          coverage.retentionFloor
        } and no longer exist upstream. They will stay zero.`,
      ),
    );
  }

  return alerts;
}

/**
 * What the digest could not check.
 *
 * Each entry names an input, not a suspicion. The point is that a reader who
 * sees a short list can tell whether the gateway is quiet or whether half of it
 * was unreadable — those two produce the same empty list.
 */
function blindSpotsOf(inputs: AlertInputs): string[] {
  const spots: string[] = [];

  if (!inputs.budgetsLoaded) {
    spots.push('Governance state has not answered yet — no cap, block or pace was checked.');
  } else if (inputs.budgets.isEmpty) {
    spots.push(
      'The proxy reported no governed object at all. A refused management route and a gateway with no caps look identical from here.',
    );
  }

  if (!inputs.budgets.isEmpty) {
    if (inputs.history.isEmpty) {
      spots.push(
        'No budget readings have been recorded yet, so a counter that went over and rolled back cannot be seen.',
      );
    } else if (inputs.history.tooShort) {
      spots.push(
        `Budget history holds ${inputs.history.daysRecorded} day${
          inputs.history.daysRecorded === 1 ? '' : 's'
        } of readings — too few to show a crossing that has since rolled.`,
      );
    }
  }

  if (inputs.coverage === null) {
    spots.push('Stored coverage has not answered, so missing days are unchecked.');
  }

  if (inputs.reliability.requests === 0) {
    spots.push('No requests in this range, so nothing was read for reliability.');
  }

  // Health is the one source whose *age* matters: it is a nightly snapshot of
  // something that can change in minutes, so an old reading is unread rather
  // than reassuring. A never-taken reading and a stale one are the same
  // consequence — nobody knows which deployments are answering right now.
  if (!inputs.health.answered) {
    spots.push('Deployment health has not answered yet — no alias was checked for lost capacity.');
  } else if (inputs.health.neverChecked) {
    spots.push(
      'No /health reading has ever been stored, so an alias failing over silently onto its last deployment cannot be seen.',
    );
  } else if (inputs.health.stale) {
    spots.push(
      `The deployment reading is over ${HEALTH_STALE_HOURS}h old — a deployment that has failed since is not on this list.`,
    );
  } else if (inputs.health.isEmpty) {
    spots.push(
      'The proxy reported no deployment at all, so nothing was checked for lost capacity.',
    );
  }

  return spots;
}

/**
 * Every finding the page's own cards have already made, worst first.
 *
 * Takes derived summaries rather than the payload on purpose — see the module
 * comment. Adding a source here means adding a mapping from a state that source
 * already flags, and never a new test.
 */
export function buildGatewayAlerts(
  inputs: AlertInputs,
  options: Partial<AlertOptions> = {},
): GatewayAlertDigest {
  const { maxAlerts } = { ...DEFAULT_ALERT_OPTIONS, ...options };

  const found = [
    ...fromBudgets(inputs.budgets),
    ...fromHistory(inputs.history, inputs.budgets),
    ...fromAnomalies(inputs.anomalies),
    ...fromReliability(inputs.reliability),
    ...fromCache(inputs.cache),
    ...fromHealth(inputs.health),
    ...fromCoverage(inputs.coverage),
  ];

  // Severity first, then the editorial order of kinds. Nothing sorts *within* a
  // kind: each source handed its rows over already ranked, and Array.sort is
  // stable, so that ranking survives.
  const ranked = [...found].sort((left, right) => {
    const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (bySeverity !== 0) return bySeverity;
    return KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind);
  });

  const blindSpots = blindSpotsOf(inputs);

  return {
    alerts: ranked.slice(0, maxAlerts),
    critical: ranked.filter((entry) => entry.severity === 'critical').length,
    warning: ranked.filter((entry) => entry.severity === 'warning').length,
    info: ranked.filter((entry) => entry.severity === 'info').length,
    total: ranked.length,
    truncated: Math.max(0, ranked.length - maxAlerts),
    dimension: inputs.reliability.dimension,
    blindSpots,
    allClear: ranked.length === 0 && blindSpots.length === 0,
  };
}
