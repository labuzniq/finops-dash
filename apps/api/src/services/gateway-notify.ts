import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  GATEWAY_ALERT_KINDS,
  deriveBudgetAlerts,
  deriveHealthAlerts,
  describeGatewayNotification,
  summarizeDeploymentHealth,
} from '@dash/shared';
import type {
  GatewayAlertKind,
  GatewayAlertSource,
  GatewayBudget,
  GatewayBudgetScope,
  GatewayBudgetState,
  GatewayModelHealthState,
  GatewayNotification,
  GatewayNotificationHealthDetail,
  GatewayNotifications,
} from '@dash/shared';
import { db } from '../db/client.js';
import { gatewayBudget, gatewayNotification, refreshJobs } from '../db/schema.js';
import type { GatewayNotificationRow } from '../db/schema.js';
import { env } from '../env.js';
import { nanoToDollars } from '../lib/nano.js';
import { moduleLogger } from '../log.js';
import { getGatewayHealth, toGatewayBudget } from './gateway.js';

const log = moduleLogger('services.gateway-notify');

/**
 * Gateway alerting — the findings that can leave the dashboard.
 *
 * Most cards on the gateway page derive their findings in the browser from the
 * usage payload, which means they exist only while somebody is looking. Two
 * sources are different in kind, and it is the same difference in both cases:
 * they are *tables*, written by the full sync, so the API can assess them the
 * moment they land and act on what it finds.
 *
 *  - **Budgets** (`gateway_budget`) — over a cap, blocked, past a soft budget,
 *    or pacing past one.
 *  - **Deployment health** (`gateway_deployment_health`) — an alias whose
 *    deployments are all failing, or only some of them.
 *
 * Nothing else may follow them, and the boundary is "is it a table" rather than
 * "is it important": anomalies, reliability, cache churn and coverage are
 * browser derivations over a *range*, and evaluating them here would mean either
 * a second implementation of five modules or an answer to "what range" that a
 * nightly job does not have.
 *
 * This runs at the end of the sync rather than on a timer of its own for the
 * same reason both tables are fetched there — one fewer schedule, and an alert
 * about a snapshot arrives with the snapshot.
 *
 * Four rules hold the whole thing up:
 *
 *  - **It owns no threshold.** Every state comes from `assessBudget` or
 *    `summarizeDeploymentHealth` in `@dash/shared`, the same functions the cards
 *    and the attention digest read. A notification saying a key is fine while
 *    the card it links to says it is blocked would be the digest's two-answers
 *    failure delivered by mail.
 *  - **A source that could not be read clears nothing.** An episode is closed
 *    because the finding stopped being reported, which is only a fact when the
 *    table it came from was actually assessed. `/health` failing (its failure is
 *    swallowed, so the last reading stands) or having never run must not read as
 *    "every deployment recovered", so the close pass is scoped to the sources
 *    this run evaluated.
 *  - **An alert is sent once per episode.** The fingerprint (`kind:scope:key`)
 *    carries no numbers, so a counter climbing from 104% to 137% is the same
 *    finding and moves only `lastSeenAt`; crossing from `soft` to `over` is a
 *    different kind and is a new one. An episode ends when the finding stops
 *    being reported, and the next appearance starts a fresh one.
 *  - **Undelivered is the retry state.** A failed POST, or no target configured
 *    at all, leaves `deliveredAt` null and the next sync tries again. There is no
 *    queue and no backoff, because the sync is already a schedule and a
 *    governance finding that is one day late is still true.
 *
 * What it deliberately does *not* do: send a resolution. `clearedAt` is recorded
 * because it bounds the episode, but "the key is under its cap again" is a
 * different product decision, and a channel that announces both is one people
 * mute.
 */

/** Delivery attempts per run, and the timeout on each. A dead endpoint must not hang a sync. */
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * How many findings one POST carries.
 *
 * A cap is needed — the first sync after a target is configured could carry
 * every open finding on the gateway — and it is a cap on the *batch*, not on
 * what is recorded: the remainder stays pending and goes out on the next run,
 * so nothing is dropped, only delayed.
 */
