import type {
  GatewayBudgetHistory,
  GatewayBudgetObservation,
  GatewayBudgetScope,
} from '@dash/shared';

/**
 * What the governance state *did* — the one gateway derivation whose input is
 * a record of our own observations rather than a record of the gateway.
 *
 * `gatewayBudgets.ts` reads the proxy's current state and is deliberately
 * history-free, because the proxy has no history to give: `/key/list` answers
 * with the counter for the period in flight and nothing about the period before
 * it. That leaves three ordinary questions unanswerable — *when* did this team
 * go over, what did its last period come to, who moved the cap — and none of
 * them can be recovered from `gateway_daily`, because the enforced counter runs
 * on the key's own schedule and is not our sum of days.
 *
 * So the sync keeps what it saw, one reading per governed object per UTC day,
 * and this module reads consecutive readings as *changes*. Three properties of
 * that input decide everything here:
 *
 *  - **It is a sample, so a missing day is unknown.** Not zero, not "unchanged".
 *    Every point carries `observed`, nothing is interpolated, and a gap between
 *    two readings is itself an event — because a cap could have been raised and
 *    lowered again inside it and this module would never know.
 *  - **A period total is a floor.** The counter is read once a day; whatever
 *    landed between the last reading and the reset is not in it. `observedTotal`
 *    is named for that and the card says so.
 *  - **Crossings are inferred, not reported.** LiteLLM does not tell us a key
 *    went over — we see 94% one morning and 103% the next. The event is dated to
 *    the day it was *seen*, which is the strongest claim the sampling supports.
 *
 * Pure like every module in `lib/metrics/`, and the only one whose spine starts
 * at `recordingSince`: there is no backfill for this table and never will be, so
 * a window reaching before the first observation is drawn as the shorter thing
 * it really is rather than as a run of empty days.
 */

/**
 * What changed between two consecutive readings.
 *
 *  - `gap` — days went unobserved. Emitted on the reading that *ends* the gap,
 *    and it caps what every other event on that day can claim.
 *  - `reset` — the counter fell, so the budget period rolled. The only way a
 *    period boundary is ever visible: `resetAt` says when the next one is due,
 *    and a proxy that reset early or late would still be caught here.
 *  - `cap` / `soft` / `limits` / `renamed` — configuration moved. Not adverse in
 *    themselves; a raised cap is the ordinary answer to an overrun.
 *  - `blocked` / `unblocked` — the proxy started or stopped rejecting its calls.
 *  - `over` / `soft-breach` — the counter crossed a line. Note that a *lowered
 *    cap* produces a crossing with no extra spend at all, which is why the two
 *    events sit on the same day and are both kept.
 */
export type BudgetEventKind =
  | 'gap'
  | 'reset'
  | 'cap'
  | 'soft'
  | 'limits'
  | 'renamed'
  | 'blocked'
  | 'unblocked'
  | 'over'
  | 'soft-breach';

export interface BudgetEvent {
  /** The day it was *seen* — with daily sampling, never the day it happened. */
  date: string;
  kind: BudgetEventKind;
  /** Worth someone's attention, as opposed to bookkeeping. */
  adverse: boolean;
  /** The pair of numbers the event is about, where it is about numbers. */
  from: number | null;
  to: number | null;
  /** Everything that is not a pair of numbers — a rename, a limit change. */
  note: string | null;
}

/**
 * A budget period that opened and closed while we were watching.
 *
 * `observedTotal` is the last counter seen before the roll, which is a **floor**
 * on what the period actually billed: the reading is taken once a day and the
 * reset happens on the proxy's clock, so anything spent in between is invisible.
 * Reporting it as the period's spend would be the same mistake as zero-filling
 * an unobserved day.
 */
