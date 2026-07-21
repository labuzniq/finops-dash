import type { Editor, Plan, UsageDimension } from '@dash/shared';
import { eventDuration, moduleLogger } from '../log.js';
import { GithubApi } from './reports.js';
import type {
  AdoptionPhaseDailySnapshot,
  BreakdownDailySnapshot,
  CopilotClient,
  CopilotSnapshot,
  ModelDailySnapshot,
  OrgDailySnapshot,
  SeatSnapshot,
} from './types.js';

/**
 * Live GitHub Copilot client, built on the metrics **reports** API.
 *
 * GitHub exposes no dollar billing to this org (the usage endpoint 404s), and
 * no aggregate metrics JSON inline — instead the reports endpoints hand back
 * presigned NDJSON. This client stitches three sources into one snapshot:
 *
 *   • seats endpoint        → roster: login, name, plan, last activity
 *   • users-28-day report   → per-user metrics, joined onto the roster by login
 *   • organization-1-day    → per-day org + per-model aggregates (backfilled)
 *
 * See docs/github-integration.md for the report semantics (sharding, 204s,
 * presigned-link expiry, settle-then-freeze).
 */

const SEATS_PER_PAGE = 100;
/** Concurrent daily-report downloads during backfill. Well under the 5k/hr limit. */
const BACKFILL_CONCURRENCY = 6;
/** Report models/languages GitHub buckets as noise — excluded from "dominant" picks. */
const NOISE_LABELS = new Set(['others', 'unknown', 'none', '']);

const log = moduleLogger('copilot.github');

// --- Raw report record shapes (only the fields we read) ---------------------

interface GithubSeat {
  assignee: { login: string; name?: string | null } | null;
  plan_type?: string | null;
  last_activity_at?: string | null;
  last_activity_editor?: string | null;
  assigning_team?: { name?: string | null } | null;
}

interface GithubSeatsPage {
  total_seats: number;
  seats: GithubSeat[];
}

/** The numeric fields every `totals_by_*` entry may carry. */
interface RawTotals {
  user_initiated_interaction_count?: number;
  code_generation_activity_count?: number;
  code_acceptance_activity_count?: number;
  loc_added_sum?: number;
  loc_deleted_sum?: number;
  loc_suggested_to_add_sum?: number;
  loc_suggested_to_delete_sum?: number;
}

interface IdeTotals extends RawTotals {
  ide: string;
}

interface FeatureTotals extends RawTotals {
  feature: string;
}

interface LanguageModelTotals extends RawTotals {
  language: string;
  model: string;
}

interface ModelFeatureTotals extends RawTotals {
  model: string;
  feature?: string;
}

interface AdoptionPhaseTotals {
  phase?: string;
  phase_number?: number;
  total_engaged_users?: number;
  avg_user_initiated_interactions?: number;
  avg_code_generation_activities?: number;
  avg_code_acceptance_activities?: number;
  avg_loc_added?: number;
  avg_loc_deleted?: number;
  avg_pull_requests_created?: number;
  avg_pull_requests_reviewed?: number;
}

interface PullRequestTotals {
  total_created?: number;
  total_merged?: number;
  total_created_by_copilot?: number;
  total_merged_created_by_copilot?: number;
  total_reviewed_by_copilot?: number;
  total_copilot_suggestions?: number;
  total_copilot_applied_suggestions?: number;
}

interface UserReportRow {
  user_login: string;
  ai_credits_used?: number;
  used_agent?: boolean;
  used_chat?: boolean;
  code_generation_activity_count?: number;
  code_acceptance_activity_count?: number;
  totals_by_ide?: IdeTotals[];
  totals_by_language_model?: LanguageModelTotals[];
  totals_by_model_feature?: ModelFeatureTotals[];
}

