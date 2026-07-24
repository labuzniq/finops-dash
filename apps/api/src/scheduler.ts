import { env } from './env.js';
import { moduleLogger } from './log.js';
import { startBillingSync } from './services/billing-sync.js';

/**
 * In-process daily trigger for the enterprise billing sync — no cron
 * dependency, no external scheduler. One timer aims at the next 07:00
 * Europe/Prague (CET/CEST resolved via Intl, so DST needs no special-casing),
 * fires the same `startBillingSync` the manual route uses, and re-aims.
 *
 * 07:00 local is well past midnight UTC year-round, so "yesterday UTC" — the
 * sync's newest target day — is always complete when the timer fires. Missed
 * runs (process down at 07:00) are simply skipped; the next run's two-day
 * window re-pulls the gap's most recent day anyway.
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

/**
 * Arms the daily billing-sync timer. No-op (returns null) while
 * GITHUB_ENTERPRISE is unset. Returns a stop function for shutdown.
 */
export function startBillingScheduler(): (() => void) | null {
  if (!env.GITHUB_ENTERPRISE) {
    log.info('billing scheduler off — GITHUB_ENTERPRISE is not set');
    return null;
  }

  let timer: NodeJS.Timeout;

  const arm = (): void => {
    const runAt = nextRunAt(new Date());
    timer = setTimeout(() => {
      void fire().finally(arm);
    }, runAt.getTime() - Date.now());
    log.info(
      { dash: { runAt: runAt.toISOString(), timeZone: TIME_ZONE } },
      'billing sync scheduled',
    );
  };

  const fire = async (): Promise<void> => {
    try {
      const job = await startBillingSync();
      log.info(
        { 'event.action': 'billing-sync-scheduled', dash: { jobId: job.id, status: job.status } },
        'scheduled billing sync started',
      );
    } catch (error) {
      // startJob never throws for job failures — this is config/db trouble.
      // Log and keep the schedule armed; tomorrow retries.
      log.error(
        { 'event.action': 'billing-sync-scheduled', 'event.outcome': 'failure', err: error },
        'scheduled billing sync failed to start',
      );
    }
  };

  arm();
  return () => clearTimeout(timer);
}
