import { useCallback, useSyncExternalStore } from 'react';
import {
  THEME_KEY,
  nextThemeOverride,
  readThemeOverride,
  resolvedTheme,
  writeThemeOverride,
  type Theme,
} from './theme';

const CHANGE = 'oa-theme-change';
const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

function subscribe(onChange: () => void) {
  const media = darkQuery();
  const onStorage = (event: StorageEvent) => {
    // Another tab changed the override: mirror it onto this document.
    if (event.key === THEME_KEY) writeThemeOverride(readThemeOverride());
    onChange();
  };
  media.addEventListener('change', onChange);
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE, onChange);
  return () => {
    media.removeEventListener('change', onChange);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGE, onChange);
  };
}

function snapshot(): string {
  const override = document.documentElement.dataset.theme ?? '';
  return `${override}|${darkQuery().matches ? 'dark' : 'light'}`;
}

export interface ThemeState {
  /** The scheme on screen. */
  theme: Theme;
  /** Stored override, or null when following the system. */
  override: Theme | null;
  system: Theme;
  toggle: () => void;
}

export function useTheme(): ThemeState {
  const value = useSyncExternalStore(subscribe, snapshot, () => '|light');
  const [rawOverride, rawSystem] = value.split('|');
  const override = rawOverride === 'light' || rawOverride === 'dark' ? rawOverride : null;
  const system: Theme = rawSystem === 'dark' ? 'dark' : 'light';
  const toggle = useCallback(() => {
    writeThemeOverride(nextThemeOverride(override, system));
    window.dispatchEvent(new Event(CHANGE));
  }, [override, system]);
  return { theme: resolvedTheme(override, system), override, system, toggle };
}
