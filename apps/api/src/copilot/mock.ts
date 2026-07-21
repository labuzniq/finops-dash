import type { Editor } from '@dash/shared';
import { moduleLogger } from '../log.js';
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
 * Seeded generator for local development — a stand-in for the live GitHub
 * reports client. Fixed seed, so the roster is identical across restarts;
 * activity dates are anchored to today so "days ago" stays fresh.
 */

const FIRST_NAMES = [
  'Ana', 'Liam', 'Maya', 'Noah', 'Ivy', 'Owen', 'Zoe', 'Eli', 'Ruth', 'Marc', 'Nina', 'Theo',
  'Lena', 'Kofi', 'Sara', 'Yuki', 'Omar', 'Priya', 'Jan', 'Rosa', 'Dmitri', 'Wei', 'Aoife', 'Tariq',
];

const LAST_NAMES = [
  'Kovacs', 'Silva', 'Haugen', 'Okafor', 'Meyer', 'Tanaka', 'Novak', 'Fischer', 'Iqbal', 'Moreau',
  'Larsen', 'Petrov', 'Santos', 'Weber', 'Nakamura', 'Kaur', 'Olsen', 'Duarte', 'Farrell',
  'Bianchi', 'Sorensen', 'Kim', 'Nguyen', 'Haas',
];

const EDITOR_WEIGHTS: ReadonlyArray<readonly [Editor, number]> = [
  ['VS Code', 0.55],
  ['JetBrains', 0.26],
  ['Visual Studio', 0.08],
  ['Neovim', 0.06],
  ['Xcode', 0.05],
];

/** Free-form languages, mirroring what the GitHub reports emit (lowercase). */
const LANGUAGE_WEIGHTS: ReadonlyArray<readonly [string, number]> = [
  ['typescript', 0.28],
  ['python', 0.22],
  ['java', 0.14],
  ['go', 0.11],
  ['csharp', 0.09],
  ['ruby', 0.06],
  ['kotlin', 0.05],
  ['rust', 0.05],
];

/** Real GitHub Copilot model ids, weighted like a live org's mix. */
const MODEL_WEIGHTS: ReadonlyArray<readonly [string, number]> = [
  ['claude-sonnet-5', 0.42],
  ['claude-opus-4.6', 0.24],
  ['gpt-5.3-codex', 0.16],
  ['gpt-5.6-sol', 0.1],
  ['claude-4.5-haiku', 0.08],
];

/** Assigning teams, weighted like a mid-size org. */
const TEAM_WEIGHTS: ReadonlyArray<readonly [string, number]> = [
  ['Platform', 0.24],
  ['Payments', 0.2],
  ['Web', 0.18],
  ['Mobile', 0.14],
  ['Data', 0.13],
  ['Infra', 0.11],
];

/**
 * Report breakdown keys, lowercase as GitHub emits them. IDE and feature keys
 * mirror the live report vocabulary; languages and models reuse the seat
 * weights above so seat-level and org-level views tell one story.
 */
const IDE_KEYS: ReadonlyArray<readonly [string, number]> = [
  ['vscode', 0.55],
  ['jetbrains', 0.26],
  ['visual_studio', 0.08],
  ['neovim', 0.06],
  ['xcode', 0.05],
];

const FEATURE_KEYS: ReadonlyArray<readonly [string, number]> = [
  ['code_completion', 0.4],
  ['chat_panel_agent_mode', 0.25],
  ['chat_panel_ask_mode', 0.12],
  ['agent_edit', 0.1],
  ['copilot_cli', 0.08],
  ['chat_inline', 0.05],
];

type Archetype = 'active' | 'light' | 'dormant' | 'never';

const SEAT_COUNT = 1_000;
const SERIES_DAYS = 90;
const SEED = 987_654_321;

function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = Math.imul(48_271, state) % 2_147_483_647;
    return (state & 2_147_483_647) / 2_147_483_648;
  };
}

