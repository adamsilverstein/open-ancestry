import { formatDate, lifeDate, parseDate } from '@open-ancestry/core';
import type { PersonSummary } from '../lib/person';
import type { LifeEvent } from '../components/QuickViewPopover/QuickViewPopover';
import { avatarUrl } from '../lib/media';
import type { ApiEventBrief, ApiPersonSummary } from './api';

export function displayName(p: ApiPersonSummary): string {
  const name = [p.prefix, p.given, p.surnamePrefix, p.surname, p.suffix]
    .filter((part) => part)
    .join(' ');
  return name || 'Unknown';
}

/** A database person summary as cards and popovers show it. */
export function toPersonSummary(p: ApiPersonSummary, tree: string): PersonSummary {
  return {
    id: p.id,
    name: displayName(p),
    given: p.given ?? undefined,
    surname: [p.surnamePrefix, p.surname].filter(Boolean).join(' ') || undefined,
    sex: p.sex === 'M' || p.sex === 'F' ? p.sex : 'U',
    birth: lifeDate(p.birth),
    death: lifeDate(p.death),
    living: p.living !== 'dead' && p.living !== 'inferred_dead',
    // A thumbnail, and only for a photo with a local file: no 404s for Ancestry-only media.
    photoUrl: avatarUrl(tree, p),
  };
}

/** Born or died line for the quick view: `5 Sep 1911`, with the place. */
export function lifeEvent(event: ApiEventBrief | null): LifeEvent | undefined {
  if (!event) return undefined;
  const date = event.dateText ? formatDate(parseDate(event.dateText)) : undefined;
  return { date: date || event.dateText || undefined, place: event.place ?? undefined };
}
