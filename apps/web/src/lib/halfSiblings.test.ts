import { describe, expect, it } from 'vitest';
import { fixtureDetail } from './fixtureDetail.test-utils';
import { halfSiblings, parentIds } from './halfSiblings';

describe('halfSiblings', () => {
  const rowan = fixtureDetail('rowan');

  it('finds children of a parent’s other partnership', () => {
    const parents = parentIds(rowan).map((id) =>
      id === fixtureDetail('edmund').person.id ? fixtureDetail('edmund') : fixtureDetail('clara'),
    );
    expect(halfSiblings(rowan, parents).map((p) => p.given)).toEqual(['Nell']);
  });

  it('never repeats full siblings, the person or a half sibling', () => {
    const clara = fixtureDetail('clara');
    expect(halfSiblings(rowan, [clara, clara]).map((p) => p.given)).toEqual(['Nell']);
    expect(halfSiblings(fixtureDetail('nell'), [clara])).toEqual(
      expect.arrayContaining([expect.objectContaining({ given: 'Rowan' })]),
    );
  });
});
