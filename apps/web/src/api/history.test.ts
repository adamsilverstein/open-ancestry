import { describe, expect, it } from 'vitest';
import type { ChangeBatchRow } from '@open-ancestry/db';
import { undoRedoMessage } from './history';

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
