import type { Editor, Plan } from '@dash/shared';
import { GithubApi } from './reports.js';
import type {
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

// --- Raw report record shapes (only the fields we read) ---------------------

interface GithubSeat {
  assignee: { login: string; name?: string | null } | null;
  plan_type?: string | null;
  last_activity_at?: string | null;
  last_activity_editor?: string | null;
}

interface GithubSeatsPage {
  total_seats: number;
  seats: GithubSeat[];
}

interface IdeTotals {
  ide: string;
  user_initiated_interaction_count?: number;
  code_generation_activity_count?: number;
}

interface LanguageModelTotals {
  language: string;
  model: string;
  code_generation_activity_count?: number;
  code_acceptance_activity_count?: number;
  loc_added_sum?: number;
  loc_deleted_sum?: number;
}

interface ModelFeatureTotals {
  model: string;
  feature?: string;
  user_initiated_interaction_count?: number;
  code_generation_activity_count?: number;
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
  user_initiated_interaction_count?: number;
  code_generation_activity_count?: number;
  code_acceptance_activity_count?: number;
  loc_added_sum?: number;
  loc_deleted_sum?: number;
  totals_by_language_model?: LanguageModelTotals[];
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
    // Roster and per-user metrics are independent; fetch them together.
    const [roster, userMetrics] = await Promise.all([
      this.fetchRoster(),
      this.fetchUserMetrics(),
    ]);

    const seats = roster.map((seat) => {
      const metrics = userMetrics.get(seat.login);
      return metrics ? { ...seat, ...metrics } : seat;
    });

    const { orgDaily, modelDaily } = await this.fetchDailyHistory(historyDays);

    return { seats, orgDaily, modelDaily };
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

    for (const row of report.rows) {
      if (!row.user_login) continue;
      map.set(row.user_login, metricsFromUserRow(row));
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
  ): Promise<{ orgDaily: OrgDailySnapshot[]; modelDaily: ModelDailySnapshot[] }> {
    const anchor = await this.newestReportDay();
    const days = Array.from({ length: historyDays }, (_, i) => addDays(anchor, -i));

    const reports = await mapLimit(days, BACKFILL_CONCURRENCY, async (day) => {
      const report = await this.api.fetchReport<OrgReportRow>(
        `organization-1-day?day=${day}`,
      );
      return report?.rows[0] ?? null;
    });

    const orgDaily: OrgDailySnapshot[] = [];
    const modelDaily: ModelDailySnapshot[] = [];

    for (const row of reports) {
      if (!row) continue;
      orgDaily.push(orgSnapshot(row));
      modelDaily.push(...modelSnapshots(row));
    }

    orgDaily.sort((a, b) => a.date.localeCompare(b.date));
    modelDaily.sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model));
    return { orgDaily, modelDaily };
  }

  /** The newest day that has a report — from the 28-day window's end, else yesterday. */
  private async newestReportDay(): Promise<string> {
    const latest = await this.api.fetchReport<OrgReportRow>('organization-28-day/latest');
    if (latest?.envelope.report_end_day) return latest.envelope.report_end_day;
    return addDays(formatDay(new Date()), -1);
  }
}

function orgSnapshot(row: OrgReportRow): OrgDailySnapshot {
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
  };
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
