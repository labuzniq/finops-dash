import { GATEWAY_DIMENSION_LABELS } from '@dash/shared';
import type { CopilotSeat } from '@dash/shared';
import type { ChargebackStatement } from './metrics/gatewayChargeback.js';
import { monthLabel } from './metrics/gatewayChargeback.js';

/** Exports the seats currently in view — what you filtered is what you get. */

const HEADERS = [
  'user_login',
  'name',
  'plan',
  'editor',
  'language',
  'last_activity_days',
  'premium_requests_28d',
  'acceptance_rate',
] as const;

/** Quote every field and double any embedded quotes — RFC 4180. */
function escapeCell(value: string | number | null): string {
  if (value === null) return '';
  return `"${String(value).replace(/"/g, '""')}"`;
}

function toRow(seat: CopilotSeat): string {
  return [
    seat.login,
    seat.name,
    seat.plan,
    seat.editor,
    seat.language,
    seat.lastActivityDays,
    seat.premiumRequests28d,
    seat.acceptanceRate,
  ]
    .map(escapeCell)
    .join(',');
}

export function buildSeatsCsv(seats: readonly CopilotSeat[]): string {
  return [HEADERS.join(','), ...seats.map((seat) => toRow(seat))].join('\n');
}

function download(contents: string, filename: string): void {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(url);
}

export function downloadSeatsCsv(seats: readonly CopilotSeat[], rangeDays: number): void {
  download(buildSeatsCsv(seats), `copilot-seats-${rangeDays}d.csv`);
}

/**
 * The gateway chargeback statement as a file.
 *
 * Unlike the seats export, this one carries a **preamble**: once a statement
 * leaves the dashboard it is read by someone who cannot see the card it came
 * from, and a bare table of dollars invites exactly the two mistakes the card
 * spends its footnotes preventing — adding two dimensions' statements together,
 * and reading a month in flight as a month. The period, the dimension, the
 * gateway total and the unallocated remainder are therefore stated in the file
 * itself, above the rows, and every row's share is of the gateway total rather
 * than of the allocated sum so the numbers mean the same thing here as on
 * screen.
 *
 * The remainder is written as its own row rather than omitted: a spreadsheet
 * that sums the spend column must reproduce the gateway total, or the first
 * thing the recipient does with the file disagrees with the dashboard.
 */
const CHARGEBACK_HEADERS = [
  'key',
  'label',
  'spend_usd',
  'share_of_gateway',
  'requests',
  'failed_requests',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'cost_per_million_tokens',
  'prior_month_spend_usd',
  'change_vs_prior_month',
] as const;

export function buildChargebackCsv(statement: ChargebackStatement): string {
  const dimensionLabel = GATEWAY_DIMENSION_LABELS[statement.dimension];
  const preamble = [
    ['# LLM gateway chargeback statement'],
    ['# period', monthLabel(statement.month)],
    ['# period_days', `${statement.monthStart} .. ${statement.monthEnd}`],
    [
      '# period_status',
      statement.complete
        ? 'complete'
        : `in progress — reported through ${statement.through ?? 'no reported day'}`,
    ],
    ['# billed_by', dimensionLabel],
    ['# gateway_spend_usd', statement.total.spend.toFixed(2)],
    ['# allocated_usd', statement.allocated.spend.toFixed(2)],
    ['# unallocated_usd', statement.unallocated.spend.toFixed(2)],
    ['# allocation_coverage', statement.coverage.toFixed(4)],
    [
      '# note',
      'gateway breakdown dimensions overlap — do not combine this statement with one billed by another dimension',
    ],
  ].map((cells) => cells.map(escapeCell).join(','));

  const rows = statement.lines.map((line) =>
    [
      line.key,
      line.label,
      line.metrics.spend.toFixed(4),
      line.share.toFixed(6),
      line.metrics.requests,
      line.metrics.failedRequests,
      line.metrics.promptTokens,
      line.metrics.completionTokens,
      line.metrics.totalTokens,
      line.costPerMillion === null ? null : line.costPerMillion.toFixed(4),
      line.priorSpend === null ? null : line.priorSpend.toFixed(4),
      line.change === null ? null : line.change.toFixed(6),
    ]
      .map(escapeCell)
      .join(','),
  );

  // Always emitted, even at zero: a reader summing the column has to land on
  // the gateway total whether or not the dimension left anything behind.
  const remainder = [
    'unallocated',
    'No ' + dimensionLabel.toLowerCase() + ' attributed by the proxy',
    statement.unallocated.spend.toFixed(4),
    statement.total.spend > 0
      ? (statement.unallocated.spend / statement.total.spend).toFixed(6)
      : '0.000000',
    statement.unallocated.requests,
    statement.unallocated.failedRequests,
    statement.unallocated.promptTokens,
    statement.unallocated.completionTokens,
    statement.unallocated.totalTokens,
    null,
    null,
    null,
  ]
    .map(escapeCell)
    .join(',');

  return [...preamble, CHARGEBACK_HEADERS.join(','), ...rows, remainder].join('\n');
}

export function downloadChargebackCsv(statement: ChargebackStatement): void {
  download(
    buildChargebackCsv(statement),
    `llm-gateway-chargeback-${statement.month}-by-${statement.dimension}.csv`,
  );
}