interface OrgReportRow {
  day: string;
  daily_active_users?: number;
  weekly_active_users?: number;
  monthly_active_users?: number;
  monthly_active_chat_users?: number;
  monthly_active_agent_users?: number;
  daily_active_copilot_code_review_users?: number;
  weekly_active_copilot_code_review_users?: number;
  monthly_active_copilot_code_review_users?: number;
  monthly_passive_copilot_code_review_users?: number;
  daily_active_copilot_cloud_agent_users?: number;
  weekly_active_copilot_cloud_agent_users?: number;
  monthly_active_copilot_cloud_agent_users?: number;
  user_initiated_interaction_count?: number;
  code_generation_activity_count?: number;
  code_acceptance_activity_count?: number;
  loc_added_sum?: number;
  loc_deleted_sum?: number;
  loc_suggested_to_add_sum?: number;
  loc_suggested_to_delete_sum?: number;
  totals_by_ide?: IdeTotals[];
  totals_by_feature?: FeatureTotals[];
  totals_by_language_model?: LanguageModelTotals[];
  totals_by_model_feature?: ModelFeatureTotals[];
  totals_by_ai_adoption_phase?: AdoptionPhaseTotals[];
  pull_requests?: PullRequestTotals;
}

// --- Field parsing ----------------------------------------------------------

/** Map a free-form IDE string onto our closed Editor union, or null. */
function parseEditor(raw: string | null | undefined): Editor | null {
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (value.startsWith('vscode') || value.includes('visual studio code')) return 'VS Code';
  if (value.includes('visualstudio') || value.includes('visual studio')) return 'Visual Studio';
  if (
    value.includes('jetbrains') ||
    value.includes('intellij') ||
    value.includes('pycharm') ||
    value.includes('webstorm') ||
    value.includes('goland') ||
    value.includes('phpstorm') ||
    value.includes('rubymine') ||
    value.includes('clion') ||
    value.includes('rider') ||
    value.includes('datagrip') ||
    value.includes('android_studio') ||
    value.includes('android studio')
  ) {
    return 'JetBrains';
  }
  if (value.includes('neovim') || value.includes('vim')) return 'Neovim';
  if (value.includes('xcode')) return 'Xcode';
  return null;
}

function parsePlan(raw: string | null | undefined): Plan {
  // GitHub reports "business" | "enterprise" | "unknown"; bill unknown at the lower rate.
  return raw?.toLowerCase() === 'enterprise' ? 'Enterprise' : 'Business';
}

/** Pick the label with the most activity, skipping GitHub's noise buckets. */
function dominant<T>(items: T[], label: (t: T) => string, weight: (t: T) => number): string | null {
  let best: string | null = null;
  let bestWeight = -1;
  for (const item of items) {
    const name = label(item);
    if (NOISE_LABELS.has(name.toLowerCase())) continue;
    const w = weight(item);
    if (w > bestWeight) {
      bestWeight = w;
      best = name;
    }
  }
  return best;
}

function acceptanceRate(generations: number, acceptances: number): number | null {
  if (generations <= 0) return null;
  return Math.round((acceptances / generations) * 100);
}

/**
 * Merge `totals_by_*` entries into `into`, keyed by `keyOf`, summing every
 * numeric field. Non-numeric fields (version objects) keep the first value.
 */
function mergeTotals<T extends object>(
  into: Map<string, T>,
  items: readonly T[] | undefined,
  keyOf: (item: T) => string,
): void {
  for (const item of items ?? []) {
    const key = keyOf(item);
    const existing = into.get(key);
    if (!existing) {
      into.set(key, { ...item });
      continue;
    }
    const target = existing as Record<string, unknown>;
    for (const [field, value] of Object.entries(item)) {
      if (typeof value === 'number' && typeof target[field] === 'number') {
        target[field] = (target[field] as number) + value;
      }
    }
  }
}

/**
 * The users report has one row per user per *day*. Collapse a user's rows into
 * one 28-day aggregate before deriving metrics — keying by login alone would
 * keep only the last day seen.
 */
