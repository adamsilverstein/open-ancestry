import { describe, expect, it } from 'vitest';
import { TAG_COLORS, tagColor } from './tags';

describe('tagColor', () => {
  it('uses the stored palette color', () => {
    expect(tagColor({ id: 'x', color: 'tag-3' })).toBe(3);
  });

  it('falls back to a stable color from the id', () => {
    const a = tagColor({ id: '01JABC', color: null });
    expect(tagColor({ id: '01JABC', color: '#ff0000' })).toBe(a);
    expect(a).toBeGreaterThanOrEqual(1);
    expect(a).toBeLessThanOrEqual(8);
  });

  it('names all eight colors', () => {
    expect(TAG_COLORS.map((c) => c.color)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
