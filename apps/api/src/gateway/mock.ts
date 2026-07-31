/**
 * Seeded LLM-gateway generator — the stand-in for a live LiteLLM proxy.
 *
 * Same contract as `copilot/mock.ts`: fixed Lehmer seed, so the numbers are
 * identical across restarts, and the window is anchored to today so the trend
 * chart always ends "yesterday".
 *
 * The shape mirrors what a corporate gateway actually looks like — a handful
 * of long-lived virtual keys (one per platform team), each pinned to a team
 * and a tag, fanning out over models hosted on three different backends. Every
 * breakdown is folded from the same atomic (day, key, model, user) rows, so
 * model, provider, api_key, team, tag and user each sum to the same daily
 * total, exactly as the proxy's own aggregates do. A UI that shows model spend
 * ≠ provider spend is then a bug in the UI, not in the data.
 *
 * `mcp_server` is the deliberate exception, as it is on a real proxy: MCP
 * traffic is a subset of the same requests, so it sums to less than the day.
 */

import type { GatewayDimension } from '@dash/shared';
import { moduleLogger } from '../log.js';
import { eachDay } from './litellm.js';
import { addCounters, ZERO_COUNTERS } from './types.js';
import type {
  GatewayBreakdownSnapshot,
  GatewayBudgetSnapshot,
  GatewayClient,
  GatewayCounters,
  GatewayDailySnapshot,
  GatewaySnapshot,
} from './types.js';

const log = moduleLogger('gateway.mock');

/**
 * Models as LiteLLM names them — `<provider>/<deployment>`. Prices are USD per
 * million tokens, in the same ballpark as the public list prices the three
 * backends charge, so the generated spend is plausible rather than arbitrary.
 */
interface MockModel {
  id: string;
  provider: string;
  inputPerMillion: number;
  outputPerMillion: number;
  weight: number;
  /**
   * Multiplier on the baseline failure rate. Deployments are not equally
   * healthy on a real gateway — a model on a thin PTU quota rejects a steady
   * slice of its traffic with 429s while its neighbours never do, and that
   * asymmetry is the whole reason a reliability breakdown exists. Absent means
   * 1, i.e. this deployment behaves like the rest.
   */
  failureBias?: number;
}

const MODELS: readonly MockModel[] = [
  { id: 'azure/gpt-4o', provider: 'azure', inputPerMillion: 2.5, outputPerMillion: 10, weight: 0.24 },
  { id: 'azure/gpt-4o-mini', provider: 'azure', inputPerMillion: 0.15, outputPerMillion: 0.6, weight: 0.2 },
  // Capacity-constrained reasoning deployment: small quota, steady rate limiting.
  { id: 'azure/o4-mini', provider: 'azure', inputPerMillion: 1.1, outputPerMillion: 4.4, weight: 0.08, failureBias: 3.6 },
  { id: 'azure_ai/mistral-large', provider: 'azure_ai', inputPerMillion: 2, outputPerMillion: 6, weight: 0.09 },
  { id: 'azure_ai/phi-4', provider: 'azure_ai', inputPerMillion: 0.125, outputPerMillion: 0.5, weight: 0.06 },
  { id: 'bedrock/anthropic.claude-sonnet-4-v1:0', provider: 'bedrock', inputPerMillion: 3, outputPerMillion: 15, weight: 0.21 },
  { id: 'bedrock/anthropic.claude-haiku-4-v1:0', provider: 'bedrock', inputPerMillion: 0.8, outputPerMillion: 4, weight: 0.08 },
  { id: 'bedrock/amazon.nova-pro-v1:0', provider: 'bedrock', inputPerMillion: 0.8, outputPerMillion: 3.2, weight: 0.04 },
];

/**
 * A governance object's configuration — what the proxy enforces, as opposed to
 * what it recorded. Every field is optional because on a real proxy every one
 * of them is genuinely optional: the biggest workload on a corporate gateway is
 * usually the one nobody dares cap.
 */
interface MockLimits {
  /** Dollars per budget period. Absent means uncapped. */
  maxBudget?: number;
  /** Alert threshold under the cap. */
  softBudget?: number;
  /** LiteLLM duration string; absent means the budget never resets. */
  budgetDuration?: string;
  tpmLimit?: number;
  rpmLimit?: number;
  /** Administratively disabled — every call rejected, budget or no budget. */
  blocked?: boolean;
}

