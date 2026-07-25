import { count } from '../lib/format.js';
import styles from './TopBar.module.css';

interface TopBarProps {
  seatCount: number;
  isDark: boolean;
  /** True while any query refetches — the reload button reflects it. */
  isReloading: boolean;
  onToggleTheme: () => void;
  onExportCsv: () => void;
  onReload: () => void;
}

export function TopBar({
  seatCount,
  isDark,
  isReloading,
  onToggleTheme,
  onExportCsv,
  onReload,
}: TopBarProps) {
  return (
    <div className={styles.topBar}>
      <div>
        <h1 className={styles.title}>GitHub Copilot</h1>
        <div className={styles.subtitle}>
          Spend report · Acme Corp · {count(seatCount)} seats assigned
        </div>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.toggle}
          onClick={onToggleTheme}
          aria-pressed={isDark}
          aria-label="Toggle dark mode"
        >
          <span className={styles.toggleLabel}>{isDark ? 'Dark' : 'Light'}</span>
          <div className={styles.track}>
            <div className={`${styles.knob} ${isDark ? styles.knobDark : ''}`} />
          </div>
        </button>

        <button
          type="button"
          className={`${styles.button} ${styles.secondary}`}
          onClick={onReload}
          disabled={isReloading}
        >
          {isReloading ? 'Reloading…' : 'Reload'}
        </button>

        <button type="button" className={`${styles.button} ${styles.secondary}`} onClick={onExportCsv}>
          Export CSV
        </button>
      </div>
    </div>
  );
}
