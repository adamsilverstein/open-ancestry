import { describe, expect, it, vi } from 'vitest';
import type { ChangeBatchRow } from '@open-ancestry/db';
import { deletedHere, rememberDeletedPerson, undoRedoMessage } from './history';

const batch = (label: string) => ({ label }) as ChangeBatchRow;

describe('undoRedoMessage', () => {
  it('names what was undone or redone', () => {
    expect(undoRedoMessage('undo', { batch: batch('Rename Bob'), skipped: [] })).toEqual({
      title: 'Undid Rename Bob',
    });
    expect(undoRedoMessage('redo', { batch: null, skipped: [] })).toEqual({
      title: 'Nothing to redo',
    });
  });

  it('says which changes were skipped because the upgrade made them un-undoable', () => {
    expect(
      undoRedoMessage('undo', { batch: batch('Rename Bob'), skipped: [batch('Add note')] }),
    ).toEqual({
      title: 'Undid Rename Bob',
      description: `Skipped "Add note" (can't be undone after the upgrade)`,
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
