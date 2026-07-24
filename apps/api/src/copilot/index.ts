import { env } from '../env.js';
import { EnterpriseBillingClient } from './billing.js';
import { GithubCopilotClient } from './github.js';
import { MockCopilotClient } from './mock.js';
import type { CopilotClient } from './types.js';

/** Picks the data source from env. Validated at boot, so the token is present here. */
export function createCopilotClient(): CopilotClient {
  if (env.COPILOT_SOURCE === 'github') {
    return new GithubCopilotClient(env.GITHUB_TOKEN!, env.GITHUB_ORG!, env.GITHUB_API_VERSION);
  }
  return new MockCopilotClient();
}

/**
 * The enterprise billing client, or null while GITHUB_ENTERPRISE is unset.
 * Env refine guarantees a token exists whenever the slug is set.
 */
export function createBillingClient(): EnterpriseBillingClient | null {
  if (!env.GITHUB_ENTERPRISE) return null;
  const token = env.GITHUB_BILLING_TOKEN ?? env.GITHUB_TOKEN!;
  return new EnterpriseBillingClient(token, env.GITHUB_ENTERPRISE, env.GITHUB_API_VERSION);
}

export type {
  CopilotClient,
  CopilotSnapshot,
  SeatSnapshot,
  OrgDailySnapshot,
  ModelDailySnapshot,
} from './types.js';
export type { EnterpriseBillingClient, UserModelUsage } from './billing.js';
