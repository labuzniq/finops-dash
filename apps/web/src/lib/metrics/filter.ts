import type { CopilotSeat, Editor } from '@dash/shared';

/** The "no filter" sentinel shared by the editor and language selects. */
export const ALL = 'All';
export type All = typeof ALL;

export type EditorFilter = Editor | All;
/** Language is free-form (GitHub emits dozens), so the filter is any string. */
export type LanguageFilter = string;

/** Distinct languages present in the roster, sorted — populates the filter select. */
export function seatLanguages(seats: readonly CopilotSeat[]): string[] {
  const set = new Set<string>();
  for (const seat of seats) {
    if (seat.language) set.add(seat.language);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export interface SeatFilters {
  editor: EditorFilter;
  language: LanguageFilter;
  search: string;
}

/** Case-insensitive match on either display name or login. */
function matchesSearch(seat: CopilotSeat, query: string): boolean {
  if (query === '') return true;
  return seat.login.includes(query) || seat.name.toLowerCase().includes(query);
}

export function filterSeats(seats: readonly CopilotSeat[], filters: SeatFilters): CopilotSeat[] {
  const query = filters.search.trim().toLowerCase();

  return seats.filter(
    (seat) =>
      (filters.editor === ALL || seat.editor === filters.editor) &&
      (filters.language === ALL || seat.language === filters.language) &&
      matchesSearch(seat, query),
  );
}
