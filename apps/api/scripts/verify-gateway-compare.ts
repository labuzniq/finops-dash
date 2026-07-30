/**
 * Ad-hoc check of the web app's period-over-period gateway derivations against
 * a real mock-source payload. Not a test suite (the repo has none) — run it by
 * hand:
 *
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-compare.ts
 *
 * It sits outside apps/api's tsconfig `include` on purpose: it imports the web
 * app's metrics modules, which do not belong in the API's build.
 */
import { MockGatewayClient } from '../src/gateway/mock.js';
import { nanoToDollars } from '../src/lib/nano.js';
import { GATEWAY_DIMENSIONS, sumGatewayMetrics } from '@dash/shared';
import type { GatewayBreakdownPoint, GatewayDailyPoint, GatewayUsage } from '@dash/shared';
import { deriveGateway } from '../../web/src/lib/metrics/gateway.js';
import {
  comparisonWindow,
  deriveGatewayComparison,
  isWithinRetention,
  rankMovers,
} from '../../web/src/lib/metrics/gatewayCompare.js';

const DAYS = 30;
const MS_PER_DAY = 86_400_000;

function iso(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
}

function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_DAY) + 1;
}

const client = new MockGatewayClient();

async function pull(from: string, to: string): Promise<GatewayUsage> {
  const snapshot = await client.fetchUsage(from, to);
  return {
    daily: snapshot.daily.map(
      (row): GatewayDailyPoint => ({ ...row, spend: nanoToDollars(row.spendNano) }),
    ),
    breakdowns: snapshot.breakdowns.map(
      (row): GatewayBreakdownPoint => ({ ...row, spend: nanoToDollars(row.spendNano) }),
    ),
  };
}

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

// The page's own range: anchored on today, synced only through yesterday.
const from = iso(-(DAYS - 1));
const to = iso(0);
const summary = deriveGateway(await pull(from, iso(-1)), from, to);

const window = comparisonWindow(summary.daily);
if (window === null) {
  console.error('no comparison window for a non-empty spine');
  process.exit(1);
}

const spineFirst = summary.daily[0]?.date;
const spineLast = summary.daily.at(-1)?.date;

// Same length as what is on screen, ending the day before it starts.
check(window.days === summary.daily.length, `window ${window.days}d != spine ${summary.daily.length}d`);
check(dayCount(window.from, window.to) === window.days, `window bounds span != ${window.days} days`);
check(
  spineFirst !== undefined && dayCount(window.to, spineFirst) === 2,
  `window ends ${window.to}, spine starts ${spineFirst} — not adjacent`,
);
check(window.to < (spineFirst ?? ''), 'window overlaps the current spine');
check(isWithinRetention(window, iso(-89)), 'a 30d comparison should be inside 90d retention');
check(!isWithinRetention(window, iso(-30)), 'retention guard failed to reject an out-of-range window');

const prior = await pull(window.from, window.to);
const comparison = deriveGatewayComparison(prior, window, summary.totals);

// Deltas are arithmetic over the two windows, nothing more.
const priorTotals = sumGatewayMetrics(prior.daily);
check(comparison.hasActivity, 'the prior window should carry mock traffic');
check(
  Math.abs(comparison.totals.spend - priorTotals.spend) < 1e-9,
  'comparison totals != summed prior daily rows',
);
check(
  Math.abs(comparison.spend.absolute - (summary.totals.spend - priorTotals.spend)) < 1e-9,
  'spend delta != current - previous',
);
check(
  comparison.spend.change !== null &&
    Math.abs(comparison.spend.change - comparison.spend.absolute / priorTotals.spend) < 1e-9,
  'spend change is not the delta over the prior value',
);

console.log(
  `current ${spineFirst}..${spineLast} $${summary.totals.spend.toFixed(2)} · prior ${window.from}..${window.to} $${priorTotals.spend.toFixed(2)} · ${comparison.spend.change === null ? 'n/a' : `${(comparison.spend.change * 100).toFixed(1)}%`}`,
);

// Every full-coverage dimension's signed movements must add back up to the
// gateway-wide swing. `mcp_server` is a subset of the traffic, so it cannot.
for (const dimension of GATEWAY_DIMENSIONS) {
  const rows = summary.breakdowns[dimension];
  if (rows.length === 0) continue;

  const all = rankMovers(rows, prior.breakdowns, dimension, Number.MAX_SAFE_INTEGER);
  const signed = all.reduce((total, row) => total + row.spend.absolute, 0);

  if (dimension === 'mcp_server') {
    check(
      Math.abs(signed) <= Math.abs(comparison.spend.absolute) + 1e-6,
      `${dimension}: subset moved more than the gateway did`,
    );
  } else {
    check(
      Math.abs(signed - comparison.spend.absolute) < 1e-6,
      `${dimension}: movements sum to ${signed.toFixed(6)}, gateway moved ${comparison.spend.absolute.toFixed(6)}`,
    );
  }

  // Ranked by the size of the swing, either direction.
  const ordered = all.every(
    (row, index) =>
      index === 0 ||
      Math.abs(all[index - 1]?.spend.absolute ?? 0) >= Math.abs(row.spend.absolute) - 1e-12,
  );
  check(ordered, `${dimension}: movers are not ordered by absolute swing`);
  check(
    all.every((row) => row.spend.absolute !== 0),
    `${dimension}: an unmoved key leaked into the movers list`,
  );

  const top = all[0];
  if (top !== undefined) {
    const currentRow = rows.find((row) => row.key === top.key);
    check(
      Math.abs(top.spend.current - (currentRow?.metrics.spend ?? 0)) < 1e-9,
      `${dimension}/${top.key}: mover current spend != ranked row spend`,
    );
  }

  console.log(
    `  ${dimension.padEnd(11)} ${all.length} moved · top ${top?.key ?? '—'} ${top === undefined ? '' : `${top.spend.absolute >= 0 ? '+' : '−'}$${Math.abs(top.spend.absolute).toFixed(2)}`}`,
  );
}

// A key the prior window never saw has no ratio to report, only new dollars.
const newcomer = rankMovers(
  [{ key: '__fresh__', label: null, metrics: summary.totals, share: 1 }],
  prior.breakdowns,
  'model',
  5,
).find((row) => row.key === '__fresh__');
check(newcomer !== undefined, 'a key absent from the prior window did not rank as a mover');
check(newcomer?.spend.change === null, 'a key with no prior spend reported a percentage change');
check((newcomer?.spend.previous ?? -1) === 0, 'a key absent from the prior window had prior spend');

// And a key that vanished still ranks — the most interesting row in a review.
const vanishedKey = rankMovers([], prior.breakdowns, 'model', 5)[0];
check(vanishedKey !== undefined, 'a key present only in the prior window did not rank');
check((vanishedKey?.spend.current ?? -1) === 0, 'a vanished key reported current spend');
check(
  (vanishedKey?.spend.change ?? 0) === -1,
  `a vanished key should read as -100%, read ${vanishedKey?.spend.change}`,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log('\nall comparison invariants hold');
