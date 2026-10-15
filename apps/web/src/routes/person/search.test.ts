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
});
