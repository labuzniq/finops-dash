import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { cx } from '../../lib/cx.js';
import styles from './FilterCombobox.module.css';

/**
 * The spend section's searchable single-select, shared by every org-structure
 * filter — user, department, B-1 and B-2 manager. A native `<select>` over a
 * long roster is unusable, so this is the ARIA combobox pattern — type to
 * narrow, arrow keys to move, Enter to pick.
 *
 * It owns nothing but its own UI state; the selection lives in `SpendFilters`,
 * exactly as the selects it replaced.
 */

/** Rendered rows per query. The roster is ~1,000 — painting it all is waste. */
const MAX_VISIBLE = 50;

export interface FilterOption {
  value: string;
  label: string;
  /** Extra strings the search matches besides the label (e.g. a login). */
  keywords?: readonly string[];
}

interface FilterComboboxProps {
  /** Candidates, already narrowed and sorted by the caller. */
  options: readonly FilterOption[];
  /** The selected value, or null for "all". */
  value: string | null;
  onChange: (value: string | null) => void;
  /** Singular noun ("user", "department", "B-1 manager") — all the visible and
   * ARIA copy derives from it, so every filter phrases itself the same way. */
  noun: string;
}

/**
 * Case-insensitive substring match over label and keywords, with prefix
 * matches first — typing "mar" should surface "Marta" above "Rosemary".
 */
function search(options: readonly FilterOption[], query: string): FilterOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...options];

  const prefix: FilterOption[] = [];
  const contains: FilterOption[] = [];
  for (const option of options) {
    const haystacks = [option.label, ...(option.keywords ?? [])].map((s) => s.toLowerCase());
    if (haystacks.some((s) => s.startsWith(needle))) prefix.push(option);
    else if (haystacks.some((s) => s.includes(needle))) contains.push(option);
  }
  return [...prefix, ...contains];
}

export function FilterCombobox({ options, value, onChange, noun }: FilterComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const plural = `${noun}s`;
  const matches = useMemo(() => search(options, query), [options, query]);
  const visible = matches.slice(0, MAX_VISIBLE);
  const hidden = matches.length - visible.length;

  const selected = useMemo(
    () => (value === null ? null : (options.find((option) => option.value === value) ?? null)),
    [options, value],
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

  const select = (option: FilterOption) => {
    onChange(option.value);
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
      const option = visible[activeIndex];
      if (open && option) {
        event.preventDefault();
        select(option);
      }
      return;
    }
    if (event.key === 'Tab') setOpen(false);
  };

  // Closed, the input reads as the current selection; open, it is the query.
  const inputValue = open ? query : (selected === null ? '' : selected.label);

  return (
    <div ref={rootRef} className={styles.root}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        className={styles.input}
        aria-label={`Filter by ${noun}`}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && visible[activeIndex] ? `${listId}-${visible[activeIndex].value}` : undefined
        }
        placeholder={`All ${plural}`}
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
          aria-label={`Clear ${noun} filter`}
          onClick={() => onChange(null)}
        >
          ×
        </button>
      )}

      {open && (
        <ul
          id={listId}
          role="listbox"
          className={styles.list}
          aria-label={plural.charAt(0).toUpperCase() + plural.slice(1)}
        >
          {visible.length === 0 && (
            <li className={styles.empty}>
              No {plural} match “{query.trim()}”
            </li>
          )}
          {visible.map((option, index) => (
            <li
              key={option.value}
              id={`${listId}-${option.value}`}
              role="option"
              aria-selected={option.value === value}
              className={cx(styles.option, index === activeIndex && styles.optionActive)}
              onMouseEnter={() => setActiveIndex(index)}
              // pointerdown, not click: the outside-click listener fires first otherwise.
              onPointerDown={(event) => {
                event.preventDefault();
                select(option);
              }}
            >
              {option.label}
            </li>
          ))}
          {hidden > 0 && <li className={styles.more}>{hidden} more — keep typing</li>}
        </ul>
      )}
    </div>
  );
}
