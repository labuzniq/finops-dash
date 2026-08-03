import type { RefreshJob } from '@dash/shared';
import { env } from './env.js';
import { moduleLogger } from './log.js';
import { startBillingSync } from './services/billing-sync.js';
import { startGatewaySync } from './services/gateway-sync.js';
import { startJiraSync } from './services/jira-sync.js';
import { startMembersSync } from './services/members-sync.js';
import { startRefresh } from './services/refresh.js';

/**
 * In-process daily trigger for every data pull — no cron dependency, no
 * external scheduler. One timer aims at the next 07:00 Europe/Prague (CET/CEST
 * resolved via Intl, so DST needs no special-casing), fires the same sync
 * entry points the manual routes use (Copilot analytics refresh, org member
 * sync, JIRA identity sync, enterprise billing sync, LLM-gateway sync), and
 * re-aims. Each job is a distinct `refresh_jobs` kind, single-flight per kind,
 * safe to run concurrently.
 *
 * 07:00 local is well past midnight UTC year-round, so "yesterday UTC" — the
 * billing sync's newest target day — is always complete when the timer fires.
 * Missed runs (process down at 07:00) are simply skipped; the billing sync's
 * two-day window re-pulls the gap's most recent day anyway, and the other two
 * pulls are full snapshots.
 */

const TIME_ZONE = 'Europe/Prague';
const RUN_HOUR = 7;

const log = moduleLogger('scheduler');

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const partsFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function localParts(instant: Date): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of partsFormat.formatToParts(instant)) parts[part.type] = part.value;
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    // Intl renders midnight as "24" with hour12: false in some ICU versions.
    hour: Number(parts['hour']) % 24,
    minute: Number(parts['minute']),
  };
}

/**
 * The next instant whose Europe/Prague wall-clock reads 07:00. Candidates are
 * built by taking the local calendar date 0–2 days ahead and testing both
 * possible offsets (CET +1, CEST +2); the one that formats back to 07:00 on
 * that date wins. Exported for direct inspection; the API has no test runner.
 */
export function nextRunAt(now: Date): Date {
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const local = localParts(new Date(now.getTime() + dayOffset * 86_400_000));
    for (const utcOffsetMinutes of [60, 120]) {
      const candidate = new Date(
        Date.UTC(local.year, local.month - 1, local.day, RUN_HOUR, 0, 0) -
          utcOffsetMinutes * 60_000,
      );
      if (candidate.getTime() <= now.getTime()) continue;
      const check = localParts(candidate);
      if (
        check.year === local.year &&
        check.month === local.month &&
        check.day === local.day &&
        check.hour === RUN_HOUR &&
        check.minute === 0
      ) {
        return candidate;
      }
    }
  }
  throw new Error(`could not resolve the next ${RUN_HOUR}:00 in ${TIME_ZONE}`);
}

interface ScheduledSync {
  name: string;
  /** Why the sync stays off this run, or null when it should fire. */
  disabledReason: () => string | null;
  start: () => Promise<RefreshJob>;
}

/**
 * Every data pull the app knows, in one place. Availability mirrors each
 * manual route's guard: the Copilot refresh always has a source (mock or
 * github — env.ts refuses to boot otherwise), the member sync needs an org and
 * a token, JIRA needs its credentials unless the mock source is active,
 * billing needs GITHUB_ENTERPRISE, and the LLM gateway needs GATEWAY_SOURCE to
 * be anything but `off`.
 */
const SYNCS: ScheduledSync[] = [
  {
    name: 'copilot-refresh',
    disabledReason: () => null,
    start: startRefresh,
  },
  {
    // Ahead of jira-sync by intent only, not by guarantee: `startJob` returns
    // once the row is inserted and runs the body detached, so JIRA resolves a
    // login that joined today on tomorrow's run. That one-day lag on a new
    // joiner's department is not worth coupling two independent syncs.
    name: 'members-sync',
    disabledReason: () =>
      env.GITHUB_ORG && (env.GITHUB_MEMBERS_TOKEN || env.GITHUB_TOKEN)
        ? null
        : 'GITHUB_ORG and GITHUB_MEMBERS_TOKEN (or GITHUB_TOKEN) are not set',
    start: startMembersSync,
  },
  {
    name: 'jira-sync',
    disabledReason: () =>
      env.JIRA_BASE_URL || env.COPILOT_SOURCE === 'mock'
        ? null
        : 'JIRA_BASE_URL and JIRA_TOKEN are not set',
    start: startJiraSync,
  },
  {
    name: 'billing-sync',
    disabledReason: () => (env.GITHUB_ENTERPRISE ? null : 'GITHUB_ENTERPRISE is not set'),
    start: startBillingSync,
  },
  {
    name: 'gateway-sync',
    disabledReason: () => (env.GATEWAY_SOURCE === 'off' ? 'GATEWAY_SOURCE is off' : null),
    start: startGatewaySync,
  },
];

/**
 * Arms the daily sync timer for all configured data pulls. Unconfigured syncs
 * are logged and skipped each run (config is fixed at boot, but the log keeps
 * the reason visible daily). Returns a stop function for shutdown.
 */
export function startScheduler(): () => void {
  let timer: NodeJS.Timeout;

  const arm = (): void => {
    const runAt = nextRunAt(new Date());
    timer = setTimeout(() => {
      void fire().finally(arm);
    }, runAt.getTime() - Date.now());
    log.info(
      {
        dash: {
          runAt: runAt.toISOString(),
          timeZone: TIME_ZONE,
          syncs: SYNCS.filter((sync) => sync.disabledReason() === null).map((sync) => sync.name),
        },
      },
      'daily syncs scheduled',
    );
  };

  const fire = async (): Promise<void> => {
    for (const sync of SYNCS) {
      const reason = sync.disabledReason();
      if (reason !== null) {
        log.info({ dash: { sync: sync.name, reason } }, 'scheduled sync skipped — not configured');
        continue;
      }
      try {
        const job = await sync.start();
        log.info(
          {
            'event.action': `${sync.name}-scheduled`,
            dash: { sync: sync.name, jobId: job.id, status: job.status },
          },
          'scheduled sync started',
        );
      } catch (error) {
        // startJob never throws for job failures — this is config/db trouble.
        // Log and keep the schedule armed; tomorrow retries.
        log.error(
          {
            'event.action': `${sync.name}-scheduled`,
            'event.outcome': 'failure',
            err: error,
          },
          'scheduled sync failed to start',
        );
      }
    }
  };

  arm();
  return () => clearTimeout(timer);
}
