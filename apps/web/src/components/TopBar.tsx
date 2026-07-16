import { count } from '../lib/format.js';
import styles from './TopBar.module.css';

interface TopBarProps {
  seatCount: number;
  isDark: boolean;
  onToggleTheme: () => void;
  onAddData: () => void;
  onExportCsv: () => void;
}

export function TopBar({ seatCount, isDark, onToggleTheme, onAddData, onExportCsv }: TopBarProps) {
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

        <button type="button" className={`${styles.button} ${styles.secondary}`} onClick={onExportCsv}>
          Export CSV
        </button>

        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={onAddData}>
          + Add data
        </button>
      </div>
    </div>
  );
}