function aggregateUserRows(rows: readonly UserReportRow[]): UserReportRow {
  const first = rows[0]!;
  const ide = new Map<string, IdeTotals>();
  const langModel = new Map<string, LanguageModelTotals>();
  const modelFeature = new Map<string, ModelFeatureTotals>();
  let credits: number | undefined;
  let usedAgent: boolean | undefined;
  let usedChat: boolean | undefined;
  let generations = 0;
  let acceptances = 0;

  for (const row of rows) {
    if (row.ai_credits_used != null) credits = (credits ?? 0) + row.ai_credits_used;
    if (row.used_agent != null) usedAgent = (usedAgent ?? false) || row.used_agent;
    if (row.used_chat != null) usedChat = (usedChat ?? false) || row.used_chat;
    generations += row.code_generation_activity_count ?? 0;
    acceptances += row.code_acceptance_activity_count ?? 0;
    mergeTotals(ide, row.totals_by_ide, (item) => item.ide);
    mergeTotals(langModel, row.totals_by_language_model, (item) => `${item.language}\n${item.model}`);
    mergeTotals(modelFeature, row.totals_by_model_feature, (item) => `${item.model}\n${item.feature ?? ''}`);
  }

  return {
    user_login: first.user_login,
    ...(credits !== undefined ? { ai_credits_used: credits } : {}),
    ...(usedAgent !== undefined ? { used_agent: usedAgent } : {}),
    ...(usedChat !== undefined ? { used_chat: usedChat } : {}),
    code_generation_activity_count: generations,
    code_acceptance_activity_count: acceptances,
    totals_by_ide: [...ide.values()],
    totals_by_language_model: [...langModel.values()],
    totals_by_model_feature: [...modelFeature.values()],
  };
}

/** Derive the per-user metrics half of a seat from its users-report row. */
function metricsFromUserRow(row: UserReportRow): Partial<SeatSnapshot> {
  const ide = row.totals_by_ide ?? [];
  const langModel = row.totals_by_language_model ?? [];
  // model_feature covers chat/agent usage too, so it attributes a model to far
  // more users than the code-only language_model breakdown; language_model is
  // the fallback when a user only wrote code completions.
  const modelFeature = row.totals_by_model_feature ?? [];

  const topModel =
    dominant(
      modelFeature,
      (m) => m.model,
      (m) => (m.user_initiated_interaction_count ?? 0) + (m.code_generation_activity_count ?? 0),
    ) ??
    dominant(
      langModel,
      (l) => l.model,
      (l) => l.code_generation_activity_count ?? 0,
    );

  return {
    premiumRequests28d:
      row.ai_credits_used != null ? Math.round(row.ai_credits_used) : null,
    acceptanceRate: acceptanceRate(
      row.code_generation_activity_count ?? 0,
      row.code_acceptance_activity_count ?? 0,
    ),
    usedAgent: row.used_agent ?? null,
    usedChat: row.used_chat ?? null,
    editor: parseEditor(
      dominant(
        ide,
        (i) => i.ide,
        (i) => (i.code_generation_activity_count ?? 0) + (i.user_initiated_interaction_count ?? 0),
      ),
    ),
    language: dominant(
      langModel,
      (l) => l.language,
      (l) => l.code_generation_activity_count ?? 0,
    ),
    topModel,
  };
}

// --- Date helpers (report days are plain YYYY-MM-DD) ------------------------

function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, delta: number): string {
  const date = parseDay(day);
  date.setUTCDate(date.getUTCDate() + delta);
  return formatDay(date);
}