/** One virtual key: a consuming platform, its team, its tag and its users. */
interface MockKey {
  /** LiteLLM reports the hashed token, not the secret. */
  token: string;
  alias: string;
  teamId: string;
  teamAlias: string;
  tag: string;
  users: readonly string[];
  /** Share of gateway traffic. */
  weight: number;
  /** What the proxy will let this key do. */
  limits: MockLimits;
  /** The team's own limits, which are wider than the key's — one team, one key here. */
  teamLimits: MockLimits;
}

const KEYS: readonly MockKey[] = [
  {
    token: '9f2b1c0a4d',
    alias: 'copilot-agents',
    teamId: 'team-platform',
    teamAlias: 'Platform Engineering',
    tag: 'coding-assistant',
    users: [
      'ana.kovacs@corp.example',
      'liam.silva@corp.example',
      'maya.haugen@corp.example',
      'tomas.brandt@corp.example',
      'iris.delacroix@corp.example',
      'omar.haddad@corp.example',
      'greta.lindqvist@corp.example',
      'pavel.dvorak@corp.example',
      'yuki.tanabe@corp.example',
      'dario.esposito@corp.example',
      'freya.nilsen@corp.example',
      'samir.bhatt@corp.example',
      'clara.wagner@corp.example',
      'jonas.ferreira@corp.example',
    ],
    weight: 0.31,
    // The gateway's biggest consumer, deliberately uncapped: it is the one
    // workload nobody will let a budget stop mid-sprint. Rate-limited instead.
    limits: { tpmLimit: 2_000_000, rpmLimit: 12_000 },
    teamLimits: { maxBudget: 4_000, budgetDuration: '1mo' },
  },
  {
    token: '3c77ee81b5',
    alias: 'customer-support-bot',
    teamId: 'team-cx',
    teamAlias: 'Customer Experience',
    tag: 'support',
    users: [
      'noah.okafor@corp.example',
      'ivy.meyer@corp.example',
      'ruben.castillo@corp.example',
      'hana.oyelaran@corp.example',
      'petra.simek@corp.example',
      'louis.bertrand@corp.example',
      'aisha.rahman@corp.example',
      'stefan.kruger@corp.example',
      'mira.antonova@corp.example',
      'diego.rojas@corp.example',
    ],
    weight: 0.22,
    limits: { maxBudget: 1_800, softBudget: 1_440, budgetDuration: '1mo', rpmLimit: 6_000 },
    teamLimits: { maxBudget: 2_200, budgetDuration: '1mo' },
  },
  {
    token: 'd41a90f6c2',
    alias: 'risk-doc-analysis',
    teamId: 'team-risk',
    teamAlias: 'Risk & Compliance',
    tag: 'document-intelligence',
    users: [
      'owen.tanaka@corp.example',
      'zoe.novak@corp.example',
      'eli.fischer@corp.example',
      'anneke.visser@corp.example',
      'rafael.pinto@corp.example',
      'nadia.chowdhury@corp.example',
      'viktor.horvath@corp.example',
      'mei.lin@corp.example',
      'bruno.almeida@corp.example',
    ],
    weight: 0.18,
    limits: { maxBudget: 1_800, softBudget: 1_440, budgetDuration: '1mo' },
    teamLimits: { maxBudget: 2_000, budgetDuration: '1mo' },
  },
  {
    token: '77b0e5aa19',
    alias: 'data-platform-etl',
    teamId: 'team-data',
    teamAlias: 'Data Platform',
    tag: 'batch',
    // A batch platform is machine traffic wearing three people's names: the
    // roster stays small no matter how big the bill gets, which is what makes
    // the per-user table's heaviest rows service accounts rather than humans.
    users: ['ruth.iqbal@corp.example', 'marc.moreau@corp.example', 'etl-service@corp.example'],
    weight: 0.14,
    // Sized for ordinary ETL traffic, so the twice-monthly re-embedding batch
    // walks it through its soft budget and into overrun — the state a budget
    // view exists to catch, and one no spend chart on the page reports.
    limits: { maxBudget: 3_000, softBudget: 2_400, budgetDuration: '1mo' },
    teamLimits: { maxBudget: 3_600, budgetDuration: '1mo' },
  },
  {
    token: 'be1439c7f0',
    alias: 'internal-chat',
    teamId: 'team-it',
    teamAlias: 'Corporate IT',
    tag: 'chat',
    users: [
      'nina.larsen@corp.example',
      'theo.petrov@corp.example',
      'lena.santos@corp.example',
      'harald.bjornson@corp.example',
      'sofia.marchetti@corp.example',
      'kwame.mensah@corp.example',
      'julia.novotna@corp.example',
      'arjun.deshpande@corp.example',
      'elin.vestergaard@corp.example',
      'matteo.rossi@corp.example',
      'chiara.bianchi@corp.example',
      'tobias.hummel@corp.example',
    ],
    weight: 0.1,
    limits: { maxBudget: 1_200, softBudget: 960, budgetDuration: '1mo', rpmLimit: 3_000 },
    teamLimits: { maxBudget: 1_400, budgetDuration: '1mo' },
  },
  {
    token: '05cd8b2e63',
    alias: 'sandbox-experiments',
    teamId: 'team-innovation',
    teamAlias: 'Innovation Lab',
    tag: 'experiment',
    users: [
      'kofi.weber@corp.example',
      'sara.nakamura@corp.example',
      'lucas.mendes@corp.example',
      'annika.roth@corp.example',
      'hugo.laurent@corp.example',
      'priya.venkatesan@corp.example',
    ],
    weight: 0.05,
    // A weekly experiment budget, already spent through and the key blocked.
    // `blocked` is a separate state from an exhausted budget on a real proxy —
    // an admin can disable a key that is nowhere near its cap — so the two are
    // carried separately rather than derived from each other.
    limits: { maxBudget: 30, softBudget: 24, budgetDuration: '7d', blocked: true },
    teamLimits: { maxBudget: 500, budgetDuration: '1mo' },
  },
];

