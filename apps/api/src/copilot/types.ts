import type { Editor, Plan } from '@dash/shared';

/**
 * A seat as a source reports it — the roster row (seats endpoint) already
 * joined with its 28-day usage metrics (users report). Timestamps, not derived
 * day counts; those are computed at read time.
 */
export interface SeatSnapshot {
  login: string;
  name: string;
  plan: Plan;
  editor: Editor | null;
  language: string | null;
  lastActivityAt: Date | null;
  /** `ai_credits_used` (28d), rounded — the cost model's premium-request proxy. */
  premiumRequests28d: number | null;
  acceptanceRate: number | null;
  usedAgent: boolean | null;
  usedChat: boolean | null;
  topModel: string | null;
}

/** One day of org aggregate, from the `organization-1-day` report. */
export interface OrgDailySnapshot {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  dailyActiveUsers: number;
  weeklyActiveUsers: number;
  monthlyActiveUsers: number;
  interactions: number;
  generations: number;
  acceptances: number;
  locAdded: number;
  locDeleted: number;
}

/** One day of per-model activity, summed across languages. */
export interface ModelDailySnapshot {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  model: string;
  generations: number;
  acceptances: number;
  locAdded: number;
  locDeleted: number;
}

/** Everything one refresh pulls from a source. */
export interface CopilotSnapshot {
  seats: SeatSnapshot[];
  orgDaily: OrgDailySnapshot[];
  modelDaily: ModelDailySnapshot[];
}

/**
 * A source of Copilot data. Implemented by the seeded mock and by the live
 * GitHub reports client; the refresh service only ever sees this interface.
 */
export interface CopilotClient {
  readonly name: string;
  /** Pull the current roster plus up to `historyDays` of daily org/model history. */
  fetchSnapshot(historyDays: number): Promise<CopilotSnapshot>;
}
