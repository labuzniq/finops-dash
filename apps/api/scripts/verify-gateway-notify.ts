/**
 * Ad-hoc check of the gateway's governance alerting — the one finding on this
 * page that can leave the dashboard, and therefore the one that has to be right
 * about *when* it leaves.
 *
 * Run it by hand (it needs the API's env and a database):
 *
 *   set -a; . ./.env; set +a
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-notify.ts
 *
 * Three halves.
 *
 * **`deriveBudgetAlerts` is pure**, and every claim it makes is checkable
 * against constructed rows: which states produce a finding at all, that a
 * fingerprint carries no numbers (so a counter climbing further is the same
 * finding), that crossing into a worse state is a *different* one, and that a
 * tag never produces a pace finding however far through its period it is.
 *
 * **The cross-module check** is the one no single module can make: the budget
 * card and the notifier must classify the same snapshot identically, because one
 * of them arrives by mail and the other is what the reader opens to check it.
 * Both are run over the real snapshot and compared row by row.
 *
 * **The Postgres half** is the de-duplication story, which is the whole reason
 * the table exists: a finding still true tomorrow is not a new alert, one that
 * escalates is, a resolved one closes, a returning one re-opens and re-delivers,
 * and a failed delivery is retried rather than lost. A throwaway HTTP server
 * stands in for the webhook, so the retry path is driven rather than argued
 * about.
 *
 * It plants budget rows under a `verify-notify-` prefix and removes them, along
 * with the notifications they produced. Findings about the gateway's *real*
 * budgets are left recorded — the next sync would have recorded them anyway.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
// Type-only, so it is erased and loads nothing before the env is pointed at the
// fake target below. Every value import in this file is deliberately dynamic.
import type { GatewayBudget } from '@dash/shared';

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

// ───────────────────────────────────────────────────────────── the fake target
//
// Stood up and pointed at *before* anything that reads env is imported: the API
// parses its environment once, at module load, so the webhook URL has to exist
// by then. Every import below is therefore dynamic.

interface Received {
  body: { text: string; findings: { fingerprint: string; summary: string }[] };
  authorization: string | undefined;
}

const received: Received[] = [];
let refuse = false;

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    if (refuse) {
      response.writeHead(500).end('nope');
      return;
    }
    received.push({
      body: JSON.parse(Buffer.concat(chunks).toString()) as Received['body'],
      authorization: request.headers.authorization,
    });
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;

process.env['GATEWAY_ALERT_WEBHOOK_URL'] = `http://127.0.0.1:${port}/hook`;
process.env['GATEWAY_ALERT_WEBHOOK_TOKEN'] = 'verify-token';

const { GATEWAY_BUDGET_ALERT_SEVERITY, assessBudget, deriveBudgetAlerts, describeBudgetAlert } =
  await import('@dash/shared');

const { deriveBudgets } = await import('../../web/src/lib/metrics/gatewayBudgets.js');
const { KIND_SEVERITY } = await import('../../web/src/lib/metrics/gatewayAlerts.js');

// ══════════════════════════════════════════════════════════════ pure half

const NOW = new Date('2026-07-16T12:00:00.000Z');

/** A monthly key budget, half its period elapsed unless said otherwise. */
function budget(overrides: Partial<GatewayBudget> = {}): GatewayBudget {
  return {
    scope: 'api_key',
    key: 'k1',
    label: 'Key one',
    spend: 10,
    maxBudget: 100,
    softBudget: null,
    budgetDuration: '30d',
    resetAt: '2026-07-31T00:00:00.000Z',
    tpmLimit: null,
    rpmLimit: null,
    blocked: false,
    ...overrides,
  };
}