/** MCP servers the agents call through the gateway — a small, flat dimension. */
const MCP_SERVERS = ['github', 'jira', 'confluence', 'snowflake'] as const;

/**
 * Agent adoption: the share of an agent-shaped key's traffic that routes
 * through an MCP server, climbing month over month.
 *
 * A corporate gateway in 2026 is not sitting at a stable agent share — tool-
 * using workloads are the part that grows, and "how fast" is precisely what the
 * agent-traffic card exists to answer. Keyed off the calendar month rather than
 * an index into the window, for the same reason the batch burst and the
 * regional incident are: a re-sync has to reproduce history rather than redraw
 * it, and the same date must read the same in a 30-day pull and a 90-day one.
 *
 * Interpolated within the month so a 30-day range still shows movement, and
 * clamped at both ends so a range far from the epoch stays plausible rather
 * than passing 100% or going negative.
 */
const MCP_SHARE_EPOCH_YEAR = 2026;
const MCP_SHARE_BASE = 0.1;
const MCP_SHARE_PER_MONTH = 0.03;

/**
 * How much heavier an MCP-routed call is than the same key's ordinary calls.
 *
 * A tool-using turn ships the server's tool schemas, the tool results and the
 * conversation so far, so it carries well over a plain turn's context — which
 * is exactly the asymmetry the agent-traffic card exists to price. The share of
 * *calls* and the share of *tokens* therefore differ by design here, and the
 * key's non-MCP calls are correspondingly lighter than its average.
 */
const MCP_WEIGHT = 1.55;

function mcpShare(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const months = (year - MCP_SHARE_EPOCH_YEAR) * 12 + (month - 1) + (day - 1) / 31;
  return Math.min(0.55, Math.max(0.05, MCP_SHARE_BASE + MCP_SHARE_PER_MONTH * months));
}

