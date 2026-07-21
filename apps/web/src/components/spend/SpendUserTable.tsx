import { count, EMPTY, usd } from '../../lib/format.js';
import type { SpendSortDirection, SpendSortKey, SpendUserRow } from '../../lib/metrics/spend.js';
import type { Page } from '../../lib/metrics/table.js';
import { Avatar } from '../Avatar.js';
import { Card } from '../Card.js';
import styles from './SpendUserTable.module.css';

/**
 * Per-user spend for the selected range. Identity comes from the JIRA join —
 * a login without one renders as itself with an "unmapped" badge, and its
 * money still counts in every total. Nulls render as `—`, never as blanks.
 */

interface SortableColumn {
  key: SpendSortKey;
  label: string;
}

const SORTABLE_COLUMNS: SortableColumn[] = [
  { key: 'credits', label: 'CREDITS' },
  { key: 'gross', label: 'GROSS' },
  { key: 'discount', label: 'DISCOUNT' },
  { key: 'net', label: 'NET' },
];

interface SpendUserTableProps {
  page: Page<SpendUserRow>;
  sortKey: SpendSortKey;
  sortDirection: SpendSortDirection;
  onSort: (key: SpendSortKey) => void;
  onPageChange: (page: number) => void;
}

export function SpendUserTable({
  page,
  sortKey,
  sortDirection,
  onSort,
  onPageChange,
}: SpendUserTableProps) {
  const arrowFor = (key: SpendSortKey): string => {
    if (key !== sortKey) return '';
    return sortDirection === -1 ? ' ▾' : ' ▴';
  };

  return (
    <Card padded={false} className={styles.card}>
      <div className={styles.header}>
        <div className={styles.title}>Per-user spend</div>
        <div className={styles.pageLabel}>{page.label}</div>
      </div>

      <div className={`${styles.columns} ${styles.headerStrip}`}>
        <div>USER</div>
        <div>DEPARTMENT</div>
        <div>B-1 MANAGER</div>
        <div>B-2 MANAGER</div>
        {SORTABLE_COLUMNS.map((column) => (
          <div key={column.key} className={styles.right}>
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
        <div className={styles.empty}>No spend matches these filters.</div>
      ) : (
        page.items.map((row) => (
          <div key={row.login} className={`${styles.columns} ${styles.row}`}>
            <div className={styles.user}>
              <Avatar name={row.displayName} login={row.login} size={28} fontSize={10} />
              <div className={styles.identity}>
                <div className={styles.name}>
                  {row.displayName}
                  {!row.mapped && <span className={styles.badge}>unmapped</span>}
                </div>
                <div className={styles.login}>{row.login}</div>
              </div>
            </div>
            <div className={styles.muted} title={row.department ?? undefined}>
              {row.department ?? EMPTY}
            </div>
            <div className={styles.muted} title={row.b1Manager ?? undefined}>
              {row.b1Manager ?? EMPTY}
            </div>
            <div className={styles.muted} title={row.b2Manager ?? undefined}>
              {row.b2Manager ?? EMPTY}
            </div>
            <div className={styles.right}>{count(Math.round(row.credits))}</div>
            <div className={`${styles.right} ${styles.money}`}>{usd(row.gross, 2)}</div>
            <div className={styles.right}>{usd(row.discount, 2)}</div>
            <div className={styles.right}>{usd(row.net, 2)}</div>
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
