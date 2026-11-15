import { useCallback, useState } from 'react';

export type UiTheme = 'dark' | 'light';

const STORAGE_KEY = 'waystation-ui-theme';
const THEME_COLOR: Record<UiTheme, string> = { dark: '#0a0a0b', light: '#fafafa' };

/** The saved choice, or dark: Waystation is dark unless the operator asks otherwise. */
export function savedUiTheme(): UiTheme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** Applies a theme to the document root (and the browser chrome color). */
export function applyUiTheme(theme: UiTheme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

export function useUiTheme(): { readonly theme: UiTheme; readonly toggle: () => void } {
  const [theme, setTheme] = useState<UiTheme>(savedUiTheme);
  const toggle = useCallback(() => {
    setTheme(current => {
      const next: UiTheme = current === 'dark' ? 'light' : 'dark';
      applyUiTheme(next);
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* The choice still applies for this visit. */ }
      return next;
    });
  }, []);
  return { theme, toggle };
}