/**
 * How unevenly a key's traffic is spread across its people, flattening month
 * over month.
 *
 * `index = ⌊n · u^p⌋` over a uniform draw `u` gives index `k` a probability of
 * `((k+1)/n)^(1/p) − (k/n)^(1/p)`, so `p` is the skew dial: at `p = 2.4` the
 * first name on a 12-person roster takes ~35% of that key's rows and the last
 * takes under 1%; at `p = 1` every name is equally likely.
 *
 * The dial is what carries adoption here, rather than a growing roster. A
 * corporate gateway does not onboard people so much as *broaden*: the first
 * months are a handful of enthusiasts running agents all day, and as the
 * endpoint becomes the default the same population starts calling it. Both the
 * daily active count and the concentration read move on that broadening, where
 * a roster that merely grew would leave the tail unreached — the number of rows
 * a key emits per day is bounded by the models it routes to, not by how many
 * people it has.
 *
 * Keyed off the calendar month for the same reason the MCP ramp and the batch
 * burst are: a re-sync must reproduce history rather than redraw it, so the
 * same date must read the same in a 30-day pull and a 90-day one. Clamped at
 * both ends, so a range far from the epoch stays a plausible gateway rather
 * than an inverted one.
 */
const SKEW_EPOCH_YEAR = 2026;
const SKEW_AT_EPOCH = 2.6;
const SKEW_PER_MONTH = 0.115;
const SKEW_FLOOR = 1.35;

/**
 * How much of a key's roster has been onboarded, climbing month over month.
 *
 * The skew dial above decides how unevenly the *onboarded* population is
 * loaded; this one decides how many of them there are. Both are needed and
 * neither substitutes for the other: broadening alone never produces a user who
 * was not there last month, and a growing roster alone leaves the newcomers
 * invisible because the head of the distribution keeps taking the rows.
 *
 * Clamped at 1, which the ramp reaches in late 2026 — past that the mock's
 * population stops growing and `new users` reads zero. That is a horizon of the
 * generator, not of the derivation, and extending it means lengthening the
 * rosters rather than changing the card.
 */
const ROSTER_AT_EPOCH = 0.35;
const ROSTER_PER_MONTH = 0.07;

function rosterShare(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const months = (year - SKEW_EPOCH_YEAR) * 12 + (month - 1) + (day - 1) / 31;
  return Math.min(1, Math.max(0.2, ROSTER_AT_EPOCH + ROSTER_PER_MONTH * months));
}

function userSkew(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const months = (year - SKEW_EPOCH_YEAR) * 12 + (month - 1) + (day - 1) / 31;
  return Math.min(SKEW_AT_EPOCH, Math.max(SKEW_FLOOR, SKEW_AT_EPOCH - SKEW_PER_MONTH * months));
}

/**
 * Which of a key's users carries a row.
 *
 * One draw, deliberately: the Lehmer stream is consumed sequentially, so
 * spending a second random number here would shift every value after it and
 * silently redraw the burst, the incident and the MCP ramp.
 */
function pickUser(key: MockKey, date: string, draw: number): string {
  // Service accounts neither broaden nor grow — a batch platform runs under the
  // same two or three identities no matter how big its bill gets, which is what
  // makes the heaviest rows of the per-user table the ones with the fewest
  // people behind them.
  const service = key.tag === BURST_TAG;
  const size = service
    ? key.users.length
    : Math.max(1, Math.round(key.users.length * rosterShare(date)));
  const skew = service ? 1 : userSkew(date);
  const index = Math.min(size - 1, Math.floor(size * draw ** skew));
  return key.users[index] ?? key.users[0]!;
}

/** Requests per day at the start of the window, before growth and weekday shape. */
const BASE_REQUESTS_PER_DAY = 42_000;

/** Compound daily growth — ~35% over a 90-day window. */
const DAILY_GROWTH = 1.0034;

/** Weekend traffic collapses to batch jobs; weekdays peak midweek. */
const WEEKDAY_SHAPE = [0.18, 0.98, 1.06, 1.08, 1.04, 0.92, 0.16];

/** Share of requests that fail (rate limits, content filters, backend 5xx). */
const FAILURE_RATE = 0.021;

/**
 * A backend incident: one provider's region degrades for two days a month.
 *
 * Keyed off the calendar day of the month for the same reason the spend burst
 * is — a re-sync has to reproduce history rather than redraw it. Failures cost
 * almost nothing (a rejected call bills no tokens), so this is deliberately
 * invisible on every spend surface on the page and only shows up where
 * reliability is being read, which is exactly the gap the `Reliability` card
 * exists to close.
 */
