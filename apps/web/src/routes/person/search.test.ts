import { describe, expect, it } from 'vitest';
import { validatePersonSearch } from './search';

describe('validatePersonSearch', () => {
  it('keeps a known tab and drops facts, the default', () => {
    expect(validatePersonSearch({ tab: 'gallery' }).tab).toBe('gallery');
    expect(validatePersonSearch({ tab: 'facts' }).tab).toBeUndefined();
  });

  it('overwrites an invalid tab when merged over the raw search (#146)', () => {
    const raw = { tab: 'toString' };
    expect({ ...raw, ...validatePersonSearch(raw) }.tab).toBeUndefined();
  });

  it('keeps the tree a person belongs to, and drops an empty one', () => {
    expect(validatePersonSearch({ tree: 'Vale family' }).tree).toBe('Vale family');
    expect(validatePersonSearch({ tree: '' }).tree).toBeUndefined();
    expect(validatePersonSearch({}).tree).toBeUndefined();
  });

  it('sets tree to undefined for a value that is not a string', () => {
    // Every key is set, so the router's merge cannot let the raw value through.
    for (const tree of [42, true, null, ['Vale'], { name: 'Vale' }]) {
      const result = validatePersonSearch({ tree });
      expect(result).toHaveProperty('tree', undefined);
      expect({ tree, ...result }.tree).toBeUndefined();
    }
  });

  it('keeps tree when merged into other search params', () => {
    const raw = { tab: 'sources', tree: 'Vale family', edit: 'true', other: 'x' };
    expect({ ...raw, ...validatePersonSearch(raw) }).toEqual({
      tab: 'sources',
      tree: 'Vale family',
      edit: true,
      other: 'x',
    });
  });
});
