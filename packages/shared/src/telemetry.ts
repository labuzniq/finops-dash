/**
 * Claude Code telemetry types shared by the API and the web app.
 *
 * The OTLP ingest stores raw datapoints; the API serves them rolled up to
 * (day, user, model, metric, type) and the web app derives everything else
 * client-side — the same fetch-once-derive-locally shape as the Copilot page.
 */

/** Canonical Claude Code metric names, as emitted over OTLP. */
export const TELEMETRY_METRICS = {
  cost: 'claude_code.cost.usage',
  tokens: 'claude_code.token.usage',
  sessions: 'claude_code.session.count',
  linesOfCode: 'claude_code.lines_of_code.count',
  commits: 'claude_code.commit.count',
  pullRequests: 'claude_code.pull_request.count',
  activeTime: 'claude_code.active_time.total',
} as const;

/**
 * One rolled-up telemetry datapoint. `value` is a plain sum for the day —
 * cumulative series are normalised to deltas at ingest, so summing is always
 * correct. Dimensions the exporter did not send are null, never ''.
 */
export interface TelemetryRollupRow {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  userId: string | null;
  userEmail: string | null;
  /** Model attribute — only token/cost metrics carry it. */
  model: string | null;
  /** OTLP metric name, e.g. `claude_code.token.usage`. */
  metric: string;
  /** The `type` attribute (token kind, lines added/removed, …); null when absent. */
  type: string | null;
  value: number;
}