const INCIDENT_DAYS_OF_MONTH = new Set([17, 18]);
const INCIDENT_PROVIDER = 'bedrock';
const INCIDENT_FAILURE_RATE = 0.16;

/**
 * The twice-monthly re-embedding batch on the data-platform key.
 *
 * A corporate gateway is not a smooth curve: a scheduled job that reprocesses a
 * document corpus can multiply a day's spend on its own, which is exactly the
 * event the `Unusual spend` card exists to surface. Keyed off the calendar day
 * of the month rather than an index into the window, so the same date always
 * bursts no matter which range is pulled — a re-sync must reproduce history,
 * not redraw it.
 */
const BURST_DAYS_OF_MONTH = new Set([9, 23]);
const BURST_TAG = 'batch';
const BURST_MULTIPLIER = 6;

/**
 * How far back a never-resetting spend counter is summed. The proxy's own
 * counter runs since the key was created; 90 days is the widest window this
 * generator produces, and the number it yields is the same order of magnitude.
 */
const LIFETIME_WINDOW_DAYS = 90;

/** Fixed Lehmer seed — identical output across restarts. */
const SEED = 1_337_991;

function lehmer(seed: number): () => number {
  let state = seed % 2_147_483_647;
  if (state <= 0) state += 2_147_483_646;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
}

/** USD → nano-dollars, rounded to the nearest nano. */
function dollarsToNano(dollars: number): bigint {
  return BigInt(Math.round(dollars * 1e9));
}

/** Accumulator key — one row per (date, dimension, key). */
function bucketKey(date: string, dimension: GatewayDimension, key: string): string {
  return `${date} ${dimension} ${key}`;
}

export class MockGatewayClient implements GatewayClient {
  readonly name = 'mock' as const;

