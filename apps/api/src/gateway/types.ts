import type { GatewayDimension, GatewaySource } from '@dash/shared';

/**
 * What a gateway source hands the sync — insert-shaped rows, money already in
 * bigint nano-dollars. Same contract shape as `CopilotSnapshot`: the client
 * owns the wire format, the service owns Postgres.
 */

/** One bucket's counters, in storage units. */
export interface GatewayCounters {
  /** USD × 1e9. */
  spendNano: bigint;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** One day of gateway-wide totals. */
export interface GatewayDailySnapshot extends GatewayCounters {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
}

/** One day of one key within one dimension. */
export interface GatewayBreakdownSnapshot extends GatewayCounters {
  date: string;
  dimension: GatewayDimension;
  key: string;
  label: string | null;
}

export interface GatewaySnapshot {
  daily: GatewayDailySnapshot[];
  breakdowns: GatewayBreakdownSnapshot[];
  /**
   * The days the fetch actually covered, ISO, ascending. The sync replaces
   * exactly these dates — a day the gateway reported nothing for is still
   * covered (it means "zero", not "no data"), so its stale rows must go.
   */
  dates: string[];
}

export interface GatewayClient {
  /** Source name, for job logs. */
  readonly name: GatewaySource;
  /** Usage for the inclusive ISO date range, gateway-wide plus every breakdown. */
  fetchUsage(from: string, to: string): Promise<GatewaySnapshot>;
}

export const ZERO_COUNTERS: GatewayCounters = {
  spendNano: 0n,
  requests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** Accumulates `add` into `into`. Buckets arrive split across pages and calls. */
export function addCounters(into: GatewayCounters, add: Readonly<GatewayCounters>): void {
  into.spendNano += add.spendNano;
  into.requests += add.requests;
  into.successfulRequests += add.successfulRequests;
  into.failedRequests += add.failedRequests;
  into.promptTokens += add.promptTokens;
  into.completionTokens += add.completionTokens;
  into.totalTokens += add.totalTokens;
  into.cacheReadTokens += add.cacheReadTokens;
  into.cacheCreationTokens += add.cacheCreationTokens;
}