const DELIVERY_BATCH = 50;

export interface GatewayNotifyResult {
  /** Findings the snapshots carry right now, across every source assessed. */
  found: number;
  /** Which sources were assessed — the ones whose episodes this run may close. */
  assessed: GatewayAlertSource[];
  /** Episodes that started this run — the ones worth sending. */
  opened: number;
  /** Episodes that ended this run. */
  cleared: number;
  /** Findings accepted by the delivery target. */
  delivered: number;
  /** Open findings still undelivered after this run. */
  pending: number;
  /** Why nothing was sent, when nothing was: no target, or the target refused. */
  deliveryError: string | null;
}

/** The current snapshot as the shared contract sees it. */
async function readBudgets(): Promise<GatewayBudget[]> {
  const rows = await db.select().from(gatewayBudget);
  const budgets: GatewayBudget[] = [];
  for (const row of rows) {
    const budget = toGatewayBudget(row);
    if (budget !== null) budgets.push(budget);
  }
  return budgets;
}

function toNano(dollars: number): bigint {
  return BigInt(Math.round(dollars * 1e9));
}

/**
 * One finding on its way into the table, whichever source produced it.
 *
 * Flat rather than a discriminated union because the row it becomes is flat: a
 * budget finding has dollars and no reading, a deployment finding has a reading
 * and no dollars, and both are nullable columns for exactly that reason.
 */
interface PendingAlert {
  fingerprint: string;
  kind: GatewayAlertKind;
  severity: 'critical' | 'warning';
  source: GatewayAlertSource;
  scope: string;
  key: string;
  label: string | null;
  state: string;
  spendNano: bigint | null;
  maxBudgetNano: bigint | null;
  detail: GatewayNotificationHealthDetail | null;
}

/**
 * Everything both tables say right now, and which of them actually answered.
 *
 * The second half of that is what keeps a missing reading from reading as a
 * recovery. Governance is always assessed — an empty `gateway_budget` is a
 * proxy that refused the management routes, which is indistinguishable from an
 * ungoverned one and has been treated as "no findings" since the table existed.
 * Health is not: `checkedAt` is null exactly when no reading has ever been
 * stored, and a reading that could not be refreshed is the *previous* one still
 * standing, which is the right thing to keep alerting on.
 */
async function collect(now: Date): Promise<{
  alerts: PendingAlert[];
  assessed: GatewayAlertSource[];
}> {
  const [budgets, health] = await Promise.all([readBudgets(), getGatewayHealth()]);

  const alerts: PendingAlert[] = deriveBudgetAlerts(budgets, now).map((alert) => ({
    fingerprint: alert.fingerprint,
    kind: alert.kind,
    severity: alert.severity,
    source: 'budget',
    scope: alert.scope,
    key: alert.key,
    label: alert.label,
    state: alert.state,
    spendNano: toNano(alert.spend),
    maxBudgetNano: alert.maxBudget === null ? null : toNano(alert.maxBudget),
    detail: null,
  }));

  const assessed: GatewayAlertSource[] = ['budget'];

  if (health.checkedAt !== null) {
    assessed.push('health');
    const summary = summarizeDeploymentHealth(health.deployments, health.checkedAt);
    for (const alert of deriveHealthAlerts(summary)) {
      alerts.push({
        fingerprint: alert.fingerprint,
        kind: alert.kind,
        severity: alert.severity,
        source: 'health',
        // Deployment findings have one scope: the alias is a `model`, which is
        // also the usage dimension a reader would look it up in.
        scope: 'model',
        key: alert.key,
        // The key *is* the name here — a second copy of it would be the only
        // label a deployment finding could carry, and it would go stale.
        label: null,
        state: alert.state,
        spendNano: null,
        maxBudgetNano: null,
        detail: {
          deployments: alert.deployments,
          unhealthy: alert.unhealthy,
          providers: alert.providers,
          errors: alert.errors,
        },
      });
    }
  }

  return { alerts, assessed };
}

