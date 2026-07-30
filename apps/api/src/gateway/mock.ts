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
}

const MODELS: readonly MockModel[] = [
  { id: 'azure/gpt-4o', provider: 'azure', inputPerMillion: 2.5, outputPerMillion: 10, weight: 0.24 },
  { id: 'azure/gpt-4o-mini', provider: 'azure', inputPerMillion: 0.15, outputPerMillion: 0.6, weight: 0.2 },
  { id: 'azure/o4-mini', provider: 'azure', inputPerMillion: 1.1, outputPerMillion: 4.4, weight: 0.08 },
  { id: 'azure_ai/mistral-large', provider: 'azure_ai', inputPerMillion: 2, outputPerMillion: 6, weight: 0.09 },
  { id: 'azure_ai/phi-4', provider: 'azure_ai', inputPerMillion: 0.125, outputPerMillion: 0.5, weight: 0.06 },
  { id: 'bedrock/anthropic.claude-sonnet-4-v1:0', provider: 'bedrock', inputPerMillion: 3, outputPerMillion: 15, weight: 0.21 },
  { id: 'bedrock/anthropic.claude-haiku-4-v1:0', provider: 'bedrock', inputPerMillion: 0.8, outputPerMillion: 4, weight: 0.08 },
  { id: 'bedrock/amazon.nova-pro-v1:0', provider: 'bedrock', inputPerMillion: 0.8, outputPerMillion: 3.2, weight: 0.04 },
];

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
}

const KEYS: readonly MockKey[] = [
  {
    token: '9f2b1c0a4d',
    alias: 'copilot-agents',
    teamId: 'team-platform',
    teamAlias: 'Platform Engineering',
    tag: 'coding-assistant',
    users: ['ana.kovacs@corp.example', 'liam.silva@corp.example', 'maya.haugen@corp.example'],
    weight: 0.31,
  },
  {
    token: '3c77ee81b5',
    alias: 'customer-support-bot',
    teamId: 'team-cx',
    teamAlias: 'Customer Experience',
    tag: 'support',
    users: ['noah.okafor@corp.example', 'ivy.meyer@corp.example'],
    weight: 0.22,
  },
  {
    token: 'd41a90f6c2',
    alias: 'risk-doc-analysis',
    teamId: 'team-risk',
    teamAlias: 'Risk & Compliance',
    tag: 'document-intelligence',
    users: ['owen.tanaka@corp.example', 'zoe.novak@corp.example', 'eli.fischer@corp.example'],
    weight: 0.18,
  },
  {
    token: '77b0e5aa19',
    alias: 'data-platform-etl',
    teamId: 'team-data',
    teamAlias: 'Data Platform',
    tag: 'batch',
    users: ['ruth.iqbal@corp.example', 'marc.moreau@corp.example'],
    weight: 0.14,
  },
  {
    token: 'be1439c7f0',
    alias: 'internal-chat',
    teamId: 'team-it',
    teamAlias: 'Corporate IT',
    tag: 'chat',
    users: ['nina.larsen@corp.example', 'theo.petrov@corp.example', 'lena.santos@corp.example'],
    weight: 0.1,
  },
  {
    token: '05cd8b2e63',
    alias: 'sandbox-experiments',
    teamId: 'team-innovation',
    teamAlias: 'Innovation Lab',
    tag: 'experiment',
    users: ['kofi.weber@corp.example', 'sara.nakamura@corp.example'],
    weight: 0.05,
  },
];

/** MCP servers the agents call through the gateway — a small, flat dimension. */
const MCP_SERVERS = ['github', 'jira', 'confluence', 'snowflake'] as const;

/** Requests per day at the start of the window, before growth and weekday shape. */
const BASE_REQUESTS_PER_DAY = 42_000;

/** Compound daily growth — ~35% over a 90-day window. */
const DAILY_GROWTH = 1.0034;

/** Weekend traffic collapses to batch jobs; weekdays peak midweek. */
const WEEKDAY_SHAPE = [0.18, 0.98, 1.06, 1.08, 1.04, 0.92, 0.16];

/** Share of requests that fail (rate limits, content filters, backend 5xx). */
const FAILURE_RATE = 0.021;

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
      const bursting = BURST_DAYS_OF_MONTH.has(Number(date.slice(8, 10)));

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
          const failed = Math.round(modelRequests * FAILURE_RATE * (0.4 + random() * 1.6));
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
          // shows up, which is what the per-user table needs.
          const user = key.users[Math.floor(random() * key.users.length)] ?? key.users[0]!;
          add(date, 'user', user, null, counters);

          // MCP traffic is a subset of the same requests, attributed to the
          // server the agent called. Only agent-shaped workloads have any.
          if (key.tag === 'coding-assistant' || key.tag === 'support') {
            const server = MCP_SERVERS[Math.floor(random() * MCP_SERVERS.length)] ?? MCP_SERVERS[0];
            add(date, 'mcp_server', server, null, {
              ...counters,
              spendNano: counters.spendNano / 4n,
              requests: Math.round(counters.requests / 4),
              successfulRequests: Math.round(counters.successfulRequests / 4),
              failedRequests: Math.round(counters.failedRequests / 4),
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
}
