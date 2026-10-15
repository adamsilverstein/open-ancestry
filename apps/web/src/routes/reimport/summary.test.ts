import { describe, expect, it } from 'vitest';
import type { PersonReview, ReviewChange } from './api';
import { summarizeApply } from './summary';

const change = (id: string, extra: Partial<ReviewChange> & { kind: ReviewChange['kind'] }) =>
  ({ id, defaultAccept: true, applicable: true, ...extra }) as unknown as ReviewChange;
const person = (
  name: string,
  status: PersonReview['status'],
  ids: { existingId?: string; incomingId?: string },
  changes: ReviewChange[],
): PersonReview => ({
  key: name,
  status,
  existingId: ids.existingId ?? null,
  incomingId: ids.incomingId ?? null,
  name,
  lifespan: '',
  confidence: status === 'matched' ? 1 : null,
  reasons: [],
  changes,
});

describe('the after-apply summary', () => {
  it('lists applied changes by person with a link, and what was skipped', () => {
    const people = [
      person('Ada Fen', 'matched', { existingId: 'p1' }, [
        change('c1', { kind: 'tag.add', tag: 'Research' }),
        change('c2', { kind: 'sex', before: 'U', after: 'F' }),
      ]),
      person('Bo Fen', 'new', { incomingId: 'i9' }, [
        change('c3', { kind: 'person.new', incomingId: 'i9' }),
      ]),
      person('Cy Fen', 'missing', { existingId: 'p3' }, [
        change('c4', { kind: 'person.missing', applicable: false, defaultAccept: false }),
      ]),
    ];
    const summary = summarizeApply(people, new Set(['c1', 'c3']), { i9: 'p9' });
    expect(summary.applied).toEqual([
      { name: 'Ada Fen', personId: 'p1', changes: ['Add tag: Research'] },
      { name: 'Bo Fen', personId: 'p9', changes: ['Add Bo Fen'] },
    ]);
    expect(summary.skipped).toEqual([
      { name: 'Ada Fen', personId: 'p1', changes: ['Sex: unknown → female'] },
    ]);
    expect(summary.appliedCount).toBe(2);
    expect(summary.skippedCount).toBe(1);
  });
});
