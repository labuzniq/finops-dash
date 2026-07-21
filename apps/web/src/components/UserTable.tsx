import type { CopilotSeat } from '@dash/shared';
import { EMPTY, lastActiveLabel, optionalCount, optionalPercent } from '../lib/format.js';
import type { Page, SortDirection, SortKey } from '../lib/metrics/table.js';
import { Avatar } from './Avatar.js';
import { Card } from './Card.js';
import styles from './UserTable.module.css';

interface SortableColumn {
  key: SortKey;
  label: string;
}

const SORTABLE_COLUMNS: SortableColumn[] = [
  { key: 'premiumRequests', label: 'AI CREDITS' },
  { key: 'acceptance', label: 'ACCEPT' },
  { key: 'lastActive', label: 'LAST ACTIVE' },
];

/** Hover text spelling out the agent/chat flags next to the model. */
function modelTitle(seat: CopilotSeat): string | undefined {
  const flags: string[] = [];
  if (seat.usedAgent) flags.push('used agent mode');
  if (seat.usedChat) flags.push('used chat');
  return flags.length ? flags.join(' · ') : undefined;
}

interface UserTableProps {
  page: Page<CopilotSeat>;
  sortKey: SortKey;
  sortDirection: SortDirection;
  onSort: (key: SortKey) => void;
  onPageChange: (page: number) => void;
}

export function UserTable({ page, sortKey, sortDirection, onSort, onPageChange }: UserTableProps) {
  const arrowFor = (key: SortKey): string => {
    if (key !== sortKey) return '';
    return sortDirection === -1 ? ' ▾' : ' ▴';
  };

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div className={styles.title}>Per-user usage</div>
        <div className={styles.pageLabel}>{page.label}</div>
      </div>

      <div className={`${styles.columns} ${styles.headerStrip}`}>
        <div>USER</div>
        <div>PLAN</div>
        <div>EDITOR</div>
        <div>MODEL</div>
        {SORTABLE_COLUMNS.map((column) => (
          <div key={column.key}>
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

      {page.items.length === 0 ? (
        <div className={styles.empty}>No seats match these filters.</div>
      ) : (
        page.items.map((seat) => (
          <div key={seat.login} className={`${styles.columns} ${styles.row}`}>
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
          </div>
        ))
      )}

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
    </Card>
  );
}
