import { describe, expect, it } from 'vitest';
import { actionFilter, substringFilter } from './filter';

describe('substringFilter', () => {
  it('matches case-insensitive substrings of value or keywords', () => {
    expect(substringFilter('Philadelphia, PA', 'phil')).toBe(1);
    expect(substringFilter('Toggle theme', 'dark', ['dark', 'light'])).toBe(1);
    expect(substringFilter('Boston, MA', 'phil')).toBe(0);
    expect(substringFilter('Boston, MA', '  ')).toBe(1);
  });
});

describe('actionFilter', () => {
  const theme = ['Switch to dark theme', ['theme', 'dark', 'light', 'appearance']] as const;
  it('matches the start of the label or a whole keyword', () => {
    expect(actionFilter(theme[0], 'swi', [...theme[1]])).toBe(0.5);
    expect(actionFilter(theme[0], 'Switch to  d', [...theme[1]])).toBe(0.5);
    expect(actionFilter(theme[0], 'dark', [...theme[1]])).toBe(0.5);
    expect(actionFilter(theme[0], 'theme', [...theme[1]])).toBe(0.5);
    expect(actionFilter('Open design system', 'kitchen sink', ['kitchen sink'])).toBe(0.5);
    expect(actionFilter(theme[0], '', [])).toBe(0.5);
  });

  it('ignores words inside the label and partial keywords', () => {
    expect(actionFilter(theme[0], 'the', [...theme[1]])).toBe(0);
    expect(actionFilter(theme[0], 'dar', [...theme[1]])).toBe(0);
    expect(actionFilter('Go to start page', 'start')).toBe(0);
  });

  it('scores below people results', () => {
    expect(actionFilter('Open people list', 'open')).toBeLessThan(1);
  });
});