/** Run `fn` over items with bounded concurrency, preserving order. */
async function mapLimit<I, O>(
  items: I[],
  limit: number,
  fn: (item: I) => Promise<O>,
): Promise<O[]> {
  const results = new Array<O>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class GithubCopilotClient implements CopilotClient {
  readonly name = 'github';
  private readonly api: GithubApi;

  constructor(token: string, org: string, apiVersion: string) {
    this.api = new GithubApi(token, org, apiVersion);
  }

  async fetchSnapshot(historyDays: number): Promise<CopilotSnapshot> {
    const startedAt = Date.now();
    log.debug({ dash: { historyDays } }, 'fetching snapshot from github');

    // Roster and per-user metrics are independent; fetch them together.
    const [roster, userMetrics] = await Promise.all([
      this.fetchRoster(),
      this.fetchUserMetrics(),
    ]);
    log.debug(
      { dash: { rosterSeats: roster.length, reportedUsers: userMetrics.size } },
      'roster and user metrics fetched',
    );

    const seats = roster.map((seat) => {
      const metrics = userMetrics.get(seat.login);
      return metrics ? { ...seat, ...metrics } : seat;
    });

    const daily = await this.fetchDailyHistory(historyDays);

    log.info(
      {
        'event.action': 'github-snapshot',
        'event.outcome': 'success',
        'event.duration': eventDuration(startedAt),
        dash: {
          seats: seats.length,
          orgDays: daily.orgDaily.length,
        },
      },
      'github snapshot fetched',
    );

    return { seats, ...daily };
  }

  /** Paginate the seats endpoint into roster rows (no metrics yet). */
  private async fetchRoster(): Promise<SeatSnapshot[]> {
    const seats: SeatSnapshot[] = [];

    for (let page = 1; ; page++) {
      const result = await this.api.getJson<GithubSeatsPage>(
        `/orgs/${this.api.orgSlug}/copilot/billing/seats?per_page=${SEATS_PER_PAGE}&page=${page}`,
      );

      for (const seat of result.seats) {
        if (!seat.assignee) continue;
        seats.push({
          login: seat.assignee.login,
          name: seat.assignee.name?.trim() || seat.assignee.login,
          plan: parsePlan(seat.plan_type),
          editor: parseEditor(seat.last_activity_editor),
          language: null,
          lastActivityAt: seat.last_activity_at ? new Date(seat.last_activity_at) : null,
          premiumRequests28d: null,
          acceptanceRate: null,
          usedAgent: null,
          usedChat: null,
          topModel: null,
          team: seat.assigning_team?.name?.trim() || null,
        });
      }

      if (result.seats.length < SEATS_PER_PAGE || seats.length >= result.total_seats) break;
    }

    return seats;
  }

  /** users-28-day report → metrics keyed by login. Empty map if no report yet. */
  private async fetchUserMetrics(): Promise<Map<string, Partial<SeatSnapshot>>> {
    const report = await this.api.fetchReport<UserReportRow>('users-28-day/latest');
    const map = new Map<string, Partial<SeatSnapshot>>();
    if (!report) return map;

    const byLogin = new Map<string, UserReportRow[]>();
    for (const row of report.rows) {
      if (!row.user_login) continue;
      const rows = byLogin.get(row.user_login);
      if (rows) rows.push(row);
      else byLogin.set(row.user_login, [row]);
    }

    for (const [login, rows] of byLogin) {
      map.set(login, metricsFromUserRow(aggregateUserRows(rows)));
    }
    return map;
  }

  /**
   * Backfill up to `historyDays` of daily org reports, anchored on the newest
   * settled day. Days with no report (204) are skipped; the org's history floor
   * therefore falls out naturally as the empty tail.
   */
  private async fetchDailyHistory(
    historyDays: number,
  ): Promise<Omit<CopilotSnapshot, 'seats'>> {
    const anchor = await this.newestReportDay();
    const days = Array.from({ length: historyDays }, (_, i) => addDays(anchor, -i));
    log.debug(
      { dash: { anchorDay: anchor, daysRequested: days.length } },
      'backfilling daily org reports',
    );

    const reports = await mapLimit(days, BACKFILL_CONCURRENCY, async (day) => {
      const report = await this.api.fetchReport<OrgReportRow>(
        `organization-1-day?day=${day}`,
      );
      return report?.rows[0] ?? null;
    });
    log.debug(
      { dash: { daysRequested: days.length, daysWithReports: reports.filter(Boolean).length } },
      'daily org reports downloaded',
    );

    const orgDaily: OrgDailySnapshot[] = [];
    const modelDaily: ModelDailySnapshot[] = [];
    const breakdownDaily: BreakdownDailySnapshot[] = [];
    const adoptionDaily: AdoptionPhaseDailySnapshot[] = [];

    for (const row of reports) {
      if (!row) continue;
      orgDaily.push(orgSnapshot(row));
      modelDaily.push(...modelSnapshots(row));
      breakdownDaily.push(...breakdownSnapshots(row));
      adoptionDaily.push(...adoptionSnapshots(row));
    }

    orgDaily.sort((a, b) => a.date.localeCompare(b.date));
    modelDaily.sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model));
    breakdownDaily.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.dimension.localeCompare(b.dimension) ||
        a.key.localeCompare(b.key),
    );
    adoptionDaily.sort((a, b) => a.date.localeCompare(b.date) || a.phaseNumber - b.phaseNumber);
    return { orgDaily, modelDaily, breakdownDaily, adoptionDaily };
  }

  /** The newest day that has a report — from the 28-day window's end, else yesterday. */
  private async newestReportDay(): Promise<string> {
    const latest = await this.api.fetchReport<OrgReportRow>('organization-28-day/latest');
    if (latest?.envelope.report_end_day) return latest.envelope.report_end_day;
    return addDays(formatDay(new Date()), -1);
  }
}

