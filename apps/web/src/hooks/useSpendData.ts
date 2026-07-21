import { useQuery } from '@tanstack/react-query';
import type { DateRange, SpendPayload } from '@dash/shared';
import { fetchSpend } from '../api/client.js';

/**
 * The spend payload for the selected range — fetched once, everything on the
 * spend section (KPIs, trend, model breakdown, user table) derived client-side
 * by the pure functions in lib/metrics/spend.ts and spendFilter.ts.
 */

/** ISO date shifted by `days` (negative shifts backwards), in UTC. */
function shiftIso(iso: string, days: number): string {
  const [year, month, day] = iso.split('-');
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days))
    .toISOString()
    .slice(0, 10);
}

/**
 * Concrete inclusive ISO bounds for a range — presets anchor on today, so the
 * API query and the trend's zero-fill spine agree on the same calendar days.
 */
export function spendRangeBounds(range: DateRange): { from: string; to: string } {
  if (range.kind === 'custom') return { from: range.from, to: range.to };
  const to = new Date().toISOString().slice(0, 10);
  return { from: shiftIso(to, -(range.days - 1)), to };
}

export function useSpendData(range: DateRange) {
  const { from, to } = spendRangeBounds(range);
  return useQuery<SpendPayload>({
    queryKey: ['spend', from, to],
    queryFn: () => fetchSpend(from, to),
  });
}
