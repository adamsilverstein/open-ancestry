import { describe, expect, it } from 'vitest';
import { substringFilter } from './filter';

describe('substringFilter', () => {
  it('matches case-insensitive substrings of value or keywords', () => {
    expect(substringFilter('Philadelphia, PA', 'phil')).toBe(1);
    expect(substringFilter('Toggle theme', 'dark', ['dark', 'light'])).toBe(1);
    expect(substringFilter('Boston, MA', 'phil')).toBe(0);
    expect(substringFilter('Boston, MA', '  ')).toBe(1);
  });
});
