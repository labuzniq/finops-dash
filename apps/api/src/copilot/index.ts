import { env } from '../env.js';
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

export type {
  CopilotClient,
  CopilotSnapshot,
  SeatSnapshot,
  OrgDailySnapshot,
  ModelDailySnapshot,
} from './types.js';