  async fetchUsage(from: string, to: string): Promise<GatewaySnapshot> {
    const random = lehmer(SEED);
    const dates = eachDay(from, to);

    const daily = new Map<string, GatewayDailySnapshot>();
    const breakdowns = new Map<string, GatewayBreakdownSnapshot>();
    const labels = new Map<string, string>();

    const add = (
      date: string,
      dimension: GatewayDimension,
      key: string,
      label: string | null,
      counters: GatewayCounters,
    ): void => {
      const mapKey = bucketKey(date, dimension, key);
      const existing = breakdowns.get(mapKey);
      if (existing) {
        addCounters(existing, counters);
        return;
      }
      if (label !== null) labels.set(`${dimension} ${key}`, label);
      breakdowns.set(mapKey, {
        date,
        dimension,
        key,
        label: labels.get(`${dimension} ${key}`) ?? null,
        ...counters,
      });
    };

    dates.forEach((date, dayIndex) => {
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      const shape = WEEKDAY_SHAPE[weekday] ?? 1;
      const jitter = 0.88 + random() * 0.24;
      const dayRequests = Math.round(
        BASE_REQUESTS_PER_DAY * DAILY_GROWTH ** dayIndex * shape * jitter,
      );

      const dayTotals: GatewayDailySnapshot = { date, ...ZERO_COUNTERS };
      const dayOfMonth = Number(date.slice(8, 10));
      const bursting = BURST_DAYS_OF_MONTH.has(dayOfMonth);
      const incident = INCIDENT_DAYS_OF_MONTH.has(dayOfMonth);

      for (const key of KEYS) {
        // The burst multiplies one key's traffic, not the whole gateway's, so
        // the day is attributable to a culprit the way a real one is.
        const burst = bursting && key.tag === BURST_TAG ? BURST_MULTIPLIER : 1;
        const keyRequests = Math.round(dayRequests * key.weight * burst * (0.85 + random() * 0.3));
        if (keyRequests === 0) continue;

        for (const model of MODELS) {
          // The sandbox key jumps between models day to day, which is what
          // makes a per-model drill-down worth having. The production keys do
          // not: at ~40k requests a day every routed model sees traffic every
          // day, and dropping one wholesale would swing the daily total by more
          // than a runaway batch job does — which would make the whole
          // unusual-spend card indistinguishable from generator noise.
          const jumps = random() > model.weight * 3.2;
          if (jumps && key.tag === 'experiment') continue;

          const modelRequests = Math.max(1, Math.round(keyRequests * model.weight));
          // An incident overrides the deployment's own bias: while a region is
          // degraded, everything routed to it fails at the region's rate.
          const degraded = incident && model.provider === INCIDENT_PROVIDER;
          const failureRate = degraded
            ? INCIDENT_FAILURE_RATE
            : FAILURE_RATE * (model.failureBias ?? 1);
          // A degraded region fails consistently; ordinary noise swings wide.
          const failureJitter = degraded ? 0.85 + random() * 0.3 : 0.4 + random() * 1.6;
          const failed = Math.round(modelRequests * failureRate * failureJitter);
          const successful = Math.max(0, modelRequests - failed);

          // Batch and document workloads carry far longer prompts than chat.
          const promptPerRequest = key.tag === 'chat' ? 900 : key.tag === 'batch' ? 6_200 : 2_400;
          const promptTokens = Math.round(successful * promptPerRequest * (0.7 + random() * 0.6));
          const completionTokens = Math.round(promptTokens * (0.12 + random() * 0.18));
          // Long-lived system prompts get cached; short chat turns rarely do.
          const cacheReadTokens = Math.round(promptTokens * (key.tag === 'chat' ? 0.05 : 0.34));
          const cacheCreationTokens = Math.round(cacheReadTokens * 0.09);

          const billedPromptTokens = Math.max(0, promptTokens - cacheReadTokens);
          const spend =
            (billedPromptTokens * model.inputPerMillion) / 1e6 +
            // Cache reads bill at roughly a tenth of the input rate; cache
            // writes at a premium over it.
            (cacheReadTokens * model.inputPerMillion * 0.1) / 1e6 +
            (cacheCreationTokens * model.inputPerMillion * 1.25) / 1e6 +
            (completionTokens * model.outputPerMillion) / 1e6;

          const counters: GatewayCounters = {
            spendNano: dollarsToNano(spend),
            requests: modelRequests,
            successfulRequests: successful,
            failedRequests: failed,
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            cacheReadTokens,
            cacheCreationTokens,
          };

          addCounters(dayTotals, counters);
          add(date, 'model', model.id, null, counters);
          add(date, 'provider', model.provider, null, counters);
          add(date, 'api_key', key.token, key.alias, counters);
          add(date, 'team', key.teamId, key.teamAlias, counters);
          add(date, 'tag', key.tag, null, counters);

          // One user of the key carries the row — over a window every user
          // shows up, which is what the per-user table needs. The pick is skewed
          // towards the head of the roster and the skew flattens month over
          // month, so the adoption card reads a population that is both unevenly
          // loaded and broadening, which is what a real one is.
          add(date, 'user', pickUser(key, date, random()), null, counters);

          // MCP traffic is a subset of the same requests, attributed to the
          // server the agent called. Only agent-shaped workloads have any.
          //
          // Calls scale by the MCP share; tokens and the dollars they drive
          // scale by that share *times* the weight, because a tool turn is a
          // bigger turn. Both scalings must be applied to every counter of
          // their kind: a row whose spend was scaled while its tokens were not
          // would report agent calls at a tokens-per-call figure that is a pure
          // artefact, and comparing that unit economics against the rest of the
          // gateway is the whole point of the agent-traffic card.
          if (key.tag === 'coding-assistant' || key.tag === 'support') {
            const server = MCP_SERVERS[Math.floor(random() * MCP_SERVERS.length)] ?? MCP_SERVERS[0];
            const share = mcpShare(date);
            const weighted = Math.min(0.9, share * MCP_WEIGHT);
            const calls = (value: number): number => Math.round(value * share);
            const tokens = (value: number): number => Math.round(value * weighted);
            add(date, 'mcp_server', server, null, {
              spendNano: BigInt(Math.round(Number(counters.spendNano) * weighted)),
              requests: calls(counters.requests),
              successfulRequests: calls(counters.successfulRequests),
              failedRequests: calls(counters.failedRequests),
              promptTokens: tokens(counters.promptTokens),
              completionTokens: tokens(counters.completionTokens),
              totalTokens: tokens(counters.totalTokens),
              cacheReadTokens: tokens(counters.cacheReadTokens),
              cacheCreationTokens: tokens(counters.cacheCreationTokens),
            });
          }
        }
      }

      daily.set(date, dayTotals);
    });

    const snapshot: GatewaySnapshot = {
      daily: [...daily.values()],
      breakdowns: [...breakdowns.values()],
      dates,
    };

    log.info(
      {
        dash: { from, to, days: snapshot.daily.length, breakdownRows: snapshot.breakdowns.length },
      },
      'mock gateway usage generated',
    );

    return snapshot;
  }

