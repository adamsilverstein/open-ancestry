import { describe, expect, it } from 'vitest';
import { peopleQueryString } from '../../api/search';
import { toPeopleParams, validatePeopleSearch } from './search';

describe('validatePeopleSearch', () => {
  it('keeps valid params and drops defaults and junk', () => {
    expect(
      validatePeopleSearch({ sort: 'birth', dir: 'desc', sex: 'F', living: 'deceased', tag: 'T1' }),
    ).toEqual({ sort: 'birth', dir: 'desc', sex: 'F', living: 'deceased', tag: 'T1' });
    expect(validatePeopleSearch({ sort: 'surname', dir: 'asc' })).toEqual({});
    expect(
      validatePeopleSearch({ sort: 'age', dir: 'up', sex: 'Q', living: 'maybe', tag: '../x' }),
    ).toEqual({});
    expect(validatePeopleSearch({ tag: 5 })).toEqual({});
  });
});

describe('peopleQueryString', () => {
  it('pages and maps living filters to statuses', () => {
    const params = toPeopleParams({ sort: 'given', living: 'living', sex: 'M', tag: 'T1' });
    const q = new URLSearchParams(peopleQueryString(params, 3));
    expect(Object.fromEntries(q)).toEqual({
      sort: 'given',
      dir: 'asc',
      limit: '100',
      offset: '300',
      sex: 'M',
      living: 'living,inferred_living,unknown',
      tag: 'T1',
    });
    const deceased = toPeopleParams({ living: 'deceased' });
    expect(new URLSearchParams(peopleQueryString(deceased, 0)).get('living')).toBe(
      'dead,inferred_dead',
    );
    expect(peopleQueryString(toPeopleParams({}), 0)).toBe(
      'sort=surname&dir=asc&limit=100&offset=0',
    );
  });
});

describe('validatePeopleSearch over the raw search (#146)', () => {
  // TanStack Router merges a route's validated search over the raw one, so
  // the validator must overwrite every key it owns, even when invalid.
  it('leaves nothing invalid behind', () => {
    const raw = { sort: 'evil', limit: '-5', dir: 'sideways', sex: 'Q', living: 'x', tag: '../t' };
    const merged = { ...raw, ...validatePeopleSearch(raw) };
    for (const key of Object.keys(raw))
      expect(merged[key as keyof typeof merged], key).toBeUndefined();
  });
});
