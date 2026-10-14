import { formatDate, parseDate } from '@open-ancestry/core';
import type { DateQualifier, LifeDate } from '../lib/lifespan';
import type { PersonSummary } from '../lib/person';
import type { LifeEvent } from '../components/QuickViewPopover/QuickViewPopover';
import { avatarUrl } from '../lib/media';
import type { ApiEventBrief, ApiPersonSummary } from './api';

const QUALIFIERS = new Set<string>(['abt', 'bef', 'aft', 'est', 'cal']);

function lifeDate(event: ApiEventBrief | null): LifeDate | undefined {
  if (!event?.dateSort) return undefined;
  const year = Math.floor(event.dateSort / 10000);
  const q = event.dateQualifier?.toLowerCase();
  return q && QUALIFIERS.has(q) ? { year, qualifier: q as DateQualifier } : { year };
}

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
