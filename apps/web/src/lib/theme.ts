export type Theme = 'light' | 'dark';

/** localStorage key; also read by public/theme-init.js before first paint. */
export const THEME_KEY = 'oa-theme';

export function readThemeOverride(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/** Applies the override to `<html data-theme>` and persists it when storage allows. */
export function writeThemeOverride(theme: Theme | null): void {
  const root = document.documentElement;
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
  try {
    if (theme) localStorage.setItem(THEME_KEY, theme);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    // Storage blocked: the theme still applies for this page view.
  }
}

export function resolvedTheme(override: Theme | null, system: Theme): Theme {
  return override ?? system;
}

/**
 * Two-state toggle: flip what the user currently sees. Landing on the system
 * theme clears the override so the app follows the OS again.
 */
export function nextThemeOverride(override: Theme | null, system: Theme): Theme | null {
  const target: Theme = resolvedTheme(override, system) === 'dark' ? 'light' : 'dark';
  return target === system ? null : target;
}