// ---------------------------------------------- 1. which states are findings
{
  const rows = [
    budget({ key: 'ok', spend: 10 }),
    budget({ key: 'warn', spend: 85 }),
    budget({ key: 'uncapped', spend: 900, maxBudget: null }),
    budget({ key: 'soft', spend: 82, softBudget: 80 }),
    budget({ key: 'over', spend: 137 }),
    budget({ key: 'zero', spend: 0, maxBudget: 0 }),
    budget({ key: 'disabled', spend: 5, blocked: true }),
  ];
  const alerts = deriveBudgetAlerts(rows, NOW);
  const keys = new Set(alerts.map((alert) => alert.key));

  check(!keys.has('ok'), 'a comfortable budget produced a finding');
  // The `warn` state itself is never a finding — a threshold nobody configured
  // is worth a row on a card and is not worth sending. The same row may still
  // be *pacing* past its cap, which is a different claim and does travel, so
  // this has to be checked per kind rather than per key.
  check(
    !alerts.some((alert) => alert.key === 'warn' && alert.kind !== 'budget-pacing'),
    'a derived 80% warning produced a state finding',
  );
  check(!keys.has('uncapped'), 'an uncapped key produced a finding — it is a standing decision');
  check(keys.has('soft'), 'a key past its soft budget produced no finding');
  check(keys.has('over'), 'a key over its cap produced no finding');
  check(keys.has('zero'), 'a $0 cap produced no finding — it rejects every call');
  check(keys.has('disabled'), 'an administratively disabled key produced no finding');

  // Ordering is the delivery batch's priority, so it is load-bearing rather
  // than cosmetic: if only the first fifty go out, they must be the worst fifty.
  const order = alerts.map((alert) => alert.kind);
  check(
    order.indexOf('budget-blocked') === 0 &&
      order.indexOf('budget-over') > order.indexOf('budget-blocked') &&
      order.lastIndexOf('budget-soft') > order.indexOf('budget-over'),
    `findings are not ordered worst-first: ${order.join(', ')}`,
  );

  for (const alert of alerts) {
    check(
      alert.severity === GATEWAY_BUDGET_ALERT_SEVERITY[alert.kind],
      `${alert.kind} carries a severity the shared map does not agree with`,
    );
    check(
      describeBudgetAlert(alert).includes(alert.label ?? alert.key),
      `${alert.kind}'s sentence does not name what it is about`,
    );
  }
}

// ------------------------------------- 2. the fingerprint carries no numbers
{
  const modest = deriveBudgetAlerts([budget({ key: 'k', spend: 104 })], NOW);
  const dire = deriveBudgetAlerts([budget({ key: 'k', spend: 999 })], NOW);
  check(
    modest[0]?.fingerprint === dire[0]?.fingerprint,
    'the same key over the same cap produced two fingerprints — an ongoing finding would re-alert every night',
  );

  // ...but a worse state is a different finding, and must be sent.
  const soft = deriveBudgetAlerts([budget({ key: 'k', spend: 82, softBudget: 80 })], NOW);
  check(
    soft[0]?.fingerprint !== modest[0]?.fingerprint,
    'crossing from soft to over kept the same fingerprint — the escalation would never be sent',
  );
}

// -------------------------- 3. a pace finding, and the scope that never gets one
{
  // Half a month gone, $60 against a $100 cap: not over, pacing to $120.
  const pacing = deriveBudgetAlerts([budget({ key: 'k', spend: 60 })], NOW);
  check(
    pacing.some((alert) => alert.kind === 'budget-pacing'),
    'a key pacing past its cap produced no pace finding',
  );

  // The same numbers on a tag. The counter is cumulative since creation
  // (BerriAI/litellm#27481), so dividing it by an elapsed fraction is a wrong
  // forecast rather than a slow one — and the finding must not exist at all.
  const tag = deriveBudgetAlerts([budget({ scope: 'tag', key: 't', spend: 60 })], NOW);
  check(
    !tag.some((alert) => alert.kind === 'budget-pacing'),
    'a tag produced a pace finding — its counter never reset, so there is nothing to project',
  );
  const elapsed = assessBudget(budget({ scope: 'tag', key: 't', spend: 60 }), NOW).periodElapsed;
  check(
    elapsed !== null && elapsed >= 1 / 6,
    `the tag case proves nothing unless the minimum-elapsed gate could not have fired (elapsed ${String(elapsed)})`,
  );

  // Over its cap, a tag still alerts — utilisation is the exact comparison the
  // proxy enforces, and a tag past it stays refused rather than recovering.
  const overTag = deriveBudgetAlerts([budget({ scope: 'tag', key: 't', spend: 260 })], NOW);
  check(
    overTag.some((alert) => alert.kind === 'budget-over'),
    'a tag over its cap produced no finding',
  );

  // A row already over is not also "pacing towards" the cap it has passed.
  const gone = deriveBudgetAlerts([budget({ key: 'k', spend: 300 })], NOW);
  check(
    !gone.some((alert) => alert.kind === 'budget-pacing'),
    'a key already over its cap was also reported as pacing towards it',
  );
}