  /**
   * Budgets and limits as the proxy would report them right now.
   *
   * The period spend is not invented: it is this generator's own usage summed
   * over the period in flight, so a key sitting at 94% of its cap is at 94% of
   * the spend the trend chart draws. It will not match the same key's total in
   * a 90-day pull to the cent — the Lehmer stream is consumed from the start of
   * whatever window was asked for — and that mismatch is itself faithful: on a
   * real proxy the enforced counter and the daily aggregates are two different
   * systems of record, which is exactly why this field is carried rather than
   * re-derived.
   */
  async fetchBudgets(): Promise<GatewayBudgetSnapshot[]> {
    const now = new Date();
    const yesterday = shiftUtcDays(now, -1);
    const periodStarts = new Map<string, Date>([
      ['1mo', startOfUtcMonth(now)],
      ['7d', startOfUtcWeek(now)],
    ]);

    // One pull wide enough for the longest counter, sliced per budget below.
    // A key with no `budget_duration` still carries a spend counter on a real
    // proxy — it simply never resets — so it is summed over the whole window
    // rather than reported as zero, which would make the gateway's largest
    // consumer look idle purely because nobody capped it.
    const from = isoDay(shiftUtcDays(now, -LIFETIME_WINDOW_DAYS));
    const to = isoDay(yesterday);
    const usage = from <= to ? await this.fetchUsage(from, to) : null;

    const spendSince = (
      dimension: GatewayDimension,
      key: string,
      since: Date | null,
    ): bigint => {
      if (usage === null) return 0n;
      const start = since === null ? from : isoDay(since);
      let total = 0n;
      for (const row of usage.breakdowns) {
        if (row.dimension === dimension && row.key === key && row.date >= start) {
          total += row.spendNano;
        }
      }
      return total;
    };

    const budgets: GatewayBudgetSnapshot[] = [];

    const push = (
      scope: 'api_key' | 'team',
      key: string,
      label: string,
      limits: MockLimits,
      dimension: GatewayDimension,
    ): void => {
      const duration = limits.budgetDuration ?? null;
      const periodStart = duration === null ? null : (periodStarts.get(duration) ?? null);
      budgets.push({
        scope,
        key,
        label,
        spendNano: spendSince(dimension, key, periodStart),
        maxBudgetNano: limits.maxBudget === undefined ? null : dollarsToNano(limits.maxBudget),
        softBudgetNano: limits.softBudget === undefined ? null : dollarsToNano(limits.softBudget),
        budgetDuration: duration,
        resetAt: duration === null ? null : nextReset(duration, now),
        tpmLimit: limits.tpmLimit ?? null,
        rpmLimit: limits.rpmLimit ?? null,
        blocked: limits.blocked === true,
      });
    };

    for (const key of KEYS) {
      push('api_key', key.token, key.alias, key.limits, 'api_key');
      push('team', key.teamId, key.teamAlias, key.teamLimits, 'team');
    }

    log.info({ dash: { budgets: budgets.length } }, 'mock gateway budgets generated');
    return budgets;
  }
}

/** UTC midnight on the first of `date`'s month. */
function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** UTC midnight on the most recent Monday, `date` included. */
function startOfUtcWeek(date: Date): Date {
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // getUTCDay() is Sunday-first; a Sunday belongs to the week that began six
  // days earlier, not to the one starting tomorrow.
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start;
}

function shiftUtcDays(date: Date, days: number): Date {
  const shifted = new Date(date.getTime());
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** When a period that began at the current one's start next rolls over. */
function nextReset(duration: string, now: Date): Date {
  if (duration === '7d') return shiftUtcDays(startOfUtcWeek(now), 7);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
