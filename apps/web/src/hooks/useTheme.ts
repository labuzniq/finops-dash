import { useCallback, useEffect, useState } from 'react';

/** Nocturne is a dark system — dark is the native default. */
const STORAGE_KEY = 'dash.theme';

export type Theme = 'dark' | 'light';

function readStoredTheme(): Theme {
  return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
}

export interface UseTheme {
  theme: Theme;
  isDark: boolean;
  toggle: () => void;
}

export function useTheme(): UseTheme {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, theme);
    // The page background sits on <body>, outside the themed shell.
    document.body.style.background = theme === 'dark' ? '#161826' : '#f3f5fe';
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, isDark: theme === 'dark', toggle };
}
