/**
 * Ad-hoc check of the web app's chargeback statement against a real mock-source
 * payload. Not a test suite (the repo has none) — run it by hand:
 *
 *   node_modules/.pnpm/node_modules/.bin/tsx apps/api/scripts/verify-gateway-chargeback.ts
 *
 * It sits outside apps/api's tsconfig `include` on purpose: it imports the web
 * app's metrics modules, which do not belong in the API's build.
 *
 * A statement is the one gateway surface that has to *add up*, so that is what
 * this proves:
 *
 * - the lines plus the unallocated remainder reproduce the month's gateway
 *   spend to the cent, on every payer dimension the proxy answered — and every
 *   other counter reconciles the same way, not just the dollars;
 * - the statement is measured over the calendar month and nothing else:
 *   re-deriving it from a payload pulled over a *different* window yields the
 *   identical bill, which is what makes the number quotable;
 * - the period arithmetic is right where it is easy to get wrong — month ends
 *   including leap February, the retention floor, and the prior-month window
 *   for a month still running (a bill twelve days in is compared against twelve
 *   days of the month before, not against the whole of it);
 * - coverage means what the card says: a full-coverage dimension leaves nothing
 *   unallocated, while a dimension the proxy only partly attributes leaves a
 *   remainder equal to exactly what it did not attribute;
 * - the exported CSV is the same statement — parsed back, its spend column sums
 *   to the gateway total, which is the first thing a recipient does with it;
 * - the edges behave: an unreported month, a month with one day, a dimension
 *   with no rows, and a payload that over-attributes.
 */
import { MockGatewayClient } from '../src/gateway/mock.js';
import { nanoToDollars } from '../src/lib/nano.js';
import { sumGatewayMetrics } from '@dash/shared';
import type { GatewayBreakdownPoint, GatewayDailyPoint, GatewayUsage } from '@dash/shared';
import {
  CHARGEBACK_DIMENSIONS,
  chargebackMonths,
  chargebackRange,
  deriveChargeback,
  monthLabel,
} from '../../web/src/lib/metrics/gatewayChargeback.js';
import type {
  ChargebackDimension,
  ChargebackStatement,
} from '../../web/src/lib/metrics/gatewayChargeback.js';
import { buildChargebackCsv } from '../../web/src/lib/exportCsv.js';

const MS_PER_DAY = 86_400_000;
const RETENTION_DAYS = 90;

