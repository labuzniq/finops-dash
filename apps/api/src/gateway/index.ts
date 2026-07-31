import { env } from '../env.js';
import { LiteLlmGatewayClient } from './litellm.js';
import { MockGatewayClient } from './mock.js';
import type { GatewayClient } from './types.js';

/**
 * The LLM-gateway source, or null while GATEWAY_SOURCE is `off`. Env refine
 * guarantees the base URL and key exist whenever the source is `litellm`, so
 * this is the last place that knows where gateway data comes from — the
 * service, routes and web app never do.
 */
export function createGatewayClient(): GatewayClient | null {
  switch (env.GATEWAY_SOURCE) {
    case 'litellm':
      return new LiteLlmGatewayClient(env.LITELLM_BASE_URL!, env.LITELLM_API_KEY!);
    case 'mock':
      return new MockGatewayClient();
    case 'off':
      return null;
  }
}

export type {
  GatewayClient,
  GatewaySnapshot,
  GatewayDailySnapshot,
  GatewayBreakdownSnapshot,
  GatewayBudgetSnapshot,
  GatewayModelSnapshot,
} from './types.js';
