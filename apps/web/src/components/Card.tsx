import type { ReactNode } from 'react';
import { cx } from '../lib/cx.js';
import styles from './Card.module.css';

interface CardProps {
  children: ReactNode;
  /** Off for cards that manage their own padding, like the table. */
  padded?: boolean;
  /** Lays the card out as a column so a spacer can push a footer down. */
  column?: boolean;
  className?: string | undefined;
}

/** The Nocturne surface every panel on the page sits on. */
export function Card({ children, padded = true, column = false, className }: CardProps) {
  return (
    <div className={cx(styles.card, padded && styles.padded, column && styles.column, className)}>
      {children}
    </div>
  );
}
