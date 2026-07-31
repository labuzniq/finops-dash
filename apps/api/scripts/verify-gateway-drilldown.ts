/**
 * Ad-hoc check of the web app's gateway drill-down derivations against a real
 * mock-source payload. Not a test suite (the repo has none) — run it by hand:
 *
 *   node_modules/.bin/tsx apps/api/scripts/verify-gateway-drilldown.ts
 */
import { MockGatewayClient } from '../src/gateway/mock.js';
import { nanoToDollars } from '../src/lib/nano.js';
import type { GatewayBreakdownPoint, GatewayDailyPoint, GatewayUsage } from '@dash/shared';
import {
  breakdownDailySeries,
  deriveGateway,
} from '../../web/src/lib/metrics/gateway.js';
import { buildGatewayChartGeometry } from '../../web/src/lib/metrics/gatewayChart.js';

const DAYS = 30;

function iso(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

const from = iso(-(DAYS - 1));
const to = iso(0);

const snapshot = await new MockGatewayClient().fetchUsage(from, iso(-1));

const usage: GatewayUsage = {
  daily: snapshot.daily.map(
    (row): GatewayDailyPoint => ({ ...row, spend: nanoToDollars(row.spendNano) }),
  ),
  breakdowns: snapshot.breakdowns.map(
    (row): GatewayBreakdownPoint => ({ ...row, spend: nanoToDollars(row.spendNano) }),
  ),
};

const summary = deriveGateway(usage, from, to);
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

console.log(
  `range ${from}..${to} · spine ${summary.daily.length} days (${summary.daily[0]?.date} .. ${summary.daily.at(-1)?.date}) · $${summary.totals.spend.toFixed(2)}`,
);

for (const dimension of summary.availableDimensions) {
  const rows = summary.breakdowns[dimension];
  const top = rows[0];
  if (top === undefined) continue;

  const series = breakdownDailySeries(usage.breakdowns, dimension, top.key, summary.daily);

  // The series must be the page's axis, not its own.
  check(
    series.length === summary.daily.length,
    `${dimension}: series length ${series.length} != spine ${summary.daily.length}`,
  );
  check(
    series.every((point, index) => point.date === summary.daily[index]?.date),
    `${dimension}: series dates diverge from the spine`,
  );

  // Summing the drill-down must land on the ranked row it was opened from.
  const summed = series.reduce((total, point) => total + point.spend, 0);
  check(
    Math.abs(summed - top.metrics.spend) < 1e-6,
    `${dimension}/${top.key}: series sum ${summed} != row spend ${top.metrics.spend}`,
  );
  const requests = series.reduce((total, point) => total + point.requests, 0);
  check(
    requests === top.metrics.requests,
    `${dimension}/${top.key}: series requests ${requests} != row requests ${top.metrics.requests}`,
  );

  // And it must never exceed the gateway-wide day it is a slice of.
  check(
    series.every((point, index) => point.spend <= (summary.daily[index]?.spend ?? 0) + 1e-9),
    `${dimension}/${top.key}: a day's key spend exceeds the gateway total`,
  );

  const chart = buildGatewayChartGeometry(series, 'spend');
  check(chart.linePath.startsWith('M'), `${dimension}/${top.key}: no chart path`);
  check(
    chart.hoverPoints.length === series.length,
    `${dimension}/${top.key}: hover points ${chart.hoverPoints.length} != ${series.length}`,
  );

  const active = series.filter((point) => point.requests > 0).length;
  console.log(
    `  ${dimension.padEnd(11)} top=${top.key.padEnd(28)} $${top.metrics.spend.toFixed(2).padStart(9)} ` +
      `share=${(top.share * 100).toFixed(1).padStart(5)}%  active ${active}/${series.length} days  ` +
      `peak $${Math.max(...series.map((point) => point.spend)).toFixed(2)}`,
  );
}

// A key that does not exist still yields a full, flat spine rather than nothing.
const missing = breakdownDailySeries(usage.breakdowns, 'model', 'not-a-model', summary.daily);
check(missing.length === summary.daily.length, 'unknown key: spine not preserved');
check(missing.every((point) => point.spend === 0), 'unknown key: non-zero spend');

if (failures.length > 0) {
  console.error(`\nFAIL\n${failures.map((line) => `  - ${line}`).join('\n')}`);
  process.exit(1);
}
console.log('\nOK — drill-down series align to the spine, sum to their ranked row, and stay within it.');