function orgSnapshot(row: OrgReportRow): OrgDailySnapshot {
  const pr = row.pull_requests;
  return {
    date: row.day,
    dailyActiveUsers: row.daily_active_users ?? 0,
    weeklyActiveUsers: row.weekly_active_users ?? 0,
    monthlyActiveUsers: row.monthly_active_users ?? 0,
    interactions: row.user_initiated_interaction_count ?? 0,
    generations: row.code_generation_activity_count ?? 0,
    acceptances: row.code_acceptance_activity_count ?? 0,
    locAdded: row.loc_added_sum ?? 0,
    locDeleted: row.loc_deleted_sum ?? 0,
    locSuggestedAdd: row.loc_suggested_to_add_sum ?? 0,
    locSuggestedDelete: row.loc_suggested_to_delete_sum ?? 0,
    chatMau: row.monthly_active_chat_users ?? 0,
    agentMau: row.monthly_active_agent_users ?? 0,
    codeReviewDau: row.daily_active_copilot_code_review_users ?? 0,
    codeReviewWau: row.weekly_active_copilot_code_review_users ?? 0,
    codeReviewMau: row.monthly_active_copilot_code_review_users ?? 0,
    codeReviewPassiveMau: row.monthly_passive_copilot_code_review_users ?? 0,
    cloudAgentDau: row.daily_active_copilot_cloud_agent_users ?? 0,
    cloudAgentWau: row.weekly_active_copilot_cloud_agent_users ?? 0,
    cloudAgentMau: row.monthly_active_copilot_cloud_agent_users ?? 0,
    prCreated: pr?.total_created ?? 0,
    prMerged: pr?.total_merged ?? 0,
    prCreatedByCopilot: pr?.total_created_by_copilot ?? 0,
    prMergedCreatedByCopilot: pr?.total_merged_created_by_copilot ?? 0,
    prReviewedByCopilot: pr?.total_reviewed_by_copilot ?? 0,
    prCopilotSuggestions: pr?.total_copilot_suggestions ?? 0,
    prCopilotAppliedSuggestions: pr?.total_copilot_applied_suggestions ?? 0,
  };
}