// ------------------------------- 4. the page and the notifier cannot disagree
{
  for (const kind of ['budget-blocked', 'budget-over', 'budget-soft', 'budget-pacing'] as const) {
    check(
      KIND_SEVERITY[kind] === GATEWAY_BUDGET_ALERT_SEVERITY[kind],
      `${kind} is ${KIND_SEVERITY[kind]} on the page and ${GATEWAY_BUDGET_ALERT_SEVERITY[kind]} in a notification`,
    );
  }
}

console.log(`pure derivation: ${failures.length === 0 ? 'ok' : `${failures.length} failure(s)`}`);

// ══════════════════════════════════════════════════════════════ Postgres half

const { like } = await import('drizzle-orm');
const { db } = await import('../src/db/client.js');
const { gatewayBudget, gatewayNotification } = await import('../src/db/schema.js');
const { getGatewayBudgets } = await import('../src/services/gateway.js');
const { getGatewayNotifications, notifyGatewayFindings } = await import(
  '../src/services/gateway-notify.js'
);

const PREFIX = 'verify-notify-';
const planted = (key: string) => `${PREFIX}${key}`;
const nano = (dollars: number) => BigInt(Math.round(dollars * 1e9));

async function plant(key: string, spend: number, maxBudget: number, soft: number | null) {
  await db
    .insert(gatewayBudget)
    .values({
      scope: 'api_key',
      key: planted(key),
      label: `Verify ${key}`,
      spendNano: nano(spend),
      maxBudgetNano: nano(maxBudget),
      softBudgetNano: soft === null ? null : nano(soft),
      budgetDuration: '30d',
      resetAt: new Date(NOW.getTime() + 15 * 86_400_000),
      tpmLimit: null,
      rpmLimit: null,
      blocked: false,
    })
    .onConflictDoUpdate({
      target: [gatewayBudget.scope, gatewayBudget.key],
      set: { spendNano: nano(spend), maxBudgetNano: nano(maxBudget) },
    });
}

async function plantedNotifications() {
  const rows = await db
    .select()
    .from(gatewayNotification)
    .where(like(gatewayNotification.key, `${PREFIX}%`));
  return new Map(rows.map((row) => [row.fingerprint, row]));
}

async function removePlanted() {
  await db.delete(gatewayBudget).where(like(gatewayBudget.key, `${PREFIX}%`));
  await db.delete(gatewayNotification).where(like(gatewayNotification.key, `${PREFIX}%`));
}

const [anyBudget] = await db.select().from(gatewayBudget).limit(1);

