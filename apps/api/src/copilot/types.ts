import type { Editor, Plan, UsageDimension } from '@dash/shared';

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
  /** Name of the assigning team (seats endpoint); null when assigned directly. */
  team: string | null;
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
  locSuggestedAdd: number;
  locSuggestedDelete: number;
  chatMau: number;
  agentMau: number;
  codeReviewDau: number;
  codeReviewWau: number;
  codeReviewMau: number;
  codeReviewPassiveMau: number;
  cloudAgentDau: number;
  cloudAgentWau: number;
  cloudAgentMau: number;
  prCreated: number;
  prMerged: number;
  prCreatedByCopilot: number;
  prMergedCreatedByCopilot: number;
  prReviewedByCopilot: number;
  prCopilotSuggestions: number;
  prCopilotAppliedSuggestions: number;
}

/**
 * One day of one category's activity for a breakdown dimension, from the
 * daily report's `totals_by_*` arrays (composites collapsed to one key).
 */
export interface BreakdownDailySnapshot {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  dimension: UsageDimension;
  key: string;
  interactions: number;
  generations: number;
  acceptances: number;
  locAdded: number;
  locDeleted: number;
  locSuggestedAdd: number;
  locSuggestedDelete: number;
}

/** One day of one AI-adoption phase, from `totals_by_ai_adoption_phase`. */
export interface AdoptionPhaseDailySnapshot {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  phaseNumber: number;
  phase: string;
  engagedUsers: number;
  avgInteractions: number;
  avgGenerations: number;
  avgAcceptances: number;
  avgLocAdded: number;
  avgLocDeleted: number;
  avgPrCreated: number;
  avgPrReviewed: number;
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

/**
 * Premium usage for a user who is in the 28-day report but no longer on the
 * roster — offboarded mid-window. The bill still counts their overage, so spend
 * must too, even though they have no seat to attribute it to.
 */
export interface OffRosterPremium {
  login: string;
  /** `ai_credits_used` (28d), rounded — non-null, else there is nothing to bill. */
  premiumRequests28d: number;
}

/** Everything one refresh pulls from a source. */
export interface CopilotSnapshot {
  seats: SeatSnapshot[];
  offRosterPremiumRequests: OffRosterPremium[];
  orgDaily: OrgDailySnapshot[];
  modelDaily: ModelDailySnapshot[];
  breakdownDaily: BreakdownDailySnapshot[];
  adoptionDaily: AdoptionPhaseDailySnapshot[];
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
