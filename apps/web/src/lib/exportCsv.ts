import type { CopilotSeat } from '@dash/shared';
import type { Roster } from './metrics/roster.js';

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
 * A waste roster as a file — the handoff, since the dashboard mails nobody.
 *
 * Flat and complete: one row per person across every group, ignoring both the
 * paging and the expansion on screen. Grouping is a reading aid and a grouped
 * CSV cannot be pivoted; a paged one is worse, because it looks whole. All
 * three identity fields ride along whichever one the screen happens to be
 * grouped by, so the recipient can re-cut it without coming back.
 *
 * `detail` carries its own unit — dollars on the wasted roster, a last-active
 * label on the idle one — so the column is named by the caller rather than
 * assumed here. `noteHeader` is the same arrangement for the second fact: the
 * wasted roster passes one and gets a cohort column with it, since a cohort
 * without the date that produced it cannot be checked.
 */
const ROSTER_HEADERS = [
  'user_login',
  'name',
  'department',
  'b1_manager',
  'b2_manager',
] as const;

export function buildRosterCsv(roster: Roster, detailHeader: string, noteHeader?: string): string {
  const withNote = noteHeader !== undefined;
  const header = [
    ...ROSTER_HEADERS,
    ...(withNote ? ['cohort', noteHeader] : []),
    detailHeader,
  ].join(',');

  const rows = roster.groups.flatMap((group) =>
    group.people.map((person) =>
      [
        person.login,
        person.displayName,
        person.department,
        person.b1Manager,
        person.b2Manager,
        // Both fields ride on every row whichever way the screen is grouped —
        // a recipient who re-cuts the file by cohort must not have to come back
        // for the dates.
        ...(withNote ? [person.cohort ?? null, person.note ?? null] : []),
        person.detail,
      ]
        .map(escapeCell)
        .join(','),
    ),
  );

  return [header, ...rows].join('\n');
}

export function downloadRosterCsv(
  roster: Roster,
  detailHeader: string,
  filename: string,
  noteHeader?: string,
): void {
  download(buildRosterCsv(roster, detailHeader, noteHeader), filename);
}