if (anyBudget === undefined) {
  console.log('\nNo budgets stored — run a gateway sync first; skipping the database half.');
} else {
  await removePlanted();

  // ---------------------------------------- 5. the cross-module classification
  {
    const { budgets } = await getGatewayBudgets();
    const summary = deriveBudgets(budgets, NOW);
    const carded = new Map(
      summary.scopes.flatMap((scope) =>
        scope.rows.map((row) => [`${row.budget.scope}:${row.budget.key}`, row]),
      ),
    );
    let compared = 0;
    for (const item of budgets) {
      const assessment = assessBudget(item, NOW);
      const row = carded.get(`${item.scope}:${item.key}`);
      if (row === undefined) {
        check(false, `${item.key} is in the snapshot but not on the card`);
        continue;
      }
      compared += 1;
      check(
        row.state === assessment.state,
        `${item.key}: the card says ${row.state} and the notifier says ${assessment.state}`,
      );
      check(
        row.projectedOverrun === assessment.projectedOverrun,
        `${item.key}: the card and the notifier disagree about pacing`,
      );
    }
    check(compared > 0, 'no governed object was compared — the cross-module check proved nothing');
  }

  // ------------------------------------------ 6. a first evaluation delivers
  {
    await plant('over', 150, 100, null);
    await plant('soft', 85, 100, 80);
    await plant('fine', 10, 100, null);

    const before = received.length;
    const result = await notifyGatewayFindings(new Date());
    const rows = await plantedNotifications();

    check(
      rows.has(`budget-over:api_key:${planted('over')}`),
      'the planted overrun produced no notification',
    );
    check(
      rows.has(`budget-soft:api_key:${planted('soft')}`),
      'the planted soft breach produced no notification',
    );
    check(
      ![...rows.keys()].some((fingerprint) => fingerprint.endsWith(planted('fine'))),
      'a budget at 10% of its cap produced a notification',
    );
    check(result.opened >= 2, `expected at least two new episodes, got ${result.opened}`);
    check(result.delivered > 0, 'nothing was delivered on the first evaluation');
    check(received.length === before + 1, 'the first evaluation did not send exactly one request');

    const sent = received[received.length - 1];
    check(
      sent?.authorization === 'Bearer verify-token',
      'the delivery carried no bearer token — a target that wants one would refuse it',
    );
    check(
      sent?.body.findings.some((finding) => finding.fingerprint.includes(planted('over'))) === true,
      'the delivered batch did not carry the planted overrun',
    );
    check(
      sent?.body.text.includes('over its budget') === true,
      'the delivered text does not read as a sentence — a chat client renders nothing else',
    );
    for (const row of rows.values()) {
      check(row.deliveredAt !== null, `${row.fingerprint} was sent but not stamped as delivered`);
      check(row.deliveryAttempts === 1, `${row.fingerprint} recorded ${row.deliveryAttempts} attempts`);
    }
  }

  // ------------------------- 7. the same finding tomorrow is not a new alert
  {
    const before = received.length;
    const firstSeen = (await plantedNotifications()).get(
      `budget-over:api_key:${planted('over')}`,
    )?.firstSeenAt;

    // The counter climbs. Same finding, same fingerprint, nothing sent.
    await plant('over', 480, 100, null);
    const result = await notifyGatewayFindings(new Date());
    const rows = await plantedNotifications();
    const again = rows.get(`budget-over:api_key:${planted('over')}`);

    check(result.opened === 0, `a re-evaluation opened ${result.opened} episodes it should not have`);
    check(received.length === before, 'an unchanged finding was delivered a second time');
    check(
      again?.firstSeenAt.getTime() === firstSeen?.getTime(),
      'an ongoing episode had its start date moved',
    );
    check(
      again !== undefined && Number(again.spendNano) / 1e9 > 400,
      'the notification kept a stale number — the finding is the same but what it says is not',
    );
  }

  // ------------------------------- 8. an escalation is a new finding and is sent
  {
    const before = received.length;
    await plant('soft', 220, 100, 80);
    const result = await notifyGatewayFindings(new Date());
    const rows = await plantedNotifications();

    const soft = rows.get(`budget-soft:api_key:${planted('soft')}`);
    const over = rows.get(`budget-over:api_key:${planted('soft')}`);
    check(soft?.clearedAt !== null, 'the superseded soft finding stayed open');
    check(over !== undefined, 'the escalation to over produced no new finding');
    check(over?.deliveredAt !== null, 'the escalation was recorded but never sent');
    check(result.cleared >= 1, 'no episode was closed by the escalation');
    check(received.length === before + 1, 'the escalation did not send exactly one request');
  }

  // ------------------- 9. a failed delivery is retried, not lost, on the next run
  {
    refuse = true;
    await plant('flaky', 900, 100, null);
    const failed = await notifyGatewayFindings(new Date());
    const afterFailure = (await plantedNotifications()).get(
      `budget-over:api_key:${planted('flaky')}`,
    );

    check(failed.delivered === 0, 'a refused delivery was counted as delivered');
    check(failed.deliveryError !== null, 'a refused delivery recorded no reason');
    check(
      afterFailure?.deliveredAt === null,
      'a refused delivery stamped the finding as delivered — it would never be retried',
    );
    check(
      afterFailure?.deliveryError?.includes('500') === true,
      `the target's refusal was not recorded verbatim: ${afterFailure?.deliveryError}`,
    );

    refuse = false;
    const before = received.length;
    const retried = await notifyGatewayFindings(new Date());
    const afterRetry = (await plantedNotifications()).get(
      `budget-over:api_key:${planted('flaky')}`,
    );

    check(retried.delivered > 0, 'a pending finding was not retried on the next run');
    check(received.length === before + 1, 'the retry did not send exactly one request');
    check(afterRetry?.deliveredAt !== null, 'the retried finding was not stamped as delivered');
    check(
      (afterRetry?.deliveryAttempts ?? 0) >= 2,
      'the retry did not count as a second attempt — a flapping target would look healthy',
    );
    check(
      afterRetry?.deliveryError === null,
      'a successful retry left the previous failure standing',
    );
  }

  // -------------------------- 10. resolved closes; returning re-opens and re-sends
  {
    const fingerprint = `budget-over:api_key:${planted('flaky')}`;
    const opened = (await plantedNotifications()).get(fingerprint)?.firstSeenAt;

    // The owner raises the cap. The finding stops being reported.
    await plant('flaky', 900, 10_000, null);
    const before = received.length;
    const resolved = await notifyGatewayFindings(new Date());
    const closed = (await plantedNotifications()).get(fingerprint);

    check(closed?.clearedAt !== null, 'a finding that stopped being true stayed open');
    check(resolved.cleared >= 1, 'the resolution was not counted');
    check(
      received.length === before,
      'a resolution was delivered — this channel deliberately does not announce recoveries',
    );

    // ...and it comes back. A new episode: sent again, and dated from now.
    await plant('flaky', 900, 100, null);
    const reopened = await notifyGatewayFindings(new Date());
    const back = (await plantedNotifications()).get(fingerprint);

    check(reopened.opened >= 1, 'a returning finding was not counted as a new episode');
    check(back?.clearedAt === null, 'a returning finding stayed closed');
    check(
      back !== undefined && opened !== undefined && back.firstSeenAt.getTime() > opened.getTime(),
      'a returning finding kept the previous episode’s start date',
    );
    check(back?.deliveryAttempts === 1, 'a returning finding kept the previous episode’s attempts');
    check(received.length === before + 1, 'the returning finding was not delivered');
  }

  // ---------------------------------------------- 11. what the route answers
  {
    const payload = await getGatewayNotifications(30);
    const mine = payload.notifications.filter((row) => row.key.startsWith(PREFIX));

    check(payload.deliveryConfigured, 'the route reports no delivery target while one is set');
    check(mine.length > 0, 'the route returned none of the planted findings');
    check(
      mine.some((row) => row.clearedAt !== null),
      'the route dropped the closed episodes — a finding that opened and cleared between two visits is exactly what it is for',
    );
    check(
      payload.open === payload.notifications.filter((row) => row.clearedAt === null).length,
      'the open count disagrees with the list it summarises',
    );
    for (const row of mine) {
      check(
        row.maxBudget === null || row.utilization !== null,
        `${row.key}: a capped finding came back with no utilisation`,
      );
      check(
        describeBudgetAlert(row).length > 0,
        `${row.key}: the route's row cannot be rendered as a sentence`,
      );
    }
  }

  // ------------------------------------------------------------- cleanup
  await removePlanted();
  const leftovers = await db
    .select()
    .from(gatewayNotification)
    .where(like(gatewayNotification.key, `${PREFIX}%`));
  check(leftovers.length === 0, 'the planted rows were not cleaned up');
}

server.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nall gateway notification checks passed');
process.exit(0);
