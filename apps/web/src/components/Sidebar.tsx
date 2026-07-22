import { useState } from 'react';
import {
  Brain,
  CaretDown,
  CaretRight,
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
export type AppView = 'copilot-spend' | 'copilot-analytics' | 'claude-code';

interface NavChild {
  label: string;
  view: AppView;
}

interface NavItem {
  label: string;
  icon: Icon;
  view?: AppView;
  /** A parent with children collapses on click instead of navigating. */
  children?: NavChild[];
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
      {
        label: 'GitHub Copilot',
        icon: GithubLogo,
        children: [
          { label: 'Spend', view: 'copilot-spend' },
          { label: 'Analytics', view: 'copilot-analytics' },
        ],
      },
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
const CHEVRON_SIZE = 11;

interface SidebarProps {
  activeView: AppView;
  onNavigate: (view: AppView) => void;
}

export function Sidebar({ activeView, onNavigate }: SidebarProps) {
  // Labels of parents the user has closed; everything starts expanded.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const toggleCollapsed = (label: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

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
            if (item.children !== undefined) {
              const open = !collapsed.has(item.label);
              const childActive = item.children.some((child) => child.view === activeView);
              return (
                <div key={item.label}>
                  <button
                    type="button"
                    className={styles.item}
                    aria-expanded={open}
                    onClick={() => toggleCollapsed(item.label)}
                  >
                    <item.icon size={ICON_SIZE} weight={childActive ? 'fill' : 'regular'} />
                    {item.label}
                    {open ? (
                      <CaretDown size={CHEVRON_SIZE} className={styles.chevron} />
                    ) : (
                      <CaretRight size={CHEVRON_SIZE} className={styles.chevron} />
                    )}
                  </button>
                  {open &&
                    item.children.map((child) => {
                      const active = child.view === activeView;
                      return (
                        <button
                          key={child.label}
                          type="button"
                          className={`${styles.item} ${styles.child} ${active ? styles.itemActive : ''}`}
                          aria-current={active ? 'page' : undefined}
                          onClick={() => onNavigate(child.view)}
                        >
                          {child.label}
                        </button>
                      );
                    })}
                </div>
              );
            }

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