/**
 * Reconcile the findings against what is already recorded, in one transaction.
 *
 * Upsert every current finding and close every open row that is no longer among
 * them. The `clearedAt = null` reset in the upsert is what makes a returning
 * finding a new episode: `firstSeenAt` moves to now and `deliveredAt` is wiped,
 * so it is sent again — which is right, because a key that went over its cap,
 * was raised, and went over again is two things that happened.
 */
async function reconcile(
  alerts: readonly PendingAlert[],
  assessed: readonly GatewayAlertSource[],
  now: Date,
): Promise<{ opened: number; cleared: number }> {
  return db.transaction(async (tx) => {
    let opened = 0;

    for (const alert of alerts) {
      const [row] = await tx
        .insert(gatewayNotification)
        .values({
          fingerprint: alert.fingerprint,
          kind: alert.kind,
          severity: alert.severity,
          source: alert.source,
          scope: alert.scope,
          key: alert.key,
          label: alert.label,
          state: alert.state,
          spendNano: alert.spendNano,
          maxBudgetNano: alert.maxBudgetNano,
          detail: alert.detail,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: gatewayNotification.fingerprint,
          set: {
            // The label, the state and the numbers are refreshed every run: the
            // finding is the same, but what it is worth saying about it is not
            // — a second region joining an outage is the same episode reported
            // with a worse reading.
            label: sql`excluded.label`,
            severity: sql`excluded.severity`,
            state: sql`excluded.state`,
            spendNano: sql`excluded.spend_nano`,
            maxBudgetNano: sql`excluded.max_budget_nano`,
            detail: sql`excluded.detail`,
            lastSeenAt: sql`excluded.last_seen_at`,
            // A row that was cleared and is back starts over; one that never
            // cleared keeps every date it had, so an ongoing finding is not
            // re-sent every night.
            firstSeenAt: sql`case when ${gatewayNotification.clearedAt} is null then ${gatewayNotification.firstSeenAt} else excluded.first_seen_at end`,
            deliveredAt: sql`case when ${gatewayNotification.clearedAt} is null then ${gatewayNotification.deliveredAt} else null end`,
            deliveryAttempts: sql`case when ${gatewayNotification.clearedAt} is null then ${gatewayNotification.deliveryAttempts} else 0 end`,
            deliveryError: sql`case when ${gatewayNotification.clearedAt} is null then ${gatewayNotification.deliveryError} else null end`,
            clearedAt: null,
          },
        })
        .returning({ firstSeenAt: gatewayNotification.firstSeenAt });
      if (row !== undefined && row.firstSeenAt.getTime() === now.getTime()) opened += 1;
    }

    // Everything open that this evaluation did not report is over. Scoped by
    // `lastSeenAt` rather than by a NOT IN list of fingerprints: the rows just
    // upserted carry this run's instant, so one predicate closes exactly the
    // ones the snapshot no longer justifies, however many there are.
    //
    // ...and scoped to the sources that were actually read, because "not
    // reported" only means "resolved" for a table somebody looked at. A run
    // with no health reading leaves every deployment episode open.
    const closed = await tx
      .update(gatewayNotification)
      .set({ clearedAt: now })
      // `lt` rather than a raw `sql` fragment: a bare Date interpolated into a
      // template reaches the driver untyped and is rejected at bind time.
      .where(
        and(
          isNull(gatewayNotification.clearedAt),
          lt(gatewayNotification.lastSeenAt, now),
          inArray(gatewayNotification.source, [...assessed]),
        ),
      )
      .returning({ fingerprint: gatewayNotification.fingerprint });

    return { opened, cleared: closed.length };
  });
}

/**
 * POST the pending findings to the configured target.
 *
 * One request for the batch rather than one per finding: a gateway that just
 * lost its budget reset would otherwise fire fifty messages, and a target that
 * rate-limits would drop most of them. The body is deliberately plain — a
 * `text` line for chat webhooks that render nothing else, and the findings
 * themselves for anything that wants the numbers.
 *
 * Returns null on success, or why it failed. Never throws: a delivery failure
 * must not fail the sync that the usage already landed from.
 */
