import { describe, expect, it } from 'vitest';
import {
  changeText,
  compareProgress,
  conflictText,
  describeChange,
  factText,
  placeRenameText,
} from './labels';
import type { ReviewChange } from './api';

const fact = (date: string | null, place: string | null = 'Elderford') => ({
  type: 'BIRT',
  customType: null,
  date,
  place,
  value: null,
});
const base = { id: 'c1', key: 'k1', defaultAccept: true, applicable: true };
/** A label without its isolates, for the wording tests (isolation has its own test). */
const plain = (text: string | undefined) => text?.replace(/[\u2068\u2069]/g, '');

describe('re-import labels', () => {
  it('names only what changed', () => {
    // Dates read the way the rest of the app shows them, not as raw GEDCOM.
    expect(plain(changeText(fact('Abt. 1842'), fact('12 MAR 1842')))).toBe(
      'Birth: abt. 1842 → 12 Mar 1842',
    );
    expect(plain(factText(fact('03/15/1828', null)))).toBe('Birth, 15 Mar 1828');
    // Different texts for the same date: show them as written rather than "x → x".
    expect(plain(changeText(fact('BET 1850 AND 1860'), fact('1850-1860')))).toBe(
      'Birth: BET 1850 AND 1860 → 1850-1860',
    );
    expect(plain(changeText(fact('1842', 'A'), fact('1843', 'B')))).toBe(
      'Birth: 1842, A → 1843, B',
    );
    expect(plain(changeText(fact('1842', null), fact('1842', 'B')))).toBe('Birth: (none) → B');
    expect(
      plain(
        factText({ type: 'EVEN', customType: 'Arrival', date: '1866', place: null, value: null }),
      ),
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
      [{ ...base, kind: 'media.file', title: 'Portrait' }, 'Add the file for Portrait'],
      [{ ...base, kind: 'media.replace', title: 'Letter' }, "Use the new export's file for Letter"],
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
        { ...base, kind: 'unlinked-new' },
        'New child of a partnership not in this tree; tick to add',
      ],
      [
        {
          ...base,
          kind: 'possible-match',
          existingName: 'Edith Ashgrove',
          confidence: 0.91,
          taken: true,
        },
        'Looks like Edith Ashgrove (91%), who is already matched; not added unless you tick it',
      ],
      [
        {
          ...base,
          kind: 'possible-match',
          existingName: 'Mary Brown',
          confidence: 0.59,
          taken: false,
        },
        'Possibly Mary Brown (59% match); not added unless you tick it',
      ],
      [
        { ...base, kind: 'merged', incomingName: 'Thad Ashgrove' },
        'Exported separately as Thad Ashgrove; previously merged into Noah Ashgrove, so not added again',
      ],
    ];
    for (const [change, text] of cases)
      expect(plain(describeChange(change, 'Noah Ashgrove'))).toBe(text);
  });

  it("leaves a kept place out of a change's label", () => {
    const change: ReviewChange = {
      ...base,
      kind: 'fact.change',
      before: fact('1939', 'Elderford, Ohio'),
      after: fact('1940', 'Elderford, Cask County, Ohio, USA'),
      keepPlace: true,
    };
    expect(plain(describeChange(change, 'Josiah Ashgrove'))).toBe('Birth: 1939 → 1940');
  });

  it('says why a move away from a renamed place is a conflict', () => {
    const moved = {
      ...base,
      kind: 'fact.change',
      before: fact('1939', 'Elderford, Ohio'),
      after: fact('1939', 'Millbrook'),
      conflict: 'renamed-place',
      defaultAccept: false,
    } as ReviewChange;
    expect(plain(conflictText(moved, 'Josiah Ashgrove'))).toBe(
      'You renamed this place in this tree, and the export moves this fact to another place. It stays at your place unless you tick this.',
    );
  });
});