/** Fold one `totals_by_*` entry into the day's per-(dimension, key) accumulator. */
function accumulateBreakdown(
  into: Map<string, BreakdownDailySnapshot>,
  date: string,
  dimension: UsageDimension,
  key: string | undefined,
  item: RawTotals,
): void {
  if (!key || NOISE_LABELS.has(key.toLowerCase())) return;
  const mapKey = `${dimension}\n${key}`;
  const acc =
    into.get(mapKey) ??
    {
      date,
      dimension,
      key,
      interactions: 0,
      generations: 0,
      acceptances: 0,
      locAdded: 0,
      locDeleted: 0,
      locSuggestedAdd: 0,
      locSuggestedDelete: 0,
    };
  acc.interactions += item.user_initiated_interaction_count ?? 0;
  acc.generations += item.code_generation_activity_count ?? 0;
  acc.acceptances += item.code_acceptance_activity_count ?? 0;
  acc.locAdded += item.loc_added_sum ?? 0;
  acc.locDeleted += item.loc_deleted_sum ?? 0;
  acc.locSuggestedAdd += item.loc_suggested_to_add_sum ?? 0;
  acc.locSuggestedDelete += item.loc_suggested_to_delete_sum ?? 0;
  into.set(mapKey, acc);
}

/**
 * One day's breakdown rows across all four dimensions. The composite arrays
 * collapse to their primary axis: language from language×model, model from
 * model×feature (which also covers chat-only usage).
 */
function breakdownSnapshots(row: OrgReportRow): BreakdownDailySnapshot[] {
  const map = new Map<string, BreakdownDailySnapshot>();
  for (const item of row.totals_by_ide ?? []) {
    accumulateBreakdown(map, row.day, 'ide', item.ide, item);
  }
  for (const item of row.totals_by_feature ?? []) {
    accumulateBreakdown(map, row.day, 'feature', item.feature, item);
  }
  for (const item of row.totals_by_language_model ?? []) {
    accumulateBreakdown(map, row.day, 'language', item.language, item);
  }
  for (const item of row.totals_by_model_feature ?? []) {
    accumulateBreakdown(map, row.day, 'model', item.model, item);
  }
  return [...map.values()];
}

function adoptionSnapshots(row: OrgReportRow): AdoptionPhaseDailySnapshot[] {
  const phases: AdoptionPhaseDailySnapshot[] = [];
  for (const item of row.totals_by_ai_adoption_phase ?? []) {
    if (item.phase_number == null) continue;
    phases.push({
      date: row.day,
      phaseNumber: item.phase_number,
      phase: item.phase ?? `Phase ${item.phase_number}`,
      engagedUsers: item.total_engaged_users ?? 0,
      avgInteractions: item.avg_user_initiated_interactions ?? 0,
      avgGenerations: item.avg_code_generation_activities ?? 0,
      avgAcceptances: item.avg_code_acceptance_activities ?? 0,
      avgLocAdded: item.avg_loc_added ?? 0,
      avgLocDeleted: item.avg_loc_deleted ?? 0,
      avgPrCreated: item.avg_pull_requests_created ?? 0,
      avgPrReviewed: item.avg_pull_requests_reviewed ?? 0,
    });
  }
  return phases;
}

/** Collapse a day's totals_by_language_model into one row per model. */
function modelSnapshots(row: OrgReportRow): ModelDailySnapshot[] {
  const byModel = new Map<string, ModelDailySnapshot>();

  for (const item of row.totals_by_language_model ?? []) {
    const model = item.model;
    if (!model || NOISE_LABELS.has(model.toLowerCase())) continue;

    const acc =
      byModel.get(model) ??
      { date: row.day, model, generations: 0, acceptances: 0, locAdded: 0, locDeleted: 0 };
    acc.generations += item.code_generation_activity_count ?? 0;
    acc.acceptances += item.code_acceptance_activity_count ?? 0;
    acc.locAdded += item.loc_added_sum ?? 0;
    acc.locDeleted += item.loc_deleted_sum ?? 0;
    byModel.set(model, acc);
  }

  return [...byModel.values()];
}
