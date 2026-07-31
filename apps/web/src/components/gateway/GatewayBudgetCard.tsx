import { useState } from 'react';
import { GATEWAY_BUDGET_SCOPE_LABELS, parseBudgetDuration } from '@dash/shared';
import type { GatewayBudget, GatewayBudgetScope } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, EMPTY, isoDateLabel, percent, usd } from '../../lib/format.js';
import type { BudgetRow, BudgetScopeSummary } from '../../lib/metrics/gatewayBudgets.js';
import { findBudgetHistoryRow } from '../../lib/metrics/gatewayBudgetHistory.js';
import type {
  BudgetEvent,
  BudgetHistoryRow,
  BudgetHistorySummary,
} from '../../lib/metrics/gatewayBudgetHistory.js';
import { Card } from '../Card.js';
import styles from './GatewayBudgetCard.module.css';

/**
 * What the proxy will stop — budgets, rate limits and how far through the
 * period in flight each governed object is.
 *
 * This is the only card on the page that is not a view of the range picker's
 * days. Everything else asks what the gateway *did*; this asks what it is
 * *allowed* to do next, which has no history and no spine — LiteLLM reports one
 * current state per key and per team, and the sync replaces it wholesale.
 *
 * A scope switcher rather than two stacked tables, for the breakdown card's
 * reason: a key's cap and its team's cap govern the same dollars, so putting
 * them side by side invites adding them. And no column here totals, ever —
 * every row's spend is measured over that row's own period, and a weekly $30
 * cap plus a monthly $1,800 one is a number with no unit. The footer counts
 * objects instead.
 */

interface GatewayBudgetCardProps {
  scopes: readonly BudgetScopeSummary[];
  scope: GatewayBudgetScope;
  onScope: (scope: GatewayBudgetScope) => void;
  /** True once the budgets query has answered — an empty list then means something. */
  loaded: boolean;
  /**
   * What the same rows read on previous days — our own recording, since the
   * proxy has none. Drives the per-row disclosure and nothing else on the card:
   * every number above the fold is still current state.
   */
  history: BudgetHistorySummary;
}

/** LiteLLM's duration grammar in the card's voice: `1mo` → "per month". */
const UNIT_NAMES = {
  s: 'second',
  m: 'minute',
  h: 'hour',
  d: 'day',
  w: 'week',
  mo: 'month',
} as const;

function periodLabel(duration: string | null): string {
  if (duration === null) return 'never resets';
  const parsed = parseBudgetDuration(duration);
  if (parsed === null) return duration;
  const unit = UNIT_NAMES[parsed.unit];
  return parsed.value === 1 ? `per ${unit}` : `per ${parsed.value} ${unit}s`;
}

/** "resets in 6d" — the counter's own clock, not the dashboard's range. */
function resetLabel(budget: GatewayBudget, now: Date): string | null {
  if (budget.resetAt === null) return null;
  const ms = new Date(budget.resetAt).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'resetting';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `resets in ${Math.max(1, Math.floor(ms / 60_000))}m`;
  if (hours < 48) return `resets in ${hours}h`;
  return `resets in ${Math.floor(hours / 24)}d`;
}

const STATE_BADGE: Record<BudgetRow['state'], string | null> = {
  blocked: 'blocked',
  over: 'over budget',
  soft: 'soft budget',
  warn: null,
  ok: null,
  uncapped: 'uncapped',
};

