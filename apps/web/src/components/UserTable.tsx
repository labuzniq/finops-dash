import { seatPeriodCost } from '@dash/shared';
import type { CopilotSeat, RangeDays } from '@dash/shared';
import { EMPTY, lastActiveLabel, optionalCount, optionalPercent, usd } from '../lib/format.js';
import type { GroupBy, SeatGroup } from '../lib/metrics/group.js';
import type { Page, SortDirection, SortKey } from '../lib/metrics/table.js';
import { Avatar } from './Avatar.js';
import { Card } from './Card.js';
import styles from './UserTable.module.css';

interface SortableColumn {
  key: SortKey;
  label: string;
  alignRight?: boolean;
}

const SORTABLE_COLUMNS: SortableColumn[] = [
  { key: 'premiumRequests', label: 'AI CREDITS' },
  { key: 'acceptance', label: 'ACCEPT' },
  { key: 'lastActive', label: 'LAST ACTIVE' },
  { key: 'cost', label: 'COST', alignRight: true },
];

interface GroupOption {
  value: GroupBy;
  label: string;
}

/** The dimensions the table's detail can be grouped by. */
const GROUP_OPTIONS: GroupOption[] = [
  { value: 'none', label: 'None' },
  { value: 'model', label: 'Model' },
  { value: 'activity', label: 'Activity' },
  { value: 'editor', label: 'Editor' },
];

/** Hover text spelling out the agent/chat flags next to the model. */
function modelTitle(seat: CopilotSeat): string | undefined {
  const flags: string[] = [];
  if (seat.usedAgent) flags.push('used agent mode');
  if (seat.usedChat) flags.push('used chat');
  return flags.length ? flags.join(' · ') : undefined;
}

/** One seat's row — shared by the flat list and the grouped sections. */
function SeatRow({ seat, range }: { seat: CopilotSeat; range: RangeDays }) {
  return (
    <div className={`${styles.columns} ${styles.row}`}>
      <div className={styles.user}>
        <Avatar name={seat.name} login={seat.login} size={28} fontSize={10} />
        <div className={styles.identity}>
          <div className={styles.name}>{seat.name}</div>
          <div className={styles.login}>{seat.login}</div>
        </div>
      </div>
      <div>
        <span className={styles.plan}>{seat.plan}</span>
      </div>
      <div className={styles.muted}>{seat.editor ?? EMPTY}</div>
      <div className={styles.model} title={modelTitle(seat)}>
        {seat.topModel ?? EMPTY}
        {(seat.usedAgent || seat.usedChat) && (
          <span className={styles.tags}>
            {seat.usedAgent && <span className={styles.tag}>agent</span>}
            {seat.usedChat && <span className={styles.tag}>chat</span>}
          </span>
        )}
      </div>
      <div>{optionalCount(seat.premiumRequests28d)}</div>
      <div>{optionalPercent(seat.acceptanceRate)}</div>
      <div className={styles.muted}>{lastActiveLabel(seat.lastActivityDays)}</div>
      <div className={styles.cost}>{usd(seatPeriodCost(seat, range), 2)}</div>
    </div>
  );
}

interface UserTableProps {
  page: Page<CopilotSeat>;
  groups: SeatGroup[];
  groupBy: GroupBy;
  range: RangeDays;
  sortKey: SortKey;
  sortDirection: SortDirection;
  onSort: (key: SortKey) => void;
  onGroupByChange: (groupBy: GroupBy) => void;
  onPageChange: (page: number) => void;
}

export function UserTable({
  page,
  groups,
  groupBy,
  range,
  sortKey,
  sortDirection,
  onSort,
  onGroupByChange,
  onPageChange,
}: UserTableProps) {
  const arrowFor = (key: SortKey): string => {
    if (key !== sortKey) return '';
    return sortDirection === -1 ? ' ▾' : ' ▴';
  };

  const grouped = groupBy !== 'none';
  const seatTotal = grouped ? groups.reduce((sum, group) => sum + group.count, 0) : 0;
  // Grouping shows every seat at once, so the flat pager's "13–24 of N" gives way to a plain count.
  const summaryLabel = grouped
    ? `${seatTotal.toLocaleString('en-US')} ${seatTotal === 1 ? 'seat' : 'seats'} · ${groups.length} groups`
    : page.label;

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div className={styles.title}>Per-user usage &amp; cost</div>
        <div className={styles.pageLabel}>{summaryLabel}</div>
      </div>

      <div className={styles.groupBar}>
        <span className={styles.groupBarLabel}>Group by</span>
        <div className={styles.groupToggle} role="group" aria-label="Group table by">
          {GROUP_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${styles.groupSegment} ${
                groupBy === option.value ? styles.groupSegmentActive : ''
              }`}
              aria-pressed={groupBy === option.value}
              onClick={() => onGroupByChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className={`${styles.columns} ${styles.headerStrip}`}>
        <div>USER</div>
        <div>PLAN</div>
        <div>EDITOR</div>
        <div>MODEL</div>
        {SORTABLE_COLUMNS.map((column) => (
          <div key={column.key} className={column.alignRight ? styles.right : undefined}>
            <button
              type="button"
              className={styles.sortButton}
              onClick={() => onSort(column.key)}
              aria-label={`Sort by ${column.label.toLowerCase()}`}
            >
              {column.label}
              {arrowFor(column.key)}
            </button>
          </div>
        ))}
      </div>

      {grouped ? (
        groups.length === 0 ? (
          <div className={styles.empty}>No seats match these filters.</div>
        ) : (
          groups.map((group) => (
            <div key={group.key}>
              <div className={styles.groupHeader}>
                <span className={styles.groupHeaderLabel}>{group.label}</span>
                <span className={styles.groupHeaderMeta}>
                  {group.count} {group.count === 1 ? 'seat' : 'seats'} · {usd(group.totalCost, 2)}
                </span>
              </div>
              {group.seats.map((seat) => (
                <SeatRow key={seat.login} seat={seat} range={range} />
              ))}
            </div>
          ))
        )
      ) : page.items.length === 0 ? (
        <div className={styles.empty}>No seats match these filters.</div>
      ) : (
        page.items.map((seat) => <SeatRow key={seat.login} seat={seat} range={range} />)
      )}

      {!grouped && (
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.pageButton}
            disabled={page.index === 0}
            onClick={() => onPageChange(page.index - 1)}
          >
            ← Prev
          </button>
          <button
            type="button"
            className={styles.pageButton}
            disabled={page.index >= page.count - 1}
            onClick={() => onPageChange(page.index + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </Card>
  );
}
