import { useEffect, useState } from 'react';

/**
 * Light or dark. index.html sets `data-theme` on <html> before the first paint, from the saved choice or, without one,
 * from the system setting; this hook reads that value and keeps the visitor's choice on this device.
 */
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'zkdb.theme';

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

const saved = (): Theme | null => {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
};

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  // Without a saved choice, follow the system when it switches.
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => { if (!saved()) setTheme(e.matches ? 'dark' : 'light'); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private window: the choice lasts for this page only.
    }
  };
  return [theme, toggle];
}
