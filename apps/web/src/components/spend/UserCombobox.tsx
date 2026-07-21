import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SpendPerson } from '@dash/shared';
import { cx } from '../../lib/cx.js';
import styles from './UserCombobox.module.css';

/**
 * The user filter of the spend section: a searchable single-select over the
 * roster. A native `<select>` over ~1,000 people is unusable, so this is the
 * ARIA combobox pattern — type to narrow by display name or login, arrow keys
 * to move, Enter to pick.
 *
 * It owns nothing but its own UI state; the selection lives in
 * `SpendFilters.login`, exactly as the select it replaced.
 */

/** Rendered rows per query. The roster is ~1,000 — painting it all is waste. */
const MAX_VISIBLE = 50;

interface UserComboboxProps {
  /** Candidates, already narrowed by the other active filters. */
  people: readonly SpendPerson[];
  /** The selected login, or null for everyone. */
  value: string | null;
  onChange: (login: string | null) => void;
}

/** Unmapped people have no display name, so the login stands alone. */
function label(person: SpendPerson): string {
  return person.mapped ? `${person.displayName} (${person.login})` : person.login;
}

/**
 * Case-insensitive substring match over display name and login, with prefix
 * matches first — typing "mar" should surface "Marta" above "Rosemary".
 */
function search(people: readonly SpendPerson[], query: string): SpendPerson[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...people];

  const prefix: SpendPerson[] = [];
  const contains: SpendPerson[] = [];
  for (const person of people) {
    const name = person.displayName.toLowerCase();
    const login = person.login.toLowerCase();
    if (name.startsWith(needle) || login.startsWith(needle)) prefix.push(person);
    else if (name.includes(needle) || login.includes(needle)) contains.push(person);
  }
  return [...prefix, ...contains];
}

export function UserCombobox({ people, value, onChange }: UserComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const sorted = useMemo(
    () =>
      [...people].sort(
        (a, b) => a.displayName.localeCompare(b.displayName) || a.login.localeCompare(b.login),
      ),
    [people],
  );
  const matches = useMemo(() => search(sorted, query), [sorted, query]);
  const visible = matches.slice(0, MAX_VISIBLE);
  const hidden = matches.length - visible.length;

  const selected = useMemo(
    () => (value === null ? null : (people.find((person) => person.login === value) ?? null)),
    [people, value],
  );

  // Close on Escape or a click outside; both revert the in-flight query so the
  // input never shows a search that was abandoned.
  useEffect(() => {
    if (!open) return;

    const close = () => {
      setOpen(false);
      setQuery('');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        inputRef.current?.blur();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const select = (person: SpendPerson) => {
    onChange(person.login);
    setOpen(false);
    setQuery('');
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => {
        if (visible.length === 0) return 0;
        return (index + delta + visible.length) % visible.length;
      });
      return;
    }
    if (event.key === 'Enter') {
      const person = visible[activeIndex];
      if (open && person) {
        event.preventDefault();
        select(person);
      }
      return;
    }
    if (event.key === 'Tab') setOpen(false);
  };

  // Closed, the input reads as the current selection; open, it is the query.
  const inputValue = open ? query : (selected === null ? '' : label(selected));

  return (
    <div ref={rootRef} className={styles.root}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        className={styles.input}
        aria-label="Filter by user"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && visible[activeIndex] ? `${listId}-${visible[activeIndex].login}` : undefined
        }
        placeholder="All users"
        value={inputValue}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onFocus={() => {
          setQuery('');
          setActiveIndex(0);
          setOpen(true);
        }}
        onKeyDown={onInputKeyDown}
      />

      {value !== null && !open && (
        <button
          type="button"
          className={styles.clear}
          aria-label="Clear user filter"
          onClick={() => onChange(null)}
        >
          ×
        </button>
      )}

      {open && (
        <ul id={listId} role="listbox" className={styles.list} aria-label="Users">
          {visible.length === 0 && <li className={styles.empty}>No users match “{query.trim()}”</li>}
          {visible.map((person, index) => (
            <li
              key={person.login}
              id={`${listId}-${person.login}`}
              role="option"
              aria-selected={person.login === value}
              className={cx(styles.option, index === activeIndex && styles.optionActive)}
              onMouseEnter={() => setActiveIndex(index)}
              // pointerdown, not click: the outside-click listener fires first otherwise.
              onPointerDown={(event) => {
                event.preventDefault();
                select(person);
              }}
            >
              {label(person)}
            </li>
          ))}
          {hidden > 0 && <li className={styles.more}>{hidden} more — keep typing</li>}
        </ul>
      )}
    </div>
  );
}
