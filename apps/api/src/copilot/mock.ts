import type { Editor } from '@dash/shared';
import type {
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
    const generations = Math.round(dau * (2 + random()));

    series.push({
      date: isoDate(date),
      dailyActiveUsers: dau,
      weeklyActiveUsers: Math.round(dau * 1.3),
      monthlyActiveUsers: Math.round(dau * 1.7),
      interactions: Math.round(dau * (0.3 + random() * 0.4)),
      generations,
      acceptances: Math.round(generations * (0.25 + random() * 0.2)),
      locAdded: Math.round(generations * (3 + random() * 4)),
      locDeleted: Math.round(generations * (0.4 + random() * 0.6)),
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

export class MockCopilotClient implements CopilotClient {
  readonly name = 'mock';

  async fetchSnapshot(historyDays: number): Promise<CopilotSnapshot> {
    const random = createRandom(SEED);
    const today = new Date();
    const seats = buildSeats(random, today);
    const orgDaily = buildOrgDaily(random, today).slice(Math.max(0, SERIES_DAYS - historyDays));
    const modelDaily = buildModelDaily(orgDaily, random);
    return { seats, orgDaily, modelDaily };
  }
}
