import { HIGH_CONFIDENCE, type PersonReview } from './api';

export type GroupId = 'decide' | 'changes' | 'new' | 'info';

export interface ReviewGroup {
  id: GroupId;
  title: string;
  people: PersonReview[];
}

const TITLES: Record<GroupId, string> = {
  decide: 'Needs your decision',
  changes: 'Changes',
  new: 'New people',
  info: 'For information',
};

/** Information that asks the user to decide whether a person is someone already here. */
const QUESTIONS = new Set(['possible-match', 'possibly-merged', 'deleted-here', 'unlinked-new']);

/** Whether a card asks for a decision: a conflict, a likely duplicate, or a match to check. */
export function needsDecision(person: PersonReview): boolean {
  return person.changes.some(
    (c) =>
      !!c.conflict ||
      QUESTIONS.has(c.kind) ||
      (c.applicable && person.status === 'matched' && (person.confidence ?? 1) < HIGH_CONFIDENCE),
  );
}

function groupOf(person: PersonReview): GroupId {
  if (needsDecision(person)) return 'decide';
  if (!person.changes.some((c) => c.applicable)) return 'info';
  return person.status === 'new' ? 'new' : 'changes';
}

/** The review's cards in the order to read them: decisions first, information last. */
export function groupReview(people: PersonReview[]): ReviewGroup[] {
  const byGroup = new Map<GroupId, PersonReview[]>(
    (Object.keys(TITLES) as GroupId[]).map((id) => [id, []]),
  );
  for (const person of people) byGroup.get(groupOf(person))!.push(person);
  return [...byGroup].map(([id, list]) => ({ id, title: TITLES[id], people: list }));
}
