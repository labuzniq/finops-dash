import { GATEWAY_BUDGET_SCOPE_LABELS, parseBudgetDuration } from '@dash/shared';
import type { GatewayBudget, GatewayBudgetScope } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import { compactCount, EMPTY, percent, usd } from '../../lib/format.js';
import type { BudgetRow, BudgetScopeSummary } from '../../lib/metrics/gatewayBudgets.js';
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

export function GatewayBudgetCard({ scopes, scope, onScope, loaded }: GatewayBudgetCardProps) {
  const now = new Date();
  const active = scopes.find((candidate) => candidate.scope === scope) ?? scopes[0];

  if (!loaded) return null;

  if (active === undefined) {
    return (
      <Card padded={false} className={styles.card}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>Budgets and limits</div>
            <div className={styles.sub}>
              what the proxy will stop · one row per key and per team, replaced on every sync
            </div>
          </div>
        </div>
        <div className={styles.empty}>
          The proxy reported no budgets. LiteLLM&apos;s <code>/key/list</code> and{' '}
          <code>/team/list</code> are management routes — an analytics-only credential is refused
          them, and a refusal and a genuinely ungoverned gateway look identical from here.
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
            LiteLLM&apos;s own enforced counter for the period in flight · each row is measured over
            its own period, so nothing here totals
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

      {active.rows.map((row) => (
        <BudgetLine key={`${row.budget.scope}:${row.budget.key}`} row={row} now={now} />
      ))}

      <div className={styles.footer}>
        {active.capped} of {active.total} {label}
        {active.total === 1 ? '' : 's'} capped
        {active.uncapped > 0 && ` · ${active.uncapped} uncapped`}
        {active.rateLimited > 0 && ` · ${active.rateLimited} rate-limited`}
        {active.projectedOverrun > 0 &&
          ` · ${active.projectedOverrun} pacing past the cap before it resets`}
        . Caps set over different periods are never added together — a weekly budget and a monthly
        one do not share a unit.
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
function BudgetLine({ row, now }: { row: BudgetRow; now: Date }) {
  const { budget } = row;
  const badge = STATE_BADGE[row.state];
  const reset = resetLabel(budget, now);
  const adverse = row.state === 'blocked' || row.state === 'over' || row.state === 'soft';

  return (
    <div className={cx(styles.row, adverse && styles.rowFlagged, row.state === 'blocked' && styles.rowBlocked)}>
      <div className={styles.name} title={budget.key}>
        <span className={styles.key}>{budget.label ?? budget.key}</span>
        {budget.label !== null && budget.label !== budget.key && (
          <span className={styles.sublabel}>{budget.key}</span>
        )}
      </div>

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
            ? budget.budgetDuration === null
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
  );
}