async function deliver(url: string, rows: GatewayNotificationRow[]): Promise<string | null> {
  const findings = rows.map((row) => {
    const notification = toNotification(row);
    return {
      fingerprint: row.fingerprint,
      kind: row.kind,
      severity: row.severity,
      // `source` on the finding, not on the envelope: a batch legitimately
      // mixes a key over its cap with an alias whose region went dark, and a
      // recipient routing on it needs to tell them apart.
      source: row.source,
      scope: row.scope,
      key: row.key,
      label: row.label,
      state: row.state,
      spend: row.spendNano === null ? null : nanoToDollars(row.spendNano),
      maxBudget: row.maxBudgetNano === null ? null : nanoToDollars(row.maxBudgetNano),
      health: row.detail,
      firstSeenAt: row.firstSeenAt.toISOString(),
      summary:
        notification === null
          ? `${row.kind} on ${row.key}`
          : describeGatewayNotification(notification),
    };
  });

  const body = {
    source: 'dash-llm-gateway',
    generatedAt: new Date().toISOString(),
    text: [
      `LLM gateway — ${findings.length} finding${findings.length === 1 ? '' : 's'}`,
      ...findings.map((finding) => `• ${finding.summary}`),
    ].join('\n'),
    findings,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.GATEWAY_ALERT_WEBHOOK_TOKEN === undefined
          ? {}
          : { authorization: `Bearer ${env.GATEWAY_ALERT_WEBHOOK_TOKEN}` }),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return `delivery target answered ${response.status}`;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Evaluate governance against the snapshot just synced, record what changed, and
 * send what has not been sent.
 *
 * `now` is injected so the whole thing is reproducible: the same snapshot at the
 * same instant produces the same episodes.
 */
export async function notifyGatewayFindings(now: Date = new Date()): Promise<GatewayNotifyResult> {
  const { alerts, assessed } = await collect(now);
  const { opened, cleared } = await reconcile(alerts, assessed, now);

  // Pending = open and never accepted. That set includes findings from earlier
  // runs whose delivery failed or had nowhere to go, which is the point: turning
  // a webhook on tomorrow sends what was found today.
  const pendingRows = await db
    .select()
    .from(gatewayNotification)
    .where(and(isNull(gatewayNotification.clearedAt), isNull(gatewayNotification.deliveredAt)))
    // `critical` sorts before `warning` alphabetically, which is the order they
    // should be read in — a happy accident, but the batch cap makes it matter:
    // if only fifty go out, they are the fifty that matter most.
    .orderBy(gatewayNotification.severity, desc(gatewayNotification.firstSeenAt))
    .limit(DELIVERY_BATCH);

  const url = env.GATEWAY_ALERT_WEBHOOK_URL;
  if (url === undefined) {
    // Nothing is attempted and nothing is stamped — an attempt counter that
    // climbed nightly against a target that does not exist would read as a
    // broken endpoint rather than as an unconfigured one.
    return {
      found: alerts.length,
      assessed,
      opened,
      cleared,
      delivered: 0,
      pending: pendingRows.length,
      deliveryError:
        pendingRows.length === 0 ? null : 'no delivery target configured (GATEWAY_ALERT_WEBHOOK_URL)',
    };
  }

  if (pendingRows.length === 0) {
    return {
      found: alerts.length,
      assessed,
      opened,
      cleared,
      delivered: 0,
      pending: 0,
      deliveryError: null,
    };
  }

  const failure = await deliver(url, pendingRows);

  await db
    .update(gatewayNotification)
    .set(
      failure === null
        ? {
            deliveredAt: now,
            deliveryAttempts: sql`${gatewayNotification.deliveryAttempts} + 1`,
            deliveryError: null,
          }
        : { deliveryAttempts: sql`${gatewayNotification.deliveryAttempts} + 1`, deliveryError: failure },
    )
    .where(
      inArray(
        gatewayNotification.fingerprint,
        pendingRows.map((row) => row.fingerprint),
      ),
    );

  const [remaining] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(gatewayNotification)
    .where(and(isNull(gatewayNotification.clearedAt), isNull(gatewayNotification.deliveredAt)));

  log.info(
    {
      'event.action': 'gateway-notify',
      'event.outcome': failure === null ? 'success' : 'failure',
      dash: {
        found: alerts.length,
        assessed: assessed.join(','),
        opened,
        cleared,
        batch: pendingRows.length,
        failure,
      },
    },
    failure === null ? 'gateway findings delivered' : 'gateway finding delivery failed',
  );

  return {
    found: alerts.length,
    assessed,
    opened,
    cleared,
    delivered: failure === null ? pendingRows.length : 0,
    pending: remaining?.count ?? 0,
    deliveryError: failure,
  };
}

/**
 * A stored row as the contract sees it.
 *
 * A kind this build does not know is dropped rather than guessed at — the table
 * outlives the code that wrote it, and a finding nothing can render is worse
 * than one that is missing. `source` is read from the row rather than derived
 * from the kind for the same reason: it is what the row was written as.
 */
function toNotification(row: GatewayNotificationRow): GatewayNotification | null {
  const kind = GATEWAY_ALERT_KINDS.find((candidate) => candidate === row.kind);
  if (kind === undefined) return null;
  const spend = row.spendNano === null ? null : nanoToDollars(row.spendNano);
  const maxBudget = row.maxBudgetNano === null ? null : nanoToDollars(row.maxBudgetNano);
  return {
    fingerprint: row.fingerprint,
    kind,
    severity: row.severity === 'critical' ? 'critical' : 'warning',
    source: row.source === 'health' ? 'health' : 'budget',
    scope: row.scope as GatewayBudgetScope | 'model',
    key: row.key,
    label: row.label,
    state: row.state as GatewayBudgetState | GatewayModelHealthState,
    spend,
    maxBudget,
    utilization:
      spend === null || maxBudget === null || maxBudget <= 0 ? null : (spend / maxBudget) * 100,
    health: row.detail,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    clearedAt: row.clearedAt === null ? null : row.clearedAt.toISOString(),
    deliveredAt: row.deliveredAt === null ? null : row.deliveredAt.toISOString(),
    deliveryAttempts: row.deliveryAttempts,
    deliveryError: row.deliveryError,
  };
}

/**
 * Every open finding, plus the ones that closed inside `days`.
 *
 * The closed ones are the reason this is a list rather than a count: an episode
 * that opened and cleared between two visits to the page is invisible in the
 * budget card (the snapshot moved on) and is exactly what somebody asking "did
 * anything happen last week" means. `evaluatedAt` comes from the sync job rather
 * than from these rows, so "nothing is open" and "this has never run" stay
 * different answers.
 */
export async function getGatewayNotifications(days: number): Promise<GatewayNotifications> {
  const since = new Date(Date.now() - days * 86_400_000);

  const rows = await db
    .select()
    .from(gatewayNotification)
    .where(or(isNull(gatewayNotification.clearedAt), gte(gatewayNotification.clearedAt, since)))
    .orderBy(desc(gatewayNotification.lastSeenAt));

  const notifications: GatewayNotification[] = [];
  for (const row of rows) {
    const notification = toNotification(row);
    if (notification !== null) notifications.push(notification);
  }

  const [job] = await db
    .select({ finishedAt: refreshJobs.finishedAt })
    .from(refreshJobs)
    .where(and(eq(refreshJobs.kind, 'gateway'), eq(refreshJobs.status, 'succeeded')))
    .orderBy(desc(refreshJobs.finishedAt))
    .limit(1);

  const open = notifications.filter((notification) => notification.clearedAt === null);

  return {
    notifications,
    deliveryConfigured: env.GATEWAY_ALERT_WEBHOOK_URL !== undefined,
    open: open.length,
    pending: open.filter((notification) => notification.deliveredAt === null).length,
    evaluatedAt: job?.finishedAt?.toISOString() ?? null,
  };
}
