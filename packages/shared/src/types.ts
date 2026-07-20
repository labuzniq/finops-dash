/**
 * Domain types shared by the API and the web app.
 *
 * Nullability here is deliberate and mirrors what GitHub actually exposes.
 * See `docs/handoff.md` and `apps/api/src/copilot/github.ts` for which fields
 * a live org can fill and which stay null until a CSV import supplies them.
 */

export const PLANS = ['Business', 'Enterprise'] as const;
export type Plan = (typeof PLANS)[number];

export const EDITORS = ['VS Code', 'JetBrains', 'Visual Studio', 'Neovim', 'Xcode'] as const;
export type Editor = (typeof EDITORS)[number];

export const LANGUAGES = [
  'TypeScript',
  'Python',
  'Java',
  'Go',
  'C#',
  'Ruby',
  'Kotlin',
  'Rust',
] as const;
export type Language = (typeof LANGUAGES)[number];

/** One assigned Copilot seat, joined with its 28-day usage metrics. */
export interface CopilotSeat {
  /** GitHub login — the seat's stable identity. */
  login: string;
  name: string;
  plan: Plan;
  /** Dominant IDE from `totals_by_ide`; null when the seat has never been used. */
  editor: Editor | null;
  /**
   * Dominant language from `totals_by_language_model`. Free-form — GitHub
   * reports dozens (cpp, typescript, markdown, …), so this is not a closed set.
   * Null when the seat has no attributed language.
   */
  language: string | null;
  /** Days since `last_activity_at` (seats endpoint); null means never used. */
  lastActivityDays: number | null;
  /**
   * `ai_credits_used` over the 28-day window. Feeds the cost model as the
   * premium-request proxy. Null when the seat has no usage report.
   */
  premiumRequests28d: number | null;
  /** Percent of suggestions accepted (acceptances ÷ generations); null when no generations. */
  acceptanceRate: number | null;
  /** Whether the user invoked agent mode in the window. */
  usedAgent: boolean | null;
  /** Whether the user used chat in the window. */
  usedChat: boolean | null;
  /** Most-used model for this user in the window (e.g. `claude-sonnet-5`); null if none. */
  topModel: string | null;
}

/** One day of an org-level aggregate, from the `organization-1-day` report. */
export interface OrgDailyPoint {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  dailyActiveUsers: number;
  weeklyActiveUsers: number;
  monthlyActiveUsers: number;
  interactions: number;
  generations: number;
  acceptances: number;
  locAdded: number;
  locDeleted: number;
}

/** One day of per-model activity, from a daily report's `totals_by_language_model`. */
export interface ModelDailyPoint {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  /** GitHub model id, e.g. `claude-sonnet-5`, `gpt-5.3-codex`. */
  model: string;
  generations: number;
  acceptances: number;
  locAdded: number;
  locDeleted: number;
}

/** Per-model activity aggregated over a range — what the per-model view renders. */
export interface ModelUsage {
  model: string;
  generations: number;
  acceptances: number;
  locAdded: number;
  locDeleted: number;
  /** acceptances ÷ generations, or null when there are no generations. */
  acceptanceRate: number | null;
}

/** One day of org spend, split by the two things GitHub bills for. */
export interface SpendPoint {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  license: number;
  premiumOverage: number;
}

export const REFRESH_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;
export type RefreshStatus = (typeof REFRESH_STATUSES)[number];

/** An on-demand sync of the Copilot APIs into Postgres. */
export interface RefreshJob {
  id: string;
  status: RefreshStatus;
  /** ISO timestamp. */
  startedAt: string;
  /** ISO timestamp; null while the job is pending or running. */
  finishedAt: string | null;
  seatsSynced: number | null;
  error: string | null;
}

export const RANGE_DAYS = [28, 56, 90] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];

/**
 * The dashboard's selected time window. Presets slice the tail of the series
 * ("last N days"); a custom range is an inclusive pair of ISO calendar dates.
 * Fixed 28-day metrics (GitHub's `premiumRequests28d`) never re-slice — only
 * daily series respond to the selection.
 */
export type DateRange =
  | { kind: 'preset'; days: RangeDays }
  | { kind: 'custom'; from: string; to: string };

const MS_PER_DAY = 86_400_000;

/** `2026-04-17` at UTC midnight, so day arithmetic can't drift across DST. */
function utcDate(iso: string): number {
  const [year, month, day] = iso.split('-');
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

/** Number of days a range spans, inclusive of both endpoints. */
export function rangeDayCount(range: DateRange): number {
  if (range.kind === 'preset') return range.days;
  return Math.max(1, Math.round((utcDate(range.to) - utcDate(range.from)) / MS_PER_DAY) + 1);
}

/** Outcome of a manual CSV/JSON import. */
export interface ImportResult {
  /** Seats that did not exist before. */
  imported: number;
  /** Seats that already existed and were updated. */
  updated: number;
  /** Rows rejected for a validation problem. */
  skipped: number;
  /** Human-readable reasons for the first rejected rows. */
  errors: string[];
}
