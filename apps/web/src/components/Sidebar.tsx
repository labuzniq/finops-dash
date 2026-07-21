import {
  Brain,
  Cloud,
  Database,
  GithubLogo,
  Package,
  SquaresFour,
  TerminalWindow,
  UploadSimple,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import styles from './Sidebar.module.css';

/**
 * The FinOps console's nav. Copilot and Claude Code are the pages that exist
 * today; the rest are the shell this dashboard is page 1 of.
 *
 * The prototype drew geometric placeholders here and the handoff calls for
 * Phosphor in production — these are the Phosphor equivalents.
 */

/** The views the app can show; items without one are inert placeholders. */
export type AppView = 'copilot' | 'claude-code';

interface NavItem {
  label: string;
  icon: Icon;
  view?: AppView;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'OVERVIEW',
    items: [{ label: 'Dashboard', icon: SquaresFour }],
  },
  {
    label: 'SPEND',
    items: [
      { label: 'GitHub Copilot', icon: GithubLogo, view: 'copilot' },
      { label: 'Claude Code', icon: TerminalWindow, view: 'claude-code' },
      { label: 'Cloud infrastructure', icon: Cloud },
      { label: 'LLM APIs', icon: Brain },
      { label: 'SaaS licenses', icon: Package },
    ],
  },
  {
    label: 'DATA',
    items: [
      { label: 'Data sources', icon: Database },
      { label: 'Imports', icon: UploadSimple },
    ],
  },
];

const ICON_SIZE = 15;

interface SidebarProps {
  activeView: AppView;
  onNavigate: (view: AppView) => void;
}

export function Sidebar({ activeView, onNavigate }: SidebarProps) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <div className={styles.mark}>R</div>
        <div className={styles.brandName}>
          RBCZ <span className={styles.brandSuffix}>FinOps</span>
        </div>
      </div>

      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <div className={styles.groupLabel}>{group.label}</div>
          {group.items.map((item) => {
            const { view } = item;
            const active = view !== undefined && view === activeView;
            return (
              <button
                key={item.label}
                type="button"
                className={`${styles.item} ${active ? styles.itemActive : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={view === undefined ? undefined : () => onNavigate(view)}
              >
                <item.icon size={ICON_SIZE} weight={active ? 'fill' : 'regular'} />
                {item.label}
              </button>
            );
          })}
        </div>
      ))}

      <div className={styles.spacer} />

      <div className={styles.user}>
        <div className={styles.userAvatar}>FA</div>
        <div>
          <div className={styles.userName}>FinOps Administrátor</div>
          {/* <div className={styles.userRole}>admin</div> */}
        </div>
      </div>
    </aside>
  );
}