export function GatewayBudgetCard({
  scopes,
  scope,
  onScope,
  loaded,
  history,
}: GatewayBudgetCardProps) {
  const now = new Date();
  const active = scopes.find((candidate) => candidate.scope === scope) ?? scopes[0];
  // Held as a key string and resolved against the rows on screen, so switching
  // scope closes the panel instead of showing a team's history under a key.
  const [openKey, setOpenKey] = useState<string | null>(null);

  if (!loaded) return null;

  if (active === undefined) {
    return (
      <Card padded={false} className={styles.card}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>Budgets and limits</div>
            <div className={styles.sub}>
              what the proxy will stop · one row per key, team and configured tag, replaced on every
              sync
            </div>
          </div>
        </div>
        <div className={styles.empty}>
          The proxy reported no budgets. LiteLLM&apos;s <code>/key/list</code>,{' '}
          <code>/team/list</code> and <code>/tag/list</code> are management routes — an
          analytics-only credential is refused them, and a refusal and a genuinely ungoverned
          gateway look identical from here.
        </div>
      </Card>
    );
  }

  const label = GATEWAY_BUDGET_SCOPE_LABELS[active.scope].toLowerCase();

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Budgets and limits</div>
          <div className={styles.sub}>
            {active.spendIsCumulative
              ? "LiteLLM's own enforced counter, cumulative since each tag was created · nothing here totals"
              : "LiteLLM's own enforced counter for the period in flight · each row is measured over its own period, so nothing here totals"}
          </div>
        </div>

        <div className={styles.headerRight}>
          <div className={styles.headline}>
            <div
              className={cx(styles.headlineValue, active.attention > 0 && styles.bad)}
            >
              {active.attention}
            </div>
            <div className={styles.headlineNote}>
              of {active.total} {label}
              {active.total === 1 ? '' : 's'} need attention
            </div>
          </div>

          <div className={styles.segmented} role="group" aria-label="Budget scope">
            {scopes.map((option) => {
              const selected = option.scope === active.scope;
              return (
                <button
                  key={option.scope}
                  type="button"
                  className={cx(styles.segment, selected && styles.segmentActive)}
                  aria-pressed={selected}
                  onClick={() => onScope(option.scope)}
                >
                  {GATEWAY_BUDGET_SCOPE_LABELS[option.scope]}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className={cx(styles.row, styles.headerStrip)}>
        <div>{GATEWAY_BUDGET_SCOPE_LABELS[active.scope].toUpperCase()}</div>
        <div />
        <div className={styles.right}>SPEND · PERIOD</div>
        <div className={styles.right}>REMAINING</div>
        <div className={styles.right}>ON THIS PACE</div>
        <div className={styles.right}>RATE LIMITS</div>
      </div>

      {active.rows.map((row) => {
        const id = `${row.budget.scope}:${row.budget.key}`;
        return (
          <BudgetLine
            key={id}
            row={row}
            now={now}
            history={findBudgetHistoryRow(history, row.budget.scope, row.budget.key)}
            historySummary={history}
            open={openKey === id}
            onToggle={() => setOpenKey(openKey === id ? null : id)}
          />
        );
      })}

      <div className={styles.footer}>
        {active.capped} of {active.total} {label}
        {active.total === 1 ? '' : 's'} capped
        {active.uncapped > 0 && ` · ${active.uncapped} uncapped`}
        {active.rateLimited > 0 && ` · ${active.rateLimited} rate-limited`}
        {active.projectedOverrun > 0 &&
          ` · ${active.projectedOverrun} pacing past the cap before it resets`}
        . Caps set over different periods are never added together — a weekly budget and a monthly
        one do not share a unit.
        {active.spendIsCumulative && (
          <>
            {' '}
            LiteLLM&apos;s reset job has no tag handler (
            <code>BerriAI/litellm#27481</code>), so a tag&apos;s counter keeps climbing while its
            budget&apos;s reset date rolls: the percentages below are what the proxy enforces —
            a tag past its cap stays refused rather than recovering next period — but they are
            spend since the tag was created, not spend this period, and no pace is projected from
            them.
          </>
        )}
        {history.recordingSince !== null && (
          <>
            {' '}
            Recorded since {isoDateLabel(history.recordingSince)} ({history.daysRecorded} day
            {history.daysRecorded === 1 ? '' : 's'})
            {history.everOver > 0 &&
              ` · ${history.everOver} object${history.everOver === 1 ? ' has' : 's have'} been over a cap`}
            {history.capChanges > 0 &&
              ` · ${history.capChanges} cap change${history.capChanges === 1 ? '' : 's'}`}
            . Open a row for its recorded history.
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * One governed object.
 *
 * The bar is share of the hard cap, with a tick where the owner's own soft
 * budget sits — a configured threshold is stronger evidence than the card's
 * derived 80% one, so it is drawn rather than described. An uncapped row draws
 * no bar at all: a full bar would read as spent-through and an empty one as
 * untouched, and it is neither.
 */
function BudgetLine({
  row,
  now,
  history,
  historySummary,
  open,
  onToggle,
}: {
  row: BudgetRow;
  now: Date;
  history: BudgetHistoryRow | null;
  historySummary: BudgetHistorySummary;
  open: boolean;
  onToggle: () => void;
}) {
  const { budget } = row;
  const badge = STATE_BADGE[row.state];
  const reset = resetLabel(budget, now);
  const adverse = row.state === 'blocked' || row.state === 'over' || row.state === 'soft';

  return (
    <>
    <div className={cx(styles.row, adverse && styles.rowFlagged, row.state === 'blocked' && styles.rowBlocked)}>
      <button
        type="button"
        className={cx(styles.name, styles.nameButton)}
        title={budget.key}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className={styles.key}>
          <span className={cx(styles.caret, open && styles.caretOpen)} aria-hidden="true">
            ›
          </span>
          {budget.label ?? budget.key}
        </span>
        {budget.label !== null && budget.label !== budget.key && (
          <span className={styles.sublabel}>{budget.key}</span>
        )}
        {history !== null && history.everOver && row.state !== 'over' && (
          <span className={styles.sublabel}>was over its cap on a recorded day</span>
        )}
      </button>

      <div className={styles.trackCell}>
        {row.utilization === null ? (
          <div className={styles.noTrack}>
            {row.blockReason === 'zero-cap' ? 'budgeted at $0 — every call rejected' : 'no budget cap'}
          </div>
        ) : (
          <div className={styles.track}>
            <div
              className={cx(
                styles.fill,
                row.state === 'over' || row.state === 'blocked'
                  ? styles.fillBad
                  : adverse || row.projectedOverrun
                    ? styles.fillWarn
                    : undefined,
              )}
              style={{ width: `${Math.min(100, row.utilization)}%` }}
            />
            {row.softMark !== null && (
              <div
                className={styles.softMark}
                style={{ left: `${row.softMark}%` }}
                title={`soft budget ${usd(budget.softBudget ?? 0)}`}
              />
            )}
          </div>
        )}
        {badge !== null && (
          <span className={cx(styles.badge, adverse ? styles.badgeBad : styles.badgeMuted)}>
            {badge}
          </span>
        )}
        {badge === null && row.projectedOverrun && (
          <span className={cx(styles.badge, styles.badgeWarn)}>pacing over</span>
        )}
      </div>

      <div className={styles.right}>
        {usd(budget.spend, 2)}
        <span className={styles.share}>
          {budget.maxBudget === null
            ? periodLabel(budget.budgetDuration)
            : `of ${usd(budget.maxBudget)} ${periodLabel(budget.budgetDuration)}`}
        </span>
        {/* The cap has a period; on this scope the counter measured against it
            does not. Saying so per row is the only place the two can be seen
            side by side. */}
        {row.spendIsCumulative && <span className={styles.share}>counted since created</span>}
      </div>

      <div className={cx(styles.right, row.remaining !== null && row.remaining < 0 && styles.bad)}>
        {row.remaining === null ? EMPTY : usd(row.remaining, 2)}
        <span className={styles.share}>
          {row.utilization === null ? 'no cap' : `${percent(row.utilization)} used`}
        </span>
      </div>

      <div className={cx(styles.right, row.projectedOverrun && styles.bad)}>
        {row.projectedSpend === null ? EMPTY : usd(row.projectedSpend, 0)}
        <span className={styles.share}>
          {row.projectedSpend === null
            ? row.spendIsCumulative
              ? 'counter never resets'
              : budget.budgetDuration === null
                ? 'no period'
                : 'too early to project'
            : (reset ?? 'by period end')}
        </span>
      </div>

      <div className={cx(styles.right, styles.muted)}>
        {budget.tpmLimit === null && budget.rpmLimit === null ? (
          EMPTY
        ) : (
          <>
            {budget.rpmLimit === null ? EMPTY : compactCount(budget.rpmLimit)}
            <span className={styles.share}>
              rpm{budget.tpmLimit !== null && ` · ${compactCount(budget.tpmLimit)} tpm`}
            </span>
          </>
        )}
      </div>
    </div>
    {open && <BudgetHistoryPanel row={history} summary={historySummary} />}
    </>
  );
}

/**
 * What this object's budget did while we were watching.
 *
 * Everything above the fold is current state, which is all the proxy has; this
 * is the dashboard's own record of previous readings, and it is careful about
 * three things the strip could easily imply and must not. An unobserved day is
 * drawn as a hole rather than as a flat continuation, because nobody looked. A
 * closed period's figure is labelled a floor, because the counter was read once
 * a day and the reset is on the proxy's clock. And a window that reaches before
 * recording started is simply shorter — there is no backfill for this and there
 * never will be, so an empty run of days would be a lie about coverage.
 */
function BudgetHistoryPanel({
  row,
  summary,
}: {
  row: BudgetHistoryRow | null;
  summary: BudgetHistorySummary;
}) {
  if (row === null) {
    return (
      <div className={styles.historyPanel}>
        <div className={styles.historyNote}>
          {summary.recordingSince === null
            ? 'No budget history recorded yet — the first sync after this release starts the record.'
            : 'Nothing recorded for this object: it appeared on the proxy after recording began, or the management routes did not report it.'}
        </div>
      </div>
    );
  }

  const closed = [...row.periods].reverse();

  return (
    <div className={styles.historyPanel}>
      <div className={styles.historyHead}>
        <span>
          {row.daysObserved} day{row.daysObserved === 1 ? '' : 's'} recorded
          {row.daysMissing > 0 && ` · ${row.daysMissing} not observed`}
          {' · '}
          {isoDateLabel(row.firstSeen)} – {isoDateLabel(row.lastSeen)}
        </span>
        <span className={styles.historyPeak}>
          peak {row.peakUtilization === null ? usd(row.peakSpend, 2) : percent(row.peakUtilization)}
          {row.peakUtilization === null && ' (uncapped)'}
        </span>
      </div>

      <div className={styles.strip} role="img" aria-label="Recorded share of cap, per day">
        {row.points.map((point) => {
          const height =
            point.utilization === null
              ? row.peakSpend > 0 && point.spend !== null
                ? (point.spend / row.peakSpend) * 100
                : 0
              : Math.min(100, point.utilization);
          return (
            <div
              key={point.date}
              className={cx(styles.stripCell, !point.observed && styles.stripMissing)}
              title={
                point.observed
                  ? `${point.date} · ${usd(point.spend ?? 0, 2)}${
                      point.utilization === null ? ' (uncapped)' : ` · ${percent(point.utilization)}`
                    }${point.reset ? ' · period reset' : ''}`
                  : `${point.date} · not observed`
              }
            >
              {point.observed && (
                <div
                  className={cx(
                    styles.stripFill,
                    point.utilization !== null && point.utilization >= 100 && styles.stripBad,
                  )}
                  style={{ height: `${Math.max(2, height)}%` }}
                />
              )}
              {point.reset && <div className={styles.stripReset} />}
            </div>
          );
        })}
      </div>

      {row.thin ? (
        <div className={styles.historyNote}>
          One reading so far. A budget only becomes a story from the second sync — until then this
          is the same snapshot as the row above.
        </div>
      ) : (
        <div className={styles.historyGrid}>
          <div>
            <div className={styles.historyLabel}>Recorded changes</div>
            {row.events.length === 0 ? (
              <div className={styles.historyNote}>
                Nothing moved: same cap, same limits, no reset and no crossing on every day
                observed.
              </div>
            ) : (
              <ul className={styles.eventList}>
                {[...row.events].reverse().map((item, index) => (
                  <li
                    key={`${item.date}:${item.kind}:${index}`}
                    className={cx(styles.eventItem, item.adverse && styles.eventAdverse)}
                  >
                    <span className={styles.eventDate}>{isoDateLabel(item.date)}</span>
                    <span>{eventText(item)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <div className={styles.historyLabel}>Closed periods</div>
            {closed.length === 0 ? (
              <div className={styles.historyNote}>
                The counter has not rolled while we were watching, so no period has closed inside
                the record.
              </div>
            ) : (
              <ul className={styles.eventList}>
                {closed.map((period) => (
                  <li key={`${period.from}:${period.to}`} className={styles.eventItem}>
                    <span className={styles.eventDate}>
                      {isoDateLabel(period.from)} – {isoDateLabel(period.to)}
                    </span>
                    <span className={cx(period.over && styles.bad)}>
                      at least {usd(period.observedTotal, 2)}
                      {period.maxBudget !== null && ` of ${usd(period.maxBudget)}`}
                      {!period.contiguous && ' · sampling gap across the reset'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className={styles.historyNote}>
              A closed period is a floor: the counter is read once a day, so whatever landed between
              the last reading and the reset is not in it.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** One recorded change, in words. The derivation carries numbers, not prose. */
function eventText(item: BudgetEvent): string {
  const money = (value: number | null): string => (value === null ? 'none' : usd(value, 2));
  switch (item.kind) {
    case 'gap':
      return `${item.to} day${item.to === 1 ? '' : 's'} not observed before this reading`;
    case 'reset':
      return `period reset — counter fell from ${money(item.from)} to ${money(item.to)}`;
    case 'cap':
      return item.to === null
        ? `cap removed (was ${money(item.from)})`
        : item.from === null
          ? `cap set to ${money(item.to)}`
          : `cap ${item.to > item.from ? 'raised' : 'lowered'} ${money(item.from)} → ${money(item.to)}`;
    case 'soft':
      return item.to === null
        ? `soft budget removed (was ${money(item.from)})`
        : `soft budget ${item.from === null ? 'set to' : '→'} ${money(item.to)}`;
    case 'limits':
      return `rate limits changed — ${item.note ?? ''}`;
    case 'renamed':
      return `renamed — ${item.note ?? ''}`;
    case 'blocked':
      return 'blocked — the proxy is rejecting its calls';
    case 'unblocked':
      return 'unblocked';
    case 'over':
      return `went over its cap${item.to === null ? '' : ` (${percent(item.to)})`}`;
    case 'soft-breach':
      return `passed its soft budget (${money(item.to)})`;
  }
}