function weightedPick<T>(random: () => number, weights: ReadonlyArray<readonly [T, number]>): T {
  const roll = random();
  let cumulative = 0;
  for (const [value, weight] of weights) {
    cumulative += weight;
    if (roll <= cumulative) return value;
  }
  return weights[weights.length - 1]![0];
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function archetypeFor(random: () => number): Archetype {
  const roll = random();
  if (roll < 0.6) return 'active';
  if (roll < 0.78) return 'light';
  if (roll < 0.92) return 'dormant';
  return 'never';
}

function lastActivityDaysFor(random: () => number, archetype: Archetype): number | null {
  switch (archetype) {
    case 'active':
      return Math.floor(random() * 7);
    case 'light':
      return 3 + Math.floor(random() * 23);
    case 'dormant':
      return 30 + Math.floor(random() * 58);
    case 'never':
      return null;
  }
}

function premiumRequestsFor(random: () => number, archetype: Archetype): number {
  switch (archetype) {
    case 'active':
      return Math.round(120 + random() * 780);
    case 'light':
      return Math.round(10 + random() * 140);
    default:
      return 0;
  }
}

function daysAgo(from: Date, days: number): Date {
  const date = new Date(from);
  date.setDate(date.getDate() - days);
  return date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildSeats(random: () => number, today: Date): SeatSnapshot[] {
  const seats: SeatSnapshot[] = [];
  const takenLogins = new Set<string>();

  for (let i = 0; i < SEAT_COUNT; i++) {
    const first = pick(random, FIRST_NAMES);
    const last = pick(random, LAST_NAMES);

    let login = `${first[0]}${last}`.toLowerCase();
    if (takenLogins.has(login)) login = `${login}${i}`;
    takenLogins.add(login);

    const archetype = archetypeFor(random);
    const lastActivityDays = lastActivityDaysFor(random, archetype);
    const active = archetype !== 'never';

    seats.push({
      login,
      name: `${first} ${last}`,
      plan: random() < 0.2 ? 'Enterprise' : 'Business',
      editor: active ? weightedPick(random, EDITOR_WEIGHTS) : null,
      language: active ? weightedPick(random, LANGUAGE_WEIGHTS) : null,
      lastActivityAt: lastActivityDays === null ? null : daysAgo(today, lastActivityDays),
      premiumRequests28d: premiumRequestsFor(random, archetype),
      acceptanceRate: active ? Math.round(16 + random() * 30) : null,
      usedAgent: active ? random() < 0.5 : null,
      usedChat: active ? random() < 0.7 : null,
      topModel: active ? weightedPick(random, MODEL_WEIGHTS) : null,
      // A slice of seats is assigned directly rather than through a team.
      team: random() < 0.12 ? null : weightedPick(random, TEAM_WEIGHTS),
    });
  }

  return seats;
}

/** A 90-day org-aggregate curve — active users ramping over the quarter. */
function buildOrgDaily(random: () => number, today: Date): OrgDailySnapshot[] {
  const series: OrgDailySnapshot[] = [];

  for (let offset = SERIES_DAYS - 1; offset >= 0; offset--) {
    const date = daysAgo(today, offset);
    const weekday = date.getDay();
    const weekend = weekday === 0 || weekday === 6 ? 0.35 : 1;
    const ramp = 0.75 + (SERIES_DAYS - offset) / SERIES_DAYS / 2;
    const dau = Math.round((260 + random() * 90) * weekend * ramp);
    const mau = Math.round(dau * 1.7);
    const generations = Math.round(dau * (2 + random()));
    const locAdded = Math.round(generations * (3 + random() * 4));
    const locDeleted = Math.round(generations * (0.4 + random() * 0.6));
    const prCreated = Math.round(dau * (0.05 + random() * 0.05));
    const prCreatedByCopilot = Math.round(prCreated * (0.15 + random() * 0.15));
    const prMerged = Math.round(prCreated * (0.6 + random() * 0.25));
    const prReviewedByCopilot = Math.round(prCreated * (0.3 + random() * 0.3));
    const prSuggestions = Math.round(prReviewedByCopilot * (2 + random() * 3));

    series.push({
      date: isoDate(date),
      dailyActiveUsers: dau,
      weeklyActiveUsers: Math.round(dau * 1.3),
      monthlyActiveUsers: mau,
      interactions: Math.round(dau * (0.3 + random() * 0.4)),
      generations,
      acceptances: Math.round(generations * (0.25 + random() * 0.2)),
      locAdded,
      locDeleted,
      locSuggestedAdd: Math.round(locAdded * (1.2 + random() * 0.4)),
      locSuggestedDelete: Math.round(locDeleted * (1.2 + random() * 0.4)),
      chatMau: Math.round(mau * (0.6 + random() * 0.15)),
      agentMau: Math.round(mau * (0.35 + random() * 0.15)),
      codeReviewDau: Math.round(dau * (0.06 + random() * 0.04)),
      codeReviewWau: Math.round(dau * (0.12 + random() * 0.06)),
      codeReviewMau: Math.round(mau * (0.1 + random() * 0.05)),
      codeReviewPassiveMau: Math.round(mau * (0.15 + random() * 0.08)),
      cloudAgentDau: Math.round(dau * (0.02 + random() * 0.02)),
      cloudAgentWau: Math.round(dau * (0.05 + random() * 0.03)),
      cloudAgentMau: Math.round(mau * (0.04 + random() * 0.03)),
      prCreated,
      prMerged,
      prCreatedByCopilot,
      prMergedCreatedByCopilot: Math.round(prCreatedByCopilot * (0.5 + random() * 0.3)),
      prReviewedByCopilot,
      prCopilotSuggestions: prSuggestions,
      prCopilotAppliedSuggestions: Math.round(prSuggestions * (0.3 + random() * 0.3)),
    });
  }

  return series;
}

/** Per-day per-model activity, distributing each day's generations by weight. */
function buildModelDaily(org: readonly OrgDailySnapshot[], random: () => number): ModelDailySnapshot[] {
  const rows: ModelDailySnapshot[] = [];

  for (const day of org) {
    for (const [model, weight] of MODEL_WEIGHTS) {
      const jitter = 0.85 + random() * 0.3;
      const generations = Math.round(day.generations * weight * jitter);
      if (generations === 0) continue;
      rows.push({
        date: day.date,
        model,
        generations,
        acceptances: Math.round(generations * (0.25 + random() * 0.2)),
        locAdded: Math.round(generations * (3 + random() * 4)),
        locDeleted: Math.round(generations * (0.4 + random() * 0.6)),
      });
    }
  }

  return rows;
}

/**
 * Distribute each day's org totals across a dimension's keys by weight, with
 * per-cell jitter — the same treatment `buildModelDaily` gives models.
 */
function buildBreakdownDaily(
  org: readonly OrgDailySnapshot[],
  random: () => number,
): BreakdownDailySnapshot[] {
  const dimensions: ReadonlyArray<
    readonly [BreakdownDailySnapshot['dimension'], ReadonlyArray<readonly [string, number]>]
  > = [
    ['ide', IDE_KEYS],
    ['language', LANGUAGE_WEIGHTS],
    ['feature', FEATURE_KEYS],
    ['model', MODEL_WEIGHTS],
  ];

  const rows: BreakdownDailySnapshot[] = [];
  for (const day of org) {
    for (const [dimension, weights] of dimensions) {
      for (const [key, weight] of weights) {
        const jitter = 0.85 + random() * 0.3;
        const share = weight * jitter;
        const generations = Math.round(day.generations * share);
        if (generations === 0) continue;
        rows.push({
          date: day.date,
          dimension,
          key,
          interactions: Math.round(day.interactions * share),
          generations,
          acceptances: Math.round(generations * (0.25 + random() * 0.2)),
          locAdded: Math.round(day.locAdded * share),
          locDeleted: Math.round(day.locDeleted * share),
          locSuggestedAdd: Math.round(day.locSuggestedAdd * share),
          locSuggestedDelete: Math.round(day.locSuggestedDelete * share),
        });
      }
    }
  }
  return rows;
}

/** Three adoption phases splitting each day's engaged users, later phases smaller. */
function buildAdoptionDaily(
  org: readonly OrgDailySnapshot[],
  random: () => number,
): AdoptionPhaseDailySnapshot[] {
  const PHASE_SHARES = [0.5, 0.3, 0.2] as const;
  const rows: AdoptionPhaseDailySnapshot[] = [];

  for (const day of org) {
    PHASE_SHARES.forEach((share, index) => {
      const engagedUsers = Math.round(day.dailyActiveUsers * share * (0.9 + random() * 0.2));
      const depth = index + 1; // Later phases use Copilot more heavily per user.
      rows.push({
        date: day.date,
        phaseNumber: depth,
        phase: `Phase ${depth}`,
        engagedUsers,
        avgInteractions: Math.round((4 + random() * 6) * depth * 10) / 10,
        avgGenerations: Math.round((8 + random() * 10) * depth * 10) / 10,
        avgAcceptances: Math.round((2 + random() * 4) * depth * 10) / 10,
        avgLocAdded: Math.round((20 + random() * 40) * depth * 10) / 10,
        avgLocDeleted: Math.round((4 + random() * 8) * depth * 10) / 10,
        avgPrCreated: Math.round(random() * depth * 10) / 10,
        avgPrReviewed: Math.round(random() * depth * 10) / 10,
      });
    });
  }
  return rows;
}

export class MockCopilotClient implements CopilotClient {
  readonly name = 'mock';

  async fetchSnapshot(historyDays: number): Promise<CopilotSnapshot> {
    const random = createRandom(SEED);
    const today = new Date();
    const seats = buildSeats(random, today);
    const orgDaily = buildOrgDaily(random, today).slice(Math.max(0, SERIES_DAYS - historyDays));
    const modelDaily = buildModelDaily(orgDaily, random);
    const breakdownDaily = buildBreakdownDaily(orgDaily, random);
    const adoptionDaily = buildAdoptionDaily(orgDaily, random);
    moduleLogger('copilot.mock').debug(
      { dash: { seats: seats.length, orgDays: orgDaily.length, historyDays } },
      'generated mock snapshot',
    );
    // The mock roster is self-contained: every user with usage holds a seat.
    return { seats, offRosterPremiumRequests: [], orgDaily, modelDaily, breakdownDaily, adoptionDaily };
  }
}