export interface BudgetPeriodRecord {
  /** First day observed inside the period. */
  from: string;
  /** Last day observed before the counter rolled. */
  to: string;
  /** Last counter seen before the roll — a floor, never a total. */
  observedTotal: number;
  /** The cap in force on that last day, for scale. Null when uncapped. */
  maxBudget: number | null;
  /** It was past its cap when it closed. */
  over: boolean;
  /**
   * The roll was seen across consecutive days.
   *
   * False means the sampling has a hole across the boundary, so an entire
   * further period may have opened and closed unseen and `observedTotal` may
   * not even belong to the period it is filed under.
   */
  contiguous: boolean;
}

export interface BudgetHistoryPoint {
  date: string;
  /** False on a day no sync ran. Nothing else on the point means anything then. */
  observed: boolean;
  spend: number | null;
  /** Share of the cap in force that day. Null when uncapped or unobserved. */
  utilization: number | null;
  /** The counter rolled into this day — the strip draws a break, not a fall. */
  reset: boolean;
}

/** One governed object's whole recorded life inside the window. */
export interface BudgetHistoryRow {
  scope: GatewayBudgetScope;
  key: string;
  /** The most recent alias seen — the card renders history under today's name. */
  label: string | null;
  points: BudgetHistoryPoint[];
  events: BudgetEvent[];
  periods: BudgetPeriodRecord[];
  daysObserved: number;
  /** Days inside its own observed span that carry no reading. */
  daysMissing: number;
  firstSeen: string;
  lastSeen: string;
  /** Highest share of cap seen on any observed day. Null if never capped. */
  peakUtilization: number | null;
  peakSpend: number;
  /** Over its cap on at least one observed day — whether or not it is now. */
  everOver: boolean;
  everBlocked: boolean;
  resets: number;
  capChanges: number;
  /** One reading only: it exists, and nothing about change can be said yet. */
  thin: boolean;
}

export interface BudgetHistorySummary {
  /** The window asked for. */
  from: string;
  to: string;
  /** The window actually drawn — clamped forward to the first ever observation. */
  spineFrom: string;
  recordingSince: string | null;
  /** Calendar days of the drawn window, ascending. Every row shares this spine. */
  dates: string[];
  /** Days in it that carry at least one reading of anything. */
  daysRecorded: number;
  rows: BudgetHistoryRow[];
  /** Counts of objects, never dollars — same rule as the budget card itself. */
  everOver: number;
  everBlocked: number;
  resets: number;
  capChanges: number;
  /** Nothing recorded at all: a fresh install, or a proxy with no management routes. */
  isEmpty: boolean;
  /**
   * Fewer than two days recorded anywhere, so no change is observable yet.
   *
   * The distinction the whole card turns on: "this key never went over" and "we
   * have been watching since yesterday" look identical in the events list and
   * mean opposite things.
   */
  tooShort: boolean;
}

/**
 * Half a cent. A counter that fell by less than this rolled nowhere — it is
 * float noise from the nano→dollars conversion, and reading it as a period
 * boundary would invent a period a day long.
 */
const RESET_EPSILON = 0.005;

function shiftIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDiff(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00.000Z`).getTime();
  const b = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

function utilizationOf(observation: GatewayBudgetObservation): number | null {
  if (observation.maxBudget === null || observation.maxBudget <= 0) return null;
  return (observation.spend / observation.maxBudget) * 100;
}

function limitNote(previous: GatewayBudgetObservation, current: GatewayBudgetObservation): string {
  const parts: string[] = [];
  const show = (value: number | null): string => (value === null ? 'none' : String(value));
  if (previous.rpmLimit !== current.rpmLimit) {
    parts.push(`rpm ${show(previous.rpmLimit)} → ${show(current.rpmLimit)}`);
  }
  if (previous.tpmLimit !== current.tpmLimit) {
    parts.push(`tpm ${show(previous.tpmLimit)} → ${show(current.tpmLimit)}`);
  }
  return parts.join(' · ');
}

function event(
  date: string,
  kind: BudgetEventKind,
  adverse: boolean,
  from: number | null = null,
  to: number | null = null,
  note: string | null = null,
): BudgetEvent {
  return { date, kind, adverse, from, to, note };
}

/**
 * Read one object's readings as a story.
 *
 * Walks consecutive pairs once. Order inside a day is deliberate — the gap
 * first (it bounds every claim made about that day), then the reset (it
 * explains a fall that would otherwise read as a recovery), then configuration,
 * then the crossings, which are the only ones a reader is meant to act on.
 */
function toRow(
  observations: readonly GatewayBudgetObservation[],
  dates: readonly string[],
): BudgetHistoryRow {
  const byDate = new Map<string, GatewayBudgetObservation>();
  for (const observation of observations) byDate.set(observation.date, observation);

  const events: BudgetEvent[] = [];
  const periods: BudgetPeriodRecord[] = [];
  const resetDays = new Set<string>();

  let periodFrom = observations[0]?.date ?? null;
  let resets = 0;
  let capChanges = 0;

  for (let i = 1; i < observations.length; i++) {
    const previous = observations[i - 1];
    const current = observations[i];
    if (previous === undefined || current === undefined) continue;

    const missing = dayDiff(previous.date, current.date) - 1;
    if (missing > 0) events.push(event(current.date, 'gap', false, null, missing));

    if (current.spend < previous.spend - RESET_EPSILON) {
      resets += 1;
      resetDays.add(current.date);
      const previousUtilization = utilizationOf(previous);
      periods.push({
        from: periodFrom ?? previous.date,
        to: previous.date,
        observedTotal: previous.spend,
        maxBudget: previous.maxBudget,
        over: previousUtilization !== null && previousUtilization >= 100,
        contiguous: missing === 0,
      });
      periodFrom = current.date;
      events.push(event(current.date, 'reset', false, previous.spend, current.spend));
    }

    if (previous.maxBudget !== current.maxBudget) {
      capChanges += 1;
      events.push(event(current.date, 'cap', false, previous.maxBudget, current.maxBudget));
    }
    if (previous.softBudget !== current.softBudget) {
      events.push(event(current.date, 'soft', false, previous.softBudget, current.softBudget));
    }
    if (previous.tpmLimit !== current.tpmLimit || previous.rpmLimit !== current.rpmLimit) {
      events.push(
        event(current.date, 'limits', false, null, null, limitNote(previous, current)),
      );
    }
    if (previous.label !== current.label) {
      events.push(
        event(
          current.date,
          'renamed',
          false,
          null,
          null,
          `${previous.label ?? previous.key} → ${current.label ?? current.key}`,
        ),
      );
    }
    if (previous.blocked !== current.blocked) {
      events.push(event(current.date, current.blocked ? 'blocked' : 'unblocked', current.blocked));
    }

    // Crossings are compared against the *previous* reading's own cap, so a
    // lowered cap that puts an unchanged counter over the line is a genuine
    // crossing — which is the point: nothing was spent and the key is now over.
    const before = utilizationOf(previous);
    const after = utilizationOf(current);
    if (after !== null && after >= 100 && (before === null || before < 100)) {
      events.push(event(current.date, 'over', true, before, after));
    } else if (
      current.softBudget !== null &&
      current.spend >= current.softBudget &&
      !(previous.softBudget !== null && previous.spend >= previous.softBudget) &&
      !(after !== null && after >= 100)
    ) {
      events.push(event(current.date, 'soft-breach', true, previous.spend, current.spend));
    }
  }

  const first = observations[0];
  const last = observations[observations.length - 1];
  const firstSeen = first?.date ?? '';
  const lastSeen = last?.date ?? '';

  const points: BudgetHistoryPoint[] = dates.map((date) => {
    const observation = byDate.get(date);
    if (observation === undefined) {
      return { date, observed: false, spend: null, utilization: null, reset: false };
    }
    return {
      date,
      observed: true,
      spend: observation.spend,
      utilization: utilizationOf(observation),
      reset: resetDays.has(date),
    };
  });

  let peakUtilization: number | null = null;
  let peakSpend = 0;
  let everOver = false;
  let everBlocked = false;
  for (const observation of observations) {
    const utilization = utilizationOf(observation);
    if (utilization !== null && (peakUtilization === null || utilization > peakUtilization)) {
      peakUtilization = utilization;
    }
    if (utilization !== null && utilization >= 100) everOver = true;
    if (observation.spend > peakSpend) peakSpend = observation.spend;
    if (observation.blocked) everBlocked = true;
  }

  // Measured over the object's *own* span, not the window's: a key created last
  // Tuesday has no missing days before it existed.
  const span = firstSeen === '' ? 0 : dayDiff(firstSeen, lastSeen) + 1;

  return {
    scope: first?.scope ?? 'api_key',
    key: first?.key ?? '',
    label: last?.label ?? null,
    points,
    events,
    periods,
    daysObserved: observations.length,
    daysMissing: Math.max(0, span - observations.length),
    firstSeen,
    lastSeen,
    peakUtilization,
    peakSpend,
    everOver,
    everBlocked,
    resets,
    capChanges,
    thin: observations.length < 2,
  };
}

/**
 * Group the recorded observations by governed object and read each one's
 * changes.
 *
 * The spine starts at the later of the window and `recordingSince`, so a
 * 60-day window on a dashboard that has been recording for four days draws four
 * days. Every row shares it, which is what lets the card stack the strips.
 */
export function deriveBudgetHistory(
  history: GatewayBudgetHistory | undefined,
): BudgetHistorySummary {
  const from = history?.from ?? '';
  const to = history?.to ?? '';
  const recordingSince = history?.recordingSince ?? null;
  const spineFrom = recordingSince !== null && recordingSince > from ? recordingSince : from;

  const dates: string[] = [];
  if (from !== '' && to !== '' && spineFrom <= to) {
    for (let date = spineFrom; date <= to; date = shiftIso(date, 1)) dates.push(date);
  }

  const byObject = new Map<string, GatewayBudgetObservation[]>();
  const recordedDays = new Set<string>();
  for (const observation of history?.observations ?? []) {
    recordedDays.add(observation.date);
    const id = `${observation.scope}:${observation.key}`;
    const rows = byObject.get(id);
    if (rows === undefined) byObject.set(id, [observation]);
    else rows.push(observation);
  }

  const rows: BudgetHistoryRow[] = [];
  for (const observations of byObject.values()) {
    // The route orders by date, but a caller assembling a payload by hand need
    // not have; the pair walk is only meaningful in order.
    observations.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    rows.push(toRow(observations, dates));
  }

  // Worst first: what went over, then what was blocked, then by peak pressure —
  // the same "act on this one" ordering the budget card itself uses.
  rows.sort((a, b) => {
    if (a.everOver !== b.everOver) return a.everOver ? -1 : 1;
    if (a.everBlocked !== b.everBlocked) return a.everBlocked ? -1 : 1;
    const left = a.peakUtilization ?? -1;
    const right = b.peakUtilization ?? -1;
    if (left !== right) return right - left;
    return (a.label ?? a.key).localeCompare(b.label ?? b.key);
  });

  return {
    from,
    to,
    spineFrom,
    recordingSince,
    dates,
    daysRecorded: recordedDays.size,
    rows,
    everOver: rows.filter((row) => row.everOver).length,
    everBlocked: rows.filter((row) => row.everBlocked).length,
    resets: rows.reduce((total, row) => total + row.resets, 0),
    capChanges: rows.reduce((total, row) => total + row.capChanges, 0),
    isEmpty: rows.length === 0,
    tooShort: recordedDays.size < 2,
  };
}

/** The recorded life of one governed object, or null when it has none. */
export function findBudgetHistoryRow(
  summary: BudgetHistorySummary,
  scope: GatewayBudgetScope,
  key: string,
): BudgetHistoryRow | null {
  return summary.rows.find((row) => row.scope === scope && row.key === key) ?? null;
}
