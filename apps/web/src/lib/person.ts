import type { LivingStatus } from '@open-ancestry/db';
import type { ApiPersonSummary, EventBrief, PersonDetail } from '../api/types';
import type { LifeDate } from './lifespan';
import { displayText } from '@open-ancestry/core';

export type Sex = 'M' | 'F' | 'U';

export type TagColor = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface TagSummary {
  label: string;
  color: TagColor;
}

/** What tree cards, lists and popovers need to show a person. */
export interface PersonSummary {
  id: string;
  name: string;
  /** The stored name parts, where known (the fan fits labels from them). */
  given?: string | undefined;
  surname?: string | undefined;
  sex: Sex;
  birth?: LifeDate | undefined;
  death?: LifeDate | undefined;
  living?: boolean | undefined;
  photoUrl?: string | undefined;
  tags?: TagSummary[] | undefined;
  sourceCount?: number | undefined;
}

export const sexLabel: Record<Sex, string> = { M: 'male', F: 'female', U: 'sex unknown' };

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

// ------------------------------------------------------------ API adapters

const QUALIFIER: Partial<Record<string, LifeDate['qualifier']>> = {
  about: 'abt',
  before: 'bef',
  after: 'aft',
  estimated: 'est',
  calculated: 'cal',
};

/** Mirrors packages/db `isLiving`: unknown counts as living for privacy. */
export function isLivingStatus(status: LivingStatus): boolean {
  return status !== 'dead' && status !== 'inferred_dead';
}

/** The name as shown: parts cleaned one by one, so an override in one cannot reach the next (#190). */
export function fullName(person: ApiPersonSummary): string {
  const name = [person.prefix, person.given, person.surnamePrefix, person.surname, person.suffix]
    .map((part) => (part ? displayText(part) : ''))
    .filter((part) => part.trim())
    .join(' ');
  return name || 'Unknown name';
}

/** Year-level date for LifespanText from an API event brief. */
export function lifeDate(event: EventBrief | null): LifeDate | undefined {
  if (!event?.dateSort) return undefined;
  return {
    year: Math.trunc(event.dateSort / 10000),
    qualifier: QUALIFIER[event.dateQualifier ?? ''],
  };
}

/** API summary to the shape PersonCard, Avatar and RelationshipList take. */
export function toPersonSummary(person: ApiPersonSummary, photoUrl?: string): PersonSummary {
  return {
    id: person.id,
    name: fullName(person),
    sex: person.sex === 'M' || person.sex === 'F' ? person.sex : 'U',
    birth: lifeDate(person.birth),
    death: lifeDate(person.death),
    living: !person.death && isLivingStatus(person.living),
    photoUrl,
  };
}

/** The closest relative to show after this person is deleted: a parent, partner, child, then sibling. */
export function nearestRelative(detail: PersonDetail): string | undefined {
  const parents = detail.parentFamilies.flatMap((f) => [f.partner1, f.partner2]);
  const partners = detail.partnerFamilies.map((f) => f.partner);
  const children = detail.partnerFamilies.flatMap((f) => f.children.map((c) => c.person));
  const siblings = detail.parentFamilies.flatMap((f) => f.siblings.map((s) => s.person));
  const self = detail.person.id;
  return [...parents, ...partners, ...children, ...siblings].find((p) => p && p.id !== self)?.id;
}
