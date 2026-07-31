import type { GatewayCoverage, GatewayCoverageGap } from '@dash/shared';
import type { GatewaySyncWindow } from '../../api/client.js';
import styles from './GatewayCoverageNote.module.css';

/**
 * What the stored history does and does not cover.
 *
 * Every other surface on this page reads *usage*: it takes the days the API
 * answered with and derives money from them. This one reads the shape of the
 * table underneath, and it exists because two facts about that shape change
 * what the numbers above mean, and neither is visible from inside a usage
 * payload:
 *
 * - **A gap is not a quiet week.** `deriveGateway` zero-fills interior days on
 *   purpose — a quiet weekend is a real dip and dropping it would misdraw every
 *   chart. A stretch when the scheduler was down zero-fills identically, and
 *   reads as a fortnight when the corporation stopped using the gateway. The
 *   only place the two can be told apart is here, against the list of dates
 *   that actually have rows.
 * - **History past retention is unrepeatable.** The proxy prunes its daily
 *   rollup at 90 days; the sync deletes only the dates it re-fetched, so
 *   everything older survives here and nowhere else. That is worth stating
 *   plainly, because it is also the part of the range no future sync can
 *   correct if it is wrong.
 *
 * A gap newer than the retention floor also carries a **Fill** button, which is
 * the whole reason the note distinguishes the two kinds: a run the proxy can
 * still answer for is a repair someone can make in one click, and a run it has
 * pruned is a fact to be read. The button asks for exactly that run rather than
 * the nightly window, so repairing six days in May does not re-pull a quarter —
 * and a run straddling the floor is asked for from the floor onwards, since
 * that is the part of it that still exists upstream.
 *
 * Renders nothing when there is nothing to say, which is the normal state of a
 * gateway synced daily for under three months.
 */

/** `2026-05-04 – 2026-05-09`, or the single date when the run is one day. */
function gapLabel(gap: GatewayCoverageGap): string {
  return gap.days === 1 ? gap.from : `${gap.from} – ${gap.to}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The part of a gap a sync could still fill, or null when the proxy has pruned
 * all of it. Clamping at the floor rather than dropping the whole run is what
 * makes a gap that straddles it half-repairable instead of hopeless.
 */
function fillableWindow(gap: GatewayCoverageGap, retentionFloor: string): GatewaySyncWindow | null {
  if (gap.to < retentionFloor) return null;
  return { from: gap.from < retentionFloor ? retentionFloor : gap.from, to: gap.to };
}

interface GatewayCoverageNoteProps {
  coverage: GatewayCoverage | null;
  /** Kicks off a backfill of exactly one gap run. */
  onBackfill: (window: GatewaySyncWindow) => void;
  /** A sync of any window is in flight — every button waits for it. */
  isSyncing: boolean;
}

export function GatewayCoverageNote({
  coverage,
  onBackfill,
  isSyncing,
}: GatewayCoverageNoteProps) {
  if (coverage === null || coverage.firstDay === null) return null;

  const hasGaps = coverage.missingDays > 0;
  const hasHistory = coverage.daysBeyondRetention > 0;
  if (!hasGaps && !hasHistory) return null;

  return (
    <div className={styles.note}>
      {hasGaps && (
        <div className={styles.row}>
          <span className={styles.badge}>Gaps</span>
          <div className={styles.body}>
            <span className={styles.text}>
              {plural(coverage.missingDays, 'day')} between {coverage.firstDay} and{' '}
              {coverage.lastDay} carry no data at all — they draw as zero on every chart here, which
              is not the same claim as a quiet day. Days older than {coverage.retentionFloor} can no
              longer be re-fetched; anything newer a sync will fill.
            </span>

            {coverage.gaps.length > 0 && (
              <ul className={styles.gaps}>
                {coverage.gaps.map((gap) => {
                  const window = fillableWindow(gap, coverage.retentionFloor);
                  return (
                    <li key={gap.from} className={styles.gap}>
                      <span className={styles.gapLabel}>{gapLabel(gap)}</span>
                      {window === null ? (
                        <span className={styles.gone}>pruned upstream</span>
                      ) : (
                        <button
                          type="button"
                          className={styles.fill}
                          onClick={() => onBackfill(window)}
                          disabled={isSyncing}
                          title={`Re-fetch ${window.from} – ${window.to} from the proxy`}
                        >
                          {isSyncing ? 'Syncing…' : 'Fill'}
                        </button>
                      )}
                    </li>
                  );
                })}
                {coverage.gapsTruncated && (
                  <li className={styles.gap}>
                    <span className={styles.gapLabel}>
                      … and older runs — a full sync covers every one still inside the window
                    </span>
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      )}

      {hasHistory && (
        <div className={styles.row}>
          <span className={styles.badge}>Archive</span>
          <span className={styles.text}>
            {plural(coverage.daysBeyondRetention, 'day')} of history here predate the proxy&apos;s{' '}
            {coverage.retentionDays}-day window and exist only in this database. The range picker
            reaches back to {coverage.firstDay} because of them, and they cannot be re-synced if
            they are wrong.
          </span>
        </div>
      )}
    </div>
  );
}
