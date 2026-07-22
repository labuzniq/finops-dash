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
  /**
   * Identity resolved at read time via `github_users` (login → saml_name_id)
   * and `jira_people` — the same join the spend page uses. `displayName`
   * falls back to the login and `mapped` is false when either hop misses.
   */
  samlNameId: string | null;
  displayName: string;
  department: string | null;
  b1Manager: string | null;
  b2Manager: string | null;
  mapped: boolean;
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
  /** Name of the team the seat was assigned through; null when assigned directly. */
  team: string | null;
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
  locSuggestedAdd: number;
  locSuggestedDelete: number;
  /** Users who used chat in the trailing month (`monthly_active_chat_users`). */
  chatMau: number;
  /** Users who used agent mode in the trailing month (`monthly_active_agent_users`). */
  agentMau: number;
  codeReviewDau: number;
  codeReviewWau: number;
  codeReviewMau: number;
  /** Passively reviewed (Copilot reviewed their PR without an explicit ask), trailing month. */
  codeReviewPassiveMau: number;
  cloudAgentDau: number;
  cloudAgentWau: number;
  cloudAgentMau: number;
  prCreated: number;
  prMerged: number;
  prCreatedByCopilot: number;
  prMergedCreatedByCopilot: number;
  prReviewedByCopilot: number;
  prCopilotSuggestions: number;
  prCopilotAppliedSuggestions: number;
}

export const USAGE_DIMENSIONS = ['ide', 'language', 'feature', 'model'] as const;
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

/**
 * One day of one category's activity within a breakdown dimension, from the
 * daily org report's `totals_by_*` arrays. `key` is free-form and lowercase as
 * GitHub emits it (`vscode`, `python`, `chat_panel_agent_mode`, model ids).
 */
export interface BreakdownPoint {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  dimension: UsageDimension;
  key: string;
  interactions: number;
  generations: number;
  acceptances: number;
  locAdded: number;
  locDeleted: number;
  locSuggestedAdd: number;
  locSuggestedDelete: number;
}

/** One day of one AI-adoption phase, from `totals_by_ai_adoption_phase`. */
export interface AdoptionPhasePoint {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  phaseNumber: number;
  /** GitHub's display label, e.g. `Phase 1`. */
  phase: string;
  engagedUsers: number;
  avgInteractions: number;
  avgGenerations: number;
  avgAcceptances: number;
  avgLocAdded: number;
  avgLocDeleted: number;
  avgPrCreated: number;
  avgPrReviewed: number;
}

/**
 * One day of one seat's activity. The mock source fills the full history; live
 * GitHub only covers what the users report exposes (per-user-per-day rows for
 * its trailing 28-day window), so older days simply have no rows.
 */
export interface UserDailyPoint {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  /** GitHub login — joins against `CopilotSeat.login`. */
  login: string;
  interactions: number;
  generations: number;
  acceptances: number;
  locAdded: number;
  locDeleted: number;
  locSuggestedAdd: number;
  locSuggestedDelete: number;
}

/** Everything `/api/usage` returns — full stored history, sliced client-side. */
export interface UsageHistory {
  orgDaily: OrgDailyPoint[];
  breakdowns: BreakdownPoint[];
  adoption: AdoptionPhasePoint[];
  /** Per-seat daily activity — lets the usage charts follow the seat filters. */
  userDaily: UserDailyPoint[];
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

export const REFRESH_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;
export type RefreshStatus = (typeof REFRESH_STATUSES)[number];

export const REFRESH_KINDS = ['copilot', 'jira'] as const;
export type RefreshKind = (typeof REFRESH_KINDS)[number];

/** An on-demand sync of an external source (Copilot APIs or JIRA Insight) into Postgres. */
export interface RefreshJob {
  id: string;
  kind: RefreshKind;
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
