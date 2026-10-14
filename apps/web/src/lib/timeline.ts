import { ageAt, formatDate } from '@open-ancestry/core';
import type { ApiPersonSummary, EventBrief, EventDetail, PersonDetail } from '../api/types';
import { fullName } from './person';

export type TimelineCategory = 'life' | 'family' | 'work' | 'other';

export const timelineCategories: { id: TimelineCategory; label: string }[] = [
  { id: 'life', label: 'Life events' },
  { id: 'family', label: 'Family events' },
  { id: 'work', label: 'Residence and work' },
  { id: 'other', label: 'Other' },
];

export interface TimelineEntry {
  id: string;
  /** `own` events of the person (and their families), `family` events of relatives. */
  kind: 'own' | 'family';
  category: TimelineCategory;
  title: string;
  /** Display date, e.g. `12 Mar 1880` or `abt. 1879`. */
  date: string | undefined;
  /** Year column text. */
  year: string | undefined;
  age: number | undefined;
  place: string | undefined;
  sourceCount: number;
  /** The relative a family event is about. */
  personId?: string;
  /** Alternate facts of the same type, grouped under the preferred one. */
  alternates: TimelineEntry[];
  sortKey: number | null;
}

const LABELS: Record<string, string> = {
  BIRT: 'Birth',
  CHR: 'Christening',
  BAPM: 'Baptism',
  DEAT: 'Death',
  BURI: 'Burial',
  CREM: 'Cremation',
  MARR: 'Marriage',
  DIV: 'Divorce',
  ENGA: 'Engagement',
  RESI: 'Residence',
  OCCU: 'Occupation',
  EDUC: 'Education',
  CENS: 'Census',
  EMIG: 'Emigration',
  IMMI: 'Immigration',
  NATU: 'Naturalization',
  PROP: 'Property',
  RETI: 'Retirement',
  GRAD: 'Graduation',
  MILI: 'Military',
  _MILT: 'Military',
  RELI: 'Religion',
  NATI: 'Nationality',
  TITL: 'Title',
  ADOP: 'Adoption',
  PROB: 'Probate',
  WILL: 'Will',
  DSCR: 'Description',
};

/** Family event titles that name the partner: `Marriage to Iris Vale`. */
const PARTNER_PREPOSITION: Record<string, string> = {
  MARR: 'to',
  ENGA: 'to',
  DIV: 'from',
};

const LIFE = new Set([
  'BIRT',
  'CHR',
  'BAPM',
  'DEAT',
  'BURI',
  'CREM',
  'MARR',
  'DIV',
  'ENGA',
  'ADOP',
]);
const WORK = new Set([
  'RESI',
  'OCCU',
  'EDUC',
  'CENS',
  'EMIG',
  'IMMI',
  'NATU',
  'PROP',
  'RETI',
  'GRAD',
]);
const WITH_VALUE = new Set(['OCCU', 'TITL', 'RELI', 'NATI', 'EDUC', 'DSCR', 'PROP']);

export function eventLabel(type: string, customType?: string | null): string {
  if (type === 'EVEN' || !LABELS[type]) {
    return customType?.trim() || type.charAt(0) + type.slice(1).toLowerCase();
  }
  return LABELS[type];
}

function categoryOf(type: string): TimelineCategory {
  if (LIFE.has(type)) return 'life';
  if (WORK.has(type)) return 'work';
  return 'other';
}

const display = (text: string | null | undefined) => (text ? formatDate(text) : undefined);
const yearOf = (text: string | null | undefined) => (text ? formatDate(text, 'year') : undefined);

/** Relationship words by sex for interleaved family events. */
function kin(sex: string, male: string, female: string, other: string): string {
  return sex === 'M' ? male : sex === 'F' ? female : other;
}

/**
 * The person timeline: own events with alternates grouped under the preferred
 * fact, their partner families' events, and relatives' births and deaths
 * within the person's lifetime, all in date order.
 */
