import { describe, expect, it } from 'vitest';
import { validateMergeSearch } from './search';

describe('validateMergeSearch', () => {
  it('keeps person ids', () => {
    expect(validateMergeSearch({ keep: 'p1', other: 'p2' })).toEqual({ keep: 'p1', other: 'p2' });
  });

  it('overwrites invalid ids when merged over the raw search (#146)', () => {
    const raw = { keep: '../x', other: 'a b' };
    const merged = { ...raw, ...validateMergeSearch(raw) };
    expect(merged.keep).toBeUndefined();
    expect(merged.other).toBeUndefined();
  });
});
