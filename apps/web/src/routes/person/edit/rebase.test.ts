import { describe, expect, it } from 'vitest';
import type { PersonNameRow } from '@open-ancestry/db';
import { fixtureDetail } from '../../../lib/fixtureDetail.test-utils';
import { toDraft } from './optimistic';
import { rebaseNames, rebaseValue } from './rebase';

const rowan = fixtureDetail('rowan');
const row = rowan.names[0]!;
const aka: PersonNameRow = { ...row, id: 'n-aka', type: 'aka', given: 'Ro', is_primary: 0 };

describe('rebaseValue', () => {
  it("keeps the user's change, else takes the latest", () => {
    expect(rebaseValue('M', 'M', 'F')).toBe('F');
    expect(rebaseValue('X', 'M', 'F')).toBe('X');
  });
});

describe('rebaseNames', () => {
  it('keeps the fields the user changed and takes the rest from the latest row', () => {
    // The form opened on "Rowan Ashdown"; the user changed the surname; another
    // tab changed the given name meanwhile.
    const draft = { ...toDraft(row), surname: 'Ashby' };
    const latest = { ...row, given: 'Roland' };
    expect(rebaseNames([draft], [row], [latest])).toEqual([
      { ...toDraft(row), given: 'Roland', surname: 'Ashby' },
    ]);
  });

  it('adds names added elsewhere, keeps new and removed ones as the user left them', () => {
    const fresh = { ...toDraft(aka), id: undefined, given: 'New' };
    // The user removed nothing and added `fresh`; another tab added `aka`.
    expect(rebaseNames([toDraft(row), fresh], [row], [row, aka])).toEqual([
      toDraft(row),
      fresh,
      toDraft(aka),
    ]);
    // The user removed `aka`: it stays removed.
    expect(rebaseNames([toDraft(row)], [row, aka], [row, aka])).toEqual([toDraft(row)]);
  });

  it('drops a name deleted elsewhere unless the user edited it, which keeps it as new', () => {
    expect(rebaseNames([toDraft(row), toDraft(aka)], [row, aka], [row])).toEqual([toDraft(row)]);
    const edited = { ...toDraft(aka), given: 'Robin' };
    expect(rebaseNames([toDraft(row), edited], [row, aka], [row])).toEqual([
      toDraft(row),
      { ...edited, id: undefined },
    ]);
  });

  it('leaves one primary name: the one the user picked, else the latest', () => {
    // The user made `aka` primary; another tab made a third name primary.
    const third: PersonNameRow = { ...aka, id: 'n-third', given: 'Rafe', is_primary: 1 };
    const out = rebaseNames(
      [
        { ...toDraft(row), isPrimary: false },
        { ...toDraft(aka), isPrimary: true },
      ],
      [row, aka],
      [{ ...row, is_primary: 0 }, aka, third],
    );
    expect(out.filter((n) => n.isPrimary).map((n) => n.id)).toEqual(['n-aka']);
    // Untouched: the latest primary stands.
    const kept = rebaseNames(
      [toDraft(row), toDraft(aka)],
      [row, aka],
      [{ ...row, is_primary: 0 }, third, aka],
    );
    expect(kept.filter((n) => n.isPrimary).map((n) => n.id)).toEqual(['n-third']);
  });
});