export function buildTimeline(detail: PersonDetail): TimelineEntry[] {
  const birthText = detail.summary.birth?.dateText ?? null;
  const ageFor = (text: string | null | undefined) => {
    if (!birthText || !text) return undefined;
    return ageAt(birthText, text)?.years;
  };

  const ownEntry = (item: EventDetail, title: string): TimelineEntry => ({
    id: item.event.id,
    kind: 'own',
    category: categoryOf(item.event.type),
    title,
    date: display(item.event.date_text),
    year: yearOf(item.event.date_text),
    age: item.event.type === 'BIRT' ? undefined : ageFor(item.event.date_text),
    place: item.place?.full_name,
    sourceCount: item.citations.length,
    alternates: [],
    sortKey: item.event.date_sort,
  });

  const entries: TimelineEntry[] = [];
  const preferredByType = new Map<string, TimelineEntry>();
  const alternates: [string, TimelineEntry][] = [];
  for (const item of detail.events) {
    const { event, role } = item;
    let title = eventLabel(event.type, event.custom_type);
    if (WITH_VALUE.has(event.type) && event.value) title = `${title}: ${event.value}`;
    if (role.role !== 'principal') title = `${title} (${role.role})`;
    const entry = ownEntry(item, title);
    if (role.is_preferred === 0) alternates.push([event.type, entry]);
    else {
      if (!preferredByType.has(event.type)) preferredByType.set(event.type, entry);
      entries.push(entry);
    }
  }
  for (const [type, entry] of alternates) {
    const preferred = preferredByType.get(type);
    if (preferred) preferred.alternates.push(entry);
    else entries.push(entry);
  }

  for (const { partner, events } of detail.partnerFamilies) {
    for (const item of events) {
      const preposition = PARTNER_PREPOSITION[item.event.type];
      const label = eventLabel(item.event.type, item.event.custom_type);
      entries.push(
        ownEntry(
          item,
          partner && preposition ? `${label} ${preposition} ${fullName(partner)}` : label,
        ),
      );
    }
  }

  const start = detail.summary.birth?.dateSort ?? -Infinity;
  const end = detail.summary.death?.dateSort ?? Infinity;
  const relativeEvent = (
    relative: ApiPersonSummary,
    event: EventBrief | null,
    what: 'Birth' | 'Death',
    relation: string,
  ) => {
    if (!event?.dateSort || event.dateSort < start || event.dateSort > end) return;
    entries.push({
      id: `${event.eventId}:${relative.id}`,
      kind: 'family',
      category: 'family',
      title: `${what} of ${relation} ${fullName(relative)}`,
      date: display(event.dateText),
      year: yearOf(event.dateText),
      age: ageFor(event.dateText),
      place: event.place ?? undefined,
      sourceCount: 0,
      personId: relative.id,
      alternates: [],
      sortKey: event.dateSort,
    });
  };

  for (const family of detail.parentFamilies) {
    for (const parent of [family.partner1, family.partner2]) {
      if (parent)
        relativeEvent(parent, parent.death, 'Death', kin(parent.sex, 'father', 'mother', 'parent'));
    }
    for (const { person } of family.siblings) {
      relativeEvent(person, person.birth, 'Birth', kin(person.sex, 'brother', 'sister', 'sibling'));
    }
  }
  for (const { partner, children } of detail.partnerFamilies) {
    if (partner)
      relativeEvent(partner, partner.death, 'Death', kin(partner.sex, 'husband', 'wife', 'spouse'));
    for (const { person } of children) {
      const relation = kin(person.sex, 'son', 'daughter', 'child');
      relativeEvent(person, person.birth, 'Birth', relation);
      relativeEvent(person, person.death, 'Death', relation);
    }
  }

  // Stable sort: undated events keep their order at the end.
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) => (a.entry.sortKey ?? Infinity) - (b.entry.sortKey ?? Infinity) || a.index - b.index,
    )
    .map(({ entry }) => entry);
}

export function filterTimeline(
  entries: TimelineEntry[],
  hidden: ReadonlySet<TimelineCategory>,
): TimelineEntry[] {
  return hidden.size === 0 ? entries : entries.filter((entry) => !hidden.has(entry.category));
}
