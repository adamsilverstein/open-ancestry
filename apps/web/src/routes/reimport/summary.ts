import type { PersonReview } from './api';
import { describeChange } from './labels';

export interface SummaryPerson {
  name: string;
  /** The person in the tree, to link to; null if they aren't in it (a skipped new person). */
  personId: string | null;
  changes: string[];
}

export interface ApplySummary {
  applied: SummaryPerson[];
  skipped: SummaryPerson[];
  appliedCount: number;
  skippedCount: number;
}

/**
 * What an apply did, person by person: the changes applied and the ones left
 * out (unticked, or waiting on a person who wasn't added). Information-only
 * lines are neither.
 */
export function summarizeApply(
  people: PersonReview[],
  applied: Set<string>,
  newPeople: Record<string, string>,
): ApplySummary {
  const summary: ApplySummary = { applied: [], skipped: [], appliedCount: 0, skippedCount: 0 };
  for (const person of people) {
    const personId =
      person.existingId ?? (person.incomingId ? (newPeople[person.incomingId] ?? null) : null);
    const done: string[] = [];
    const left: string[] = [];
    for (const change of person.changes) {
      if (!change.applicable) continue;
      (applied.has(change.id) ? done : left).push(describeChange(change, person.name));
    }
    if (done.length) summary.applied.push({ name: person.name, personId, changes: done });
    if (left.length) summary.skipped.push({ name: person.name, personId, changes: left });
    summary.appliedCount += done.length;
    summary.skippedCount += left.length;
  }
  return summary;
}
