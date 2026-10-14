import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_KEY,
  nextThemeOverride,
  readThemeOverride,
  resolvedTheme,
  writeThemeOverride,
} from './theme';

describe('nextThemeOverride', () => {
  it('stores the opposite of the system theme', () => {
    expect(nextThemeOverride(null, 'light')).toBe('dark');
    expect(nextThemeOverride(null, 'dark')).toBe('light');
  });

  it('clears the override when toggling back to the system theme', () => {
    expect(nextThemeOverride('dark', 'light')).toBeNull();
    expect(nextThemeOverride('light', 'dark')).toBeNull();
  });

  it('keeps a pinned override that now matches the system and flips it', () => {
    // Stored dark while the OS later switched to dark: the user sees dark, wants light.
    expect(nextThemeOverride('dark', 'dark')).toBe('light');
  });
});

describe('resolvedTheme', () => {
  it('prefers the override', () => {
    expect(resolvedTheme('dark', 'light')).toBe('dark');
    expect(resolvedTheme(null, 'light')).toBe('light');
  });
});

describe('storage', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('round-trips the override and applies it to the root element', () => {
    writeThemeOverride('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(readThemeOverride()).toBe('dark');
    writeThemeOverride(null);
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(readThemeOverride()).toBeNull();
  });

  it('ignores invalid stored values', () => {
    localStorage.setItem(THEME_KEY, 'sepia');
    expect(readThemeOverride()).toBeNull();
  });

  it('still applies the theme when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    writeThemeOverride('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(readThemeOverride()).toBeNull();
  });
});