describe('names from the export (#264)', () => {
  it('isolates every name, place and title, cleaned, so none reorders the label', () => {
    const rlo = 'Evil\u202e';
    const iso = (text: string) => `\u2068${text}\u2069`;
    expect(describeChange({ ...base, kind: 'name.add', name: rlo, nameType: null }, 'Ann')).toBe(
      `Add name: ${iso('Evil')}`,
    );
    expect(describeChange({ ...base, kind: 'person.new', incomingId: 'x' }, rlo)).toBe(
      `Add ${iso('Evil')}`,
    );
    expect(describeChange({ ...base, kind: 'tag.add', tag: rlo }, 'Ann')).toBe(
      `Add tag: ${iso('Evil')}`,
    );
    expect(describeChange({ ...base, kind: 'media.add', title: rlo }, 'Ann')).toBe(
      `Add media: ${iso('Evil')}`,
    );
    expect(
      describeChange({ ...base, kind: 'child.add', parentNames: [rlo, 'Ivo Fen'] }, 'Ann'),
    ).toBe(`Child of ${iso('Evil')} and ${iso('Ivo Fen')}`);
    expect(
      describeChange({ ...base, kind: 'fact.add', fact: fact('1900', rlo), owner: 'person' }, 'A'),
    ).toBe(`Add fact: Birth, 1900, ${iso('Evil')}`);
    expect(
      conflictText(
        {
          ...base,
          kind: 'name.add',
          name: rlo,
          nameType: null,
          conflict: 'local-edit',
          defaultAccept: false,
        } as ReviewChange,
        'Ann',
      ),
    ).toBe(
      `The export now calls this person ${iso('Evil')}; you renamed them ${iso('Ann')} here. Tick to also keep ${iso('Evil')} as an alternate name; ${iso('Ann')} stays the primary name.`,
    );
    expect(placeRenameText({ key: 'p', from: rlo, to: 'Millbrook', changeIds: ['a'] })).toBe(
      `Place renamed: ${iso('Evil')} → ${iso('Millbrook')} (1 fact)`,
    );
  });
});
describe('compare progress (#161)', () => {
  it('names the phase, with counts while reading records', () => {
    expect(compareProgress(null)).toBe('Uploading');
    expect(compareProgress({ phase: 'parse', done: 0, total: 0 })).toBe('Reading the file');
    expect(compareProgress({ phase: 'map', done: 1200, total: 10000 })).toBe(
      'Reading people and families (1,200 of 10,000 records)',
    );
    expect(compareProgress({ phase: 'compare', done: 0, total: 1 })).toBe(
      'Comparing with your tree',
    );
  });
});

describe('conflict wording (#160)', () => {
  const name = (conflict: 'local-edit' | 'local-delete', nameType: string | null = null) =>
    ({
      ...base,
      kind: 'name.add',
      name: 'Walter Ashgrove',
      nameType,
      conflict,
      defaultAccept: false,
    }) as ReviewChange;

  it("says that ticking a name keeps the user's name as the primary", () => {
    const renamed = {
      ...name('local-edit'),
      was: 'Walter Ashgrove',
      name: 'Walther Ashgrove',
    } as ReviewChange;
    expect(plain(describeChange(renamed, 'Walt Ashgrove'))).toBe(
      'Also keep Walther Ashgrove as an alternate name',
    );
    expect(plain(conflictText(renamed, 'Walt Ashgrove'))).toBe(
      'The export now calls this person Walther Ashgrove (it was Walter Ashgrove); you renamed them Walt Ashgrove here. Tick to also keep Walther Ashgrove as an alternate name; Walt Ashgrove stays the primary name.',
    );
    // A stated type stays in the label where the user decides.
    expect(
      plain(describeChange({ ...renamed, nameType: 'married' } as ReviewChange, 'Walt Ashgrove')),
    ).toBe('Also keep Walther Ashgrove (married name) as an alternate name');
  });

  it('shows a name type only when the export gives one', () => {
    expect(
      plain(
        describeChange(
          { ...base, kind: 'name.add', name: 'Ann Fen', nameType: null } as ReviewChange,
          'Ann Fen',
        ),
      ),
    ).toBe('Add name: Ann Fen');
    expect(
      plain(
        describeChange(
          { ...base, kind: 'name.add', name: 'Ann Fen', nameType: 'married' } as ReviewChange,
          'Ann Fen',
        ),
      ),
    ).toBe('Add name: Ann Fen (married name)');
  });

  it('keeps the general wording for other conflicts', () => {
    const fact = { ...base, kind: 'fact.change', conflict: 'local-edit' } as ReviewChange;
    expect(plain(conflictText(fact, 'X'))).toBe(
      'Edited in this tree since the last import; your edit is kept unless you tick this.',
    );
    expect(plain(conflictText({ ...fact, conflict: 'local-delete' } as ReviewChange, 'X'))).toBe(
      'You deleted this in this tree; it stays deleted unless you tick this.',
    );
    expect(
      plain(conflictText({ ...base, kind: 'tag.add', tag: 't' } as ReviewChange, 'X')),
    ).toBeUndefined();
  });
});

describe('place renames (#279)', () => {
  it('names the old and new place and how many facts move', () => {
    const rename = { key: 'k', from: 'Millbrook', to: 'Millbrook Falls', changeIds: ['c1', 'c2'] };
    expect(plain(placeRenameText(rename))).toBe(
      'Place renamed: Millbrook → Millbrook Falls (2 facts)',
    );
    expect(plain(placeRenameText({ ...rename, changeIds: ['c1'] }))).toBe(
      'Place renamed: Millbrook → Millbrook Falls (1 fact)',
    );
  });
});