function iso(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
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
const close = (a: number, b: number, tolerance = 0.005) => Math.abs(a - b) <= tolerance;
const money = (value: number) => `$${value.toFixed(2)}`;

const today = iso(0);
const floor = iso(-(RETENTION_DAYS - 1));

// ------------------------------------------------------ 1. period arithmetic

const months = chargebackMonths(today, floor);
check(months.length >= 2, `only ${months.length} billable month(s) inside retention`);
check(months[0] === today.slice(0, 7), `newest offered month is ${months[0]}, not this one`);
check(
  months.every((month, index) => index === 0 || month < (months[index - 1] ?? '')),
  'months are not newest-first',
);
check(
  months.every((month) => `${month}-01` >= floor),
  'a month starting outside retention was offered',
);

// Month ends, including the one that is only right every fourth year.
const leap = chargebackRange('2024-02', '2026-07-31', '2000-01-01');
check(leap.monthEnd === '2024-02-29', `2024-02 ends ${leap.monthEnd}, not the 29th`);
const common = chargebackRange('2023-02', '2026-07-31', '2000-01-01');
check(common.monthEnd === '2023-02-28', `2023-02 ends ${common.monthEnd}, not the 28th`);
const january = chargebackRange('2026-01', '2026-07-31', '2000-01-01');
check(
  january.priorStart === '2025-12-01' && january.priorEnd === '2025-12-31',
  `January's prior month is ${january.priorStart}..${january.priorEnd}`,
);
check(january.from === '2025-12-01', 'the fetch window does not open on the prior month');

// The fetch never reaches past what the proxy retains.
const clamped = chargebackRange(months[0] ?? today.slice(0, 7), today, `${months[0]}-01`);
check(
  !clamped.priorComparable && clamped.from === clamped.monthStart,
  'a prior month outside retention was still fetched',
);

// --------------------------------------------------------- 2. a real payload

// One pull covering every offered month, so each statement is sliced out of
// the same generated history — the mock's Lehmer stream is window-dependent,
// so two pulls would disagree about the same calendar day.
const wide = await pull(floor, today);
const billMonth = months[1] ?? months[0] ?? today.slice(0, 7);
const range = chargebackRange(billMonth, today, floor);

console.log(`billing ${monthLabel(billMonth)} · ${range.monthStart} … ${range.monthEnd}`);

const answered = new Set(wide.breakdowns.map((point) => point.dimension as string));
const dimensions = CHARGEBACK_DIMENSIONS.filter((dimension) => answered.has(dimension));
check(dimensions.length > 0, 'the mock answered no payer dimension at all');

const statements = new Map<ChargebackDimension, ChargebackStatement>();
for (const dimension of dimensions) {
  statements.set(dimension, deriveChargeback(wide.daily, wide.breakdowns, range, dimension));
}

const anyStatement = statements.get(dimensions[0] as ChargebackDimension);
if (anyStatement === undefined) {
  console.error('no statement derived — nothing to check');
  process.exit(1);
}
check(anyStatement.total.spend > 0, 'the billed month carries no spend in the mock');
console.log(
  `gateway ${money(anyStatement.total.spend)} over ${anyStatement.reportedDays} reported days ` +
    `(complete: ${anyStatement.complete})\n`,
);

// --------------------------------------------- 3. the statement reconciles

for (const [dimension, statement] of statements) {
  const lines = sumGatewayMetrics(statement.lines.map((line) => line.metrics));

  check(
    close(lines.spend + statement.unallocated.spend, statement.total.spend),
    `${dimension}: lines ${money(lines.spend)} + unallocated ${money(
      statement.unallocated.spend,
    )} ≠ gateway ${money(statement.total.spend)}`,
  );
  check(statement.reconciles, `${dimension}: statement reports itself as not reconciling`);
  check(
    close(lines.spend, statement.allocated.spend),
    `${dimension}: allocated total disagrees with the lines it is a sum of`,
  );

  // Not just the dollars: a statement's evidence columns have to add up too,
  // or a department can dispute the tokens behind a line it cannot dispute.
  check(
    lines.requests + statement.unallocated.requests === statement.total.requests,
    `${dimension}: requests do not reconcile`,
  );
  check(
    lines.totalTokens + statement.unallocated.totalTokens === statement.total.totalTokens,
    `${dimension}: tokens do not reconcile`,
  );

  // Shares are of the gateway total, like every other share on the page.
  const shareSum = statement.lines.reduce((sum, line) => sum + line.share, 0);
  check(
    close(shareSum, statement.coverage, 1e-6),
    `${dimension}: line shares sum to ${(shareSum * 100).toFixed(2)}% but coverage is ${(
      statement.coverage * 100
    ).toFixed(2)}%`,
  );

  check(
    statement.lines.every(
      (line, index) => index === 0 || line.metrics.spend <= (statement.lines[index - 1]?.metrics.spend ?? Infinity) + 1e-9,
    ),
    `${dimension}: lines are not ranked by spend`,
  );

  console.log(
    `  ${dimension.padEnd(8)} ${String(statement.lines.length).padStart(3)} lines · ` +
      `allocated ${money(statement.allocated.spend).padStart(10)} · ` +
      `unallocated ${money(statement.unallocated.spend).padStart(9)} · ` +
      `coverage ${(statement.coverage * 100).toFixed(1)}%`,
  );
}

// The mock tags every call with a key, a team and a tag, so those three must
// leave nothing behind; `user` need not, and the card is built for that.
const byKey = statements.get('api_key');
if (byKey !== undefined) {
  check(
    close(byKey.unallocated.spend, 0),
    `api_key left ${money(byKey.unallocated.spend)} unallocated — every call carries a key`,
  );
  check(byKey.coverage > 0.999, `api_key coverage is ${(byKey.coverage * 100).toFixed(2)}%`);
}

// ------------------------------------- 4. the month, and only the month

// The bill is measured over the calendar month whatever else the payload
// carries. Checked *within one pull* rather than against a second one: the
// mock's Lehmer stream is consumed from the window start, so re-fetching a
// different range redraws the same calendar day and the comparison would
// measure the generator instead of the derivation.
const primary = dimensions[0] as ChargebackDimension;
const wideStatement = statements.get(primary);
check(
  wideStatement !== undefined &&
    close(
      sumGatewayMetrics(
        wide.daily.filter((day) => day.date >= range.monthStart && day.date <= range.monthEnd),
      ).spend,
      wideStatement.total.spend,
    ),
  'the month total is not the sum of the month days',
);

// Trimming everything outside the two months changes nothing…
const trimmed = deriveChargeback(
  wide.daily.filter((day) => day.date >= range.priorStart && day.date <= range.monthEnd),
  wide.breakdowns.filter(
    (row) => row.date >= range.priorStart && row.date <= range.monthEnd,
  ),
  range,
  primary,
);
// …and neither does a day from six months away.
const padded = deriveChargeback(
  [...wide.daily, { ...(wide.daily[0] as GatewayDailyPoint), date: '2026-01-15', spend: 99_999 }],
  [
    ...wide.breakdowns,
    { ...(wide.breakdowns[0] as GatewayBreakdownPoint), date: '2026-01-15', spend: 99_999 },
  ],
  range,
  primary,
);
check(
  wideStatement !== undefined &&
    close(trimmed.total.spend, wideStatement.total.spend) &&
    trimmed.lines.length === wideStatement.lines.length,
  'days outside the two months change the bill',
);
check(
  wideStatement !== undefined &&
    close(padded.total.spend, wideStatement.total.spend) &&
    padded.lines.length === wideStatement.lines.length,
  'a day from another month leaked into the bill',
);

// ------------------------------------------------ 5. the prior-month window

// The 90-day retention floor puts May 1st out of reach of a 90-day pull, so
// the live payload above correctly refuses a prior-month column. Pulling the
// two months directly — one pull, one draw sequence — is what exercises it.
const paired = await pull(range.priorStart, range.monthEnd);
const priorRef = deriveChargeback(
  paired.daily,
  paired.breakdowns,
  chargebackRange(billMonth, today, '2000-01-01'),
  primary,
);
check(priorRef.priorTo !== null, 'a payload covering both months still refuses the prior column');

if (priorRef.priorTo !== null && priorRef.priorFrom !== null) {
  check(
    priorRef.priorFrom === range.priorStart,
    `prior window opens ${priorRef.priorFrom}, not on the prior month's first day`,
  );
  check(
    priorRef.priorTo <= range.priorEnd,
    `prior window closes ${priorRef.priorTo}, past the prior month`,
  );
  check(
    priorRef.complete ? !priorRef.priorPartial : priorRef.priorPartial,
    'a complete month reports a partial prior window (or the reverse)',
  );

  const priorSum = sumGatewayMetrics(
    paired.daily.filter(
      (day) => day.date >= (priorRef.priorFrom ?? '') && day.date <= (priorRef.priorTo ?? ''),
    ),
  ).spend;
  check(
    close(priorRef.priorTotalSpend ?? -1, priorSum),
    `prior total ${money(priorRef.priorTotalSpend ?? 0)} ≠ the days it claims to cover ${money(
      priorSum,
    )}`,
  );

  const lineSum = priorRef.lines.reduce((sum, line) => sum + (line.priorSpend ?? 0), 0);
  check(
    lineSum <= priorSum + 0.005,
    `per-line prior spend ${money(lineSum)} exceeds the prior window's gateway spend ${money(
      priorSum,
    )}`,
  );
}

// A month still running must be cut against the same number of days, not
// against the whole prior month — checked on a constructed payload where the
// two answers differ by construction.
{
  const days: GatewayDailyPoint[] = [];
  const rows: GatewayBreakdownPoint[] = [];
  const flat = {
    requests: 10,
    successfulRequests: 10,
    failedRequests: 0,
    promptTokens: 1_000,
    completionTokens: 100,
    totalTokens: 1_100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  // June: 30 days at $10. July: 10 days at $10, then the sync stops.
  for (let day = 1; day <= 30; day += 1) {
    const date = `2026-06-${String(day).padStart(2, '0')}`;
    days.push({ date, spend: 10, ...flat });
    rows.push({ date, dimension: 'team', key: 'platform', label: 'Platform', spend: 10, ...flat });
  }
  for (let day = 1; day <= 10; day += 1) {
    const date = `2026-07-${String(day).padStart(2, '0')}`;
    days.push({ date, spend: 10, ...flat });
    rows.push({ date, dimension: 'team', key: 'platform', label: 'Platform', spend: 10, ...flat });
  }

  const july = chargebackRange('2026-07', '2026-07-11', '2026-01-01');
  const partial = deriveChargeback(days, rows, july, 'team');

  check(!partial.complete, 'a month reported through the 10th reads as complete');
  check(partial.priorPartial, 'a month in flight was compared against the whole prior month');
  check(
    partial.priorTo === '2026-06-10',
    `prior window closes ${partial.priorTo}, not on the matching day-of-month`,
  );
  check(
    close(partial.priorTotalSpend ?? -1, 100),
    `prior spend ${money(partial.priorTotalSpend ?? 0)} — the first ten June days are $100`,
  );
  check(
    close(partial.lines[0]?.priorSpend ?? -1, 100) && partial.lines[0]?.change === 0,
    'a flat gateway reads as a change once the windows are cut to the same length',
  );

  // The same July, once it has finished, compares against the whole of June.
  const closed = deriveChargeback(
    [...days, ...Array.from({ length: 21 }, (_, index) => ({
      date: `2026-07-${String(index + 11).padStart(2, '0')}`,
      spend: 10,
      ...flat,
    }))],
    rows,
    chargebackRange('2026-07', '2026-08-01', '2026-01-01'),
    'team',
  );
  check(closed.complete, 'a fully reported month does not read as complete');
  check(!closed.priorPartial, 'a complete month still cuts the prior month short');
  check(
    close(closed.priorTotalSpend ?? -1, 300),
    `a complete July compares against ${money(closed.priorTotalSpend ?? 0)}, not all $300 of June`,
  );
}

// --------------------------------------------------------------- 6. the file

{
  const statement = statements.get(dimensions[0] as ChargebackDimension);
  if (statement !== undefined) {
    const csv = buildChargebackCsv(statement);
    const lines = csv.split('\n');
    const preamble = lines.filter((line) => line.startsWith('"#'));
    check(preamble.length >= 8, `the export carries only ${preamble.length} preamble lines`);
    check(
      csv.includes('do not combine this statement'),
      'the export does not carry the overlap warning',
    );

    const header = lines.findIndex((line) => line.startsWith('key,'));
    check(header > 0, 'the export has no header row');

    const body = lines.slice(header + 1);
    check(
      body.length === statement.lines.length + 1,
      `the export carries ${body.length} rows for ${statement.lines.length} lines + remainder`,
    );
    check(
      body.at(-1)?.startsWith('"unallocated"') === true,
      'the remainder is not the last row of the export',
    );

    // What the recipient does first: sum the spend column.
    const summed = body.reduce((sum, line) => {
      const cell = line.split('","')[2] ?? '0';
      return sum + Number(cell.replace(/"/g, ''));
    }, 0);
    check(
      close(summed, statement.total.spend, 0.01),
      `the export's spend column sums to ${money(summed)}, not to the gateway's ${money(
        statement.total.spend,
      )}`,
    );

    // RFC 4180: a label carrying a quote or a comma must survive.
    const awkward: ChargebackStatement = {
      ...statement,
      lines: [
        {
          key: 'team,with"quote',
          label: 'Risk, "Markets"',
          metrics: statement.total,
          share: 1,
          costPerMillion: 1,
          priorSpend: 0,
          change: null,
        },
      ],
    };
    const escaped = buildChargebackCsv(awkward);
    check(
      escaped.includes('"team,with""quote"') && escaped.includes('"Risk, ""Markets"""'),
      'commas and quotes in a key or label are not escaped',
    );
  }
}

// --------------------------------------------------------------- 7. the edges

{
  const empty = deriveChargeback([], [], range, 'team');
  check(empty.total.spend === 0 && empty.lines.length === 0, 'an empty month bills something');
  check(empty.through === null && !empty.complete, 'an unreported month reads as complete');
  check(empty.coverage === 0 && empty.reconciles, 'an empty month does not reconcile');
  check(empty.priorTotalSpend === null, 'an unreported month claims a prior total');

  const oneDay: GatewayDailyPoint[] = [
    {
      date: `${billMonth}-01`,
      spend: 5,
      requests: 1,
      successfulRequests: 1,
      failedRequests: 0,
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  ];
  const thin = deriveChargeback(oneDay, [], range, 'team');
  check(thin.reportedDays === 1, `a one-day month reports ${thin.reportedDays} days`);
  check(
    close(thin.unallocated.spend, 5) && thin.coverage === 0,
    'a month with no breakdown rows does not fall entirely into the remainder',
  );

  // A dimension attributing more than the gateway saw is a proxy-side
  // contradiction: clamped so no negative remainder is drawn, and surfaced.
  const over = deriveChargeback(
    oneDay,
    [
      {
        date: `${billMonth}-01`,
        dimension: 'team',
        key: 'platform',
        label: null,
        spend: 9,
        requests: 1,
        successfulRequests: 1,
        failedRequests: 0,
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ],
    range,
    'team',
  );
  check(over.unallocated.spend === 0, 'an over-attributed month draws a negative remainder');
  check(!over.reconciles, 'an over-attributed month claims to reconcile');
  check(over.coverage === 1, `over-attribution reports coverage of ${over.coverage}`);
}

// ------------------------------------------------------------------- verdict

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('\nall chargeback checks passed');
