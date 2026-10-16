import { describe, expect, it } from 'vitest';
import type { PersonReview, ReviewChange } from './api';
import { groupReview } from './group';

const change = (extra: Partial<ReviewChange> & { kind: ReviewChange['kind'] }): ReviewChange =>
  ({ id: extra.kind, defaultAccept: true, applicable: true, ...extra }) as ReviewChange;
const person = (
  name: string,
  status: PersonReview['status'],
  changes: ReviewChange[],
  confidence: number | null = status === 'matched' ? 1 : null,
): PersonReview => ({
  key: name,
  status,
  existingId: null,
  incomingId: null,
  name,
  lifespan: '',
  confidence,
  reasons: [],
  changes,
});

describe('grouping the re-import review', () => {
  it('puts what needs a decision first, then changes, new people and information', () => {
    const people = [
      person('Ada', 'matched', [change({ kind: 'tag.add', tag: 't' })]),
      person('Bea', 'matched', [
        change({
          kind: 'name.add',
          name: 'B',
          nameType: 'aka',
          conflict: 'local-edit',
          defaultAccept: false,
        }),
      ]),
      person('Cy', 'new', [change({ kind: 'person.new', incomingId: 'x' })]),
      person('Di', 'new', [
        change({
          kind: 'possible-match',
          existingName: 'D',
          confidence: 0.6,
          taken: false,
          applicable: false,
          defaultAccept: false,
        } as Partial<ReviewChange> & { kind: 'possible-match' }),
        change({ kind: 'person.new', incomingId: 'y', defaultAccept: false }),
      ]),
      person('Ed', 'matched', [
        change({
          kind: 'family.missing',
          partnerNames: ['Ed', 'Fay'],
          applicable: false,
          defaultAccept: false,
        }),
      ]),
      person('Gus', 'missing', [
        change({ kind: 'person.missing', applicable: false, defaultAccept: false }),
      ]),
      person('Hal', 'matched', [change({ kind: 'tag.add', tag: 't' })], 0.7),
    ];
    const groups = groupReview(people);
    expect(groups.map((g) => [g.id, g.people.map((p) => p.name)])).toEqual([
      ['decide', ['Bea', 'Di', 'Hal']],
      ['changes', ['Ada']],
      ['new', ['Cy']],
      ['info', ['Ed', 'Gus']],
    ]);
  });
});
