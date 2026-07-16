import { seatPeriodCost } from '@dash/shared';
import type { CopilotSeat } from '@dash/shared';

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
  'period_cost_usd',
] as const;

/** Quote every field and double any embedded quotes — RFC 4180. */
function escapeCell(value: string | number | null): string {
  if (value === null) return '';
  return `"${String(value).replace(/"/g, '""')}"`;
}

function toRow(seat: CopilotSeat, rangeDays: number): string {
  return [
    seat.login,
    seat.name,
    seat.plan,
    seat.editor,
    seat.language,
    seat.lastActivityDays,
    seat.premiumRequests28d,
    seat.acceptanceRate,
    seatPeriodCost(seat, rangeDays).toFixed(2),
  ]
    .map(escapeCell)
    .join(',');
}

export function buildSeatsCsv(seats: readonly CopilotSeat[], rangeDays: number): string {
  return [HEADERS.join(','), ...seats.map((seat) => toRow(seat, rangeDays))].join('\n');
}

export function downloadSeatsCsv(seats: readonly CopilotSeat[], rangeDays: number): void {
  const blob = new Blob([buildSeatsCsv(seats, rangeDays)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `copilot-seats-${rangeDays}d.csv`;
  link.click();

  URL.revokeObjectURL(url);
}
