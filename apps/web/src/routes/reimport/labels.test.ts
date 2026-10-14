import { describe, expect, it } from 'vitest';
import { changeText, describeChange, factText } from './labels';
import type { ReviewChange } from './api';

const fact = (date: string | null, place: string | null = 'Elderford') => ({
  type: 'BIRT',
  customType: null,
  date,
  place,
  value: null,
});
const base = { id: 'c1', defaultAccept: true, applicable: true };

describe('re-import labels', () => {
  it('names only what changed', () => {
    expect(changeText(fact('Abt. 1842'), fact('12 MAR 1842'))).toBe(
      'Birth: Abt. 1842 → 12 MAR 1842',
    );
    expect(changeText(fact('1842', 'A'), fact('1843', 'B'))).toBe('Birth: 1842, A → 1843, B');
    expect(changeText(fact('1842', null), fact('1842', 'B'))).toBe('Birth: (none) → B');
    expect(
      factText({ type: 'EVEN', customType: 'Arrival', date: '1866', place: null, value: null }),
    ).toBe('Arrival, 1866');
  });

  it('describes every kind of change', () => {
    const cases: [ReviewChange, string][] = [
      [{ ...base, kind: 'person.new', incomingId: 'x' }, 'Add Noah Ashgrove'],
      [{ ...base, kind: 'sex', before: 'U', after: 'F' }, 'Sex: unknown → female'],
      [
        { ...base, kind: 'name.add', name: 'Pete Ashgrove', nameType: 'aka' },
        'Add name: Pete Ashgrove (also known as)',
      ],
      [
        { ...base, kind: 'fact.add', fact: fact('1900'), owner: 'person' },
        'Add fact: Birth, 1900, Elderford',
      ],
      [
        { ...base, kind: 'fact.add', fact: { ...fact('1919'), type: 'MARR' }, owner: 'family' },
        'Add family fact: Marriage, 1919, Elderford',
      ],
      [
        { ...base, kind: 'fact.missing', fact: fact('1900') },
        'Not in the new export: Birth, 1900, Elderford',
      ],
      [
        { ...base, kind: 'citation.add', source: 'Census', page: 'p. 4', apid: null },
        'Add source: Census, p. 4',
      ],
      [{ ...base, kind: 'tag.add', tag: 'Research: Done' }, 'Add tag: Research: Done'],
      [{ ...base, kind: 'media.add', title: null }, 'Add media: untitled'],
      [
        { ...base, kind: 'family.add', partnerNames: ['Noah Ashgrove', 'Ivy Fen'] },
        'Partner: Ivy Fen',
      ],
      [{ ...base, kind: 'child.add', parentNames: ['A', 'B', 'C'] }, 'Child of A, B and C'],
      [{ ...base, kind: 'child.add', parentNames: [] }, 'Child of unknown'],
      [{ ...base, kind: 'person.missing' }, 'Not in the new export'],
      [
        { ...base, kind: 'family.missing', partnerNames: ['Noah Ashgrove', 'Ivy Fen'] },
        'Not in the new export: partner Ivy Fen. Kept in your tree.',
      ],
      [
        { ...base, kind: 'child.missing', parentNames: ['Ada Fen', 'Ivo Fen'] },
        'Not in the new export: child of Ada Fen and Ivo Fen. Kept in your tree.',
      ],
      [
        { ...base, kind: 'deleted-here' },
        'You deleted Noah Ashgrove from this tree; not added back unless you tick it',
      ],
      [
        { ...base, kind: 'possibly-merged', existingName: 'Josiah Ashgrove' },
        'Possibly merged into Josiah Ashgrove earlier (shares a relative); not added unless you tick it',
      ],
      [
        { ...base, kind: 'possible-match', existingName: 'Edith Ashgrove' },
        'Looks like Edith Ashgrove, who is already matched; not added unless you tick it',
      ],
      [
        { ...base, kind: 'merged', incomingName: 'Thad Ashgrove' },
        'Exported separately as Thad Ashgrove; previously merged into Noah Ashgrove, so not added again',
      ],
    ];
    for (const [change, text] of cases) expect(describeChange(change, 'Noah Ashgrove')).toBe(text);
  });
});
