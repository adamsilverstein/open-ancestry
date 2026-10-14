import { describe, expect, it } from 'vitest';
import { fixtureDetail } from '../../../lib/fixtureDetail.test-utils';
import { fullName } from '../../../lib/person';
import {
  applyNames,
  applyPerson,
  nameChanges,
  removeEvent,
  removeNote,
  removeTag,
  setNoteText,
  toDraft,
} from './optimistic';

const rowan = fixtureDetail('rowan');

describe('names', () => {
  it('diffs a draft against the stored row', () => {
    const row = rowan.names[0]!;
    const draft = toDraft(row);
    expect(nameChanges(draft, row)).toEqual({});
    expect(nameChanges({ ...draft, given: ' Rowan James ', suffix: '' }, row)).toEqual({
      given: 'Rowan James',
    });
    expect(nameChanges({ ...draft, id: undefined, type: 'aka', isPrimary: false })).toEqual({
      prefix: null,
      given: 'Rowan',
      surname: 'Ashdown',
      suffix: null,
      nickname: null,
      type: 'aka',
    });
  });

  it('updates the names and the summary from the primary name', () => {
    const draft = toDraft(rowan.names[0]!);
    const next = applyNames(rowan, [
      { ...draft, isPrimary: false },
      { ...draft, id: undefined, given: 'Ro', surname: 'Ashe', isPrimary: true, type: 'aka' },
    ]);
    expect(next.names).toHaveLength(2);
    expect(fullName(next.summary)).toBe('Ro Ashe');
    expect(fullName(applyNames(rowan, []).summary)).toBe('Rowan Ashdown');
  });
});

describe('other updates', () => {
  it('patches sex and living status', () => {
    const next = applyPerson(rowan, { sex: 'X', living: 'living' });
    expect(next.summary).toMatchObject({ sex: 'X', living: 'living' });
    expect(next.person).toMatchObject({ sex: 'X', living: 'living' });
  });

  it('removes events, clearing the vital they fed', () => {
    const death = rowan.summary.death!.eventId;
    const next = removeEvent(rowan, death);
    expect(next.summary.death).toBeNull();
    expect(next.events.some((e) => e.event.id === death)).toBe(false);
    const marriage = rowan.partnerFamilies[0]!.events[0]!.event.id;
    expect(removeEvent(rowan, marriage).partnerFamilies[0]!.events).toHaveLength(0);
  });

  it('edits and removes notes and tags', () => {
    const note = rowan.notes[0]!;
    expect(setNoteText(rowan, note.id, 'New text').notes[0]!.text).toBe('New text');
    expect(removeNote(rowan, note.id).notes).toHaveLength(0);
    expect(removeTag(rowan, rowan.tags[0]!.id).tags).toHaveLength(0);
  });
});
