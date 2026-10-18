import { describe, expect, it, vi } from 'vitest';
import type { ChangeBatchRow } from '@open-ancestry/db';
import { deletedHere, rememberDeletedPerson, undoRedoMessage } from './history';

const batch = (label: string) => ({ label }) as ChangeBatchRow;

describe('undoRedoMessage', () => {
  it('names what was undone or redone', () => {
    expect(undoRedoMessage('undo', { batch: batch('Rename Bob'), skipped: [] })).toEqual({
      title: 'Undid \u2068Rename Bob\u2069',
    });
    expect(undoRedoMessage('redo', { batch: null, skipped: [] })).toEqual({
      title: 'Nothing to redo',
    });
  });

  it('says which changes were skipped because the upgrade made them un-undoable', () => {
    expect(
      undoRedoMessage('undo', { batch: batch('Rename Bob'), skipped: [batch('Add note')] }),
    ).toEqual({
      title: 'Undid \u2068Rename Bob\u2069',
      description: `Skipped "\u2068Add note\u2069" (can't be undone after the upgrade)`,
    });
  });

  it('cleans and isolates stored labels, so an override cannot flip the toast (#264)', () => {
    // A label the server built from a name imported with an override, before it cleaned them.
    expect(
      undoRedoMessage('redo', {
        batch: batch('Edit person: Evil\u202e Ashdown'),
        skipped: [batch('Tag \u202dRowan')],
      }),
    ).toEqual({
      title: 'Redid \u2068Edit person: Evil Ashdown\u2069',
      description: `Skipped "\u2068Tag Rowan\u2069" (can't be undone after the upgrade)`,
    });
  });
});

describe('deletedHere', () => {
  it('answers once per delete made here, so a later delete elsewhere is announced', () => {
    rememberDeletedPerson('b-1', 'p-once');
    expect(deletedHere('p-once')).toBe(true);
    // Restored elsewhere and deleted there: this page must announce it.
    expect(deletedHere('p-once')).toBe(false);
  });

  it('forgets a delete whose page never asked, after a few seconds', () => {
    vi.useFakeTimers();
    try {
      rememberDeletedPerson('b-2', 'p-old');
      vi.advanceTimersByTime(10_000);
      expect(deletedHere('p-old')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
