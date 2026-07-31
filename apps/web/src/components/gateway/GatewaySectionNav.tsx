import type { GatewayNavEntry } from '../../lib/gatewaySections.js';
import styles from './GatewaySectionNav.module.css';

/**
 * The page's table of contents, and the heading each entry scrolls to.
 *
 * Both are driven by `deriveGatewayNav` over the page's own presence map, so a
 * chip can only name a section that drew something — see
 * `lib/gatewaySections.ts` for why a jump button pointing at a stood-down card
 * is worse than no button at all.
 *
 * The chip carries how many cards are in the section and nothing else. It is
 * deliberately not a count of findings: the digest directly under this nav is
 * the one place findings are counted, and a second count computed differently
 * would give the reader two answers to the same question.
 */

function scrollTo(anchor: string): void {
  document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function GatewaySectionNav({ entries }: { entries: readonly GatewayNavEntry[] }) {
  if (entries.length < 2) return null;

  return (
    <nav className={styles.nav} aria-label="Gateway sections">
      <span className={styles.label}>Jump to</span>
      {entries.map((entry) => (
        <button
          key={entry.section.id}
          type="button"
          className={styles.chip}
          onClick={() => scrollTo(entry.section.id)}
        >
          {entry.section.label}
          <span className={styles.chipCount}>{entry.cards.length}</span>
        </button>
      ))}
    </nav>
  );
}

interface GatewaySectionHeadingProps {
  entry: GatewayNavEntry | undefined;
}

/**
 * A section heading, rendered only when the section has something under it —
 * an entry the nav dropped is a heading over an empty stretch of page.
 */
export function GatewaySectionHeading({ entry }: GatewaySectionHeadingProps) {
  if (entry === undefined) return null;

  return (
    <div className={styles.heading} id={entry.section.id}>
      <div className={styles.headingRow}>
        <span className={styles.headingTitle}>{entry.section.label}</span>
        <span className={styles.headingCount}>
          {entry.cards.length} card{entry.cards.length === 1 ? '' : 's'}
          {entry.hidden > 0 ? ` · ${entry.hidden} not shown` : ''}
        </span>
      </div>
      <div className={styles.headingBlurb}>{entry.section.blurb}</div>
    </div>
  );
}
