import { ageAt, formatDate } from '@open-ancestry/core';
import type { ApiPersonSummary, EventBrief, EventDetail, PersonDetail } from '../api/types';
import { fullName } from './person';

/*
 * LifeStory: plain sentences assembled from the record, no network and no
 * guessing beyond what the events say. Each paragraph covers one part of a
 * life; empty parts are skipped.
 */

interface Pronouns {
  subject: string;
  possessive: string;
}

const PRONOUNS: Record<string, Pronouns> = {
  M: { subject: 'he', possessive: 'his' },
  F: { subject: 'she', possessive: 'her' },
};
const THEY: Pronouns = { subject: 'they', possessive: 'their' };

const NUMBERS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];
const count = (n: number, noun: string) =>
  `${NUMBERS[n] ?? n} ${noun}${n === 1 ? '' : noun.endsWith('child') ? 'ren' : 's'}`;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `Lena and Arthur`, `A, B and C`. */
function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** `on 12 Mar 1880` for full dates, `in 1880` otherwise. */
function when(text: string | null | undefined): string {
  if (!text) return '';
  const shown = formatDate(text);
  return /^\d{1,2} /.test(shown) ? `on ${shown}` : `in ${shown}`;
}

const where = (place: string | null | undefined) => (place ? `in ${place}` : '');

const words = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

function given(person: ApiPersonSummary): string {
  return person.given?.split(' ')[0] || fullName(person);
}

function firstOwn(events: EventDetail[], types: string[]): EventDetail | undefined {
  for (const type of types) {
    const found = events.find(
      (e) => e.event.type === type && e.role.role === 'principal' && e.role.is_preferred,
    );
    if (found) return found;
  }
  return undefined;
}

export function lifeStory(detail: PersonDetail): string[] {
  const { summary, events } = detail;
  const name = fullName(summary);
  const me = PRONOUNS[summary.sex] ?? THEY;
  const paragraphs: string[] = [];
  const birthText = summary.birth?.dateText;
  const ageText = (text: string | null | undefined) => {
    if (!birthText || !text) return undefined;
    const age = ageAt(birthText, text);
    return age && !age.approximate ? String(age.years) : undefined;
  };

  // Birth and siblings.
  const birthParts: string[] = [];
  const birth = firstOwn(events, ['BIRT', 'CHR', 'BAPM']);
  const family = detail.parentFamilies[0];
  const parents = family
    ? [family.partner1, family.partner2].filter((p): p is ApiPersonSummary => !!p)
    : [];
  if (birth) {
    const verb = birth.event.type === 'BIRT' ? 'was born' : 'was baptized';
    let sentence = words(name, verb, when(birth.event.date_text), where(birth.place?.full_name));
    if (parents.length > 0) {
      const childWord = summary.sex === 'M' ? 'son' : summary.sex === 'F' ? 'daughter' : 'child';
      sentence += `, the ${childWord} of ${list(parents.map(fullName))}`;
    }
    birthParts.push(`${sentence}.`);
  }
  const siblings = detail.parentFamilies.flatMap((f) => f.siblings.map((s) => s.person));
  if (siblings.length > 0) {
    const brothers = siblings.filter((s) => s.sex === 'M').length;
    const sisters = siblings.filter((s) => s.sex === 'F').length;
    const others = siblings.length - brothers - sisters;
    const parts = [
      brothers && count(brothers, 'brother'),
      sisters && count(sisters, 'sister'),
      others && count(others, 'sibling'),
    ].filter((p): p is string => !!p);
    birthParts.push(`${capitalize(me.subject)} had ${list(parts)}.`);
  }
  if (birthParts.length > 0) paragraphs.push(birthParts.join(' '));

  // Where they lived and what they did.
  const work: string[] = [];
  for (const { event, place, role } of events) {
    if (role.role !== 'principal' || !role.is_preferred) continue;
    if (event.type === 'RESI' && place) {
      work.push(
        `${capitalize(words(when(event.date_text), me.subject, 'lived', where(place.full_name)))}.`,
      );
    } else if (event.type === 'OCCU' && event.value) {
      const job = event.value.toLowerCase();
      const article = /^[aeiou]/.test(job) ? 'an' : 'a';
      work.push(
        `${capitalize(words(me.subject, 'worked as', article, job, when(event.date_text)))}.`,
      );
    }
  }
  if (work.length > 0) paragraphs.push(work.join(' '));

  // Marriages and children.
  for (const { partner, events: familyEvents, children } of detail.partnerFamilies) {
    const parts: string[] = [];
    const marriage = familyEvents.find((e) => e.event.type === 'MARR');
    if (partner && marriage) {
      parts.push(
        `${capitalize(words(me.subject, 'married', fullName(partner), when(marriage.event.date_text), where(marriage.place?.full_name)))}.`,
      );
    } else if (partner) {
      parts.push(`${capitalize(me.subject)} had a family with ${fullName(partner)}.`);
    }
    if (children.length > 0) {
      const kids = children.map((c) => given(c.person));
      parts.push(
        partner
          ? `Together they had ${count(kids.length, 'child')}: ${list(kids)}.`
          : `${capitalize(me.subject)} had ${count(kids.length, 'child')}: ${list(kids)}.`,
      );
    }
    if (parts.length > 0) paragraphs.push(parts.join(' '));
  }

  // Losses during their life.
  const losses: string[] = [];
  const end = summary.death?.dateSort ?? Infinity;
  const died = (event: EventBrief | null) => !!event?.dateSort && event.dateSort <= end;
  const year = (event: EventBrief) => formatDate(event.dateText ?? '', 'year');
  const possessive = capitalize(me.possessive);
  for (const parent of parents) {
    if (!died(parent.death)) continue;
    const role = parent.sex === 'M' ? 'father' : parent.sex === 'F' ? 'mother' : 'parent';
    const age = ageText(parent.death!.dateText);
    losses.push(
      `${possessive} ${role}, ${fullName(parent)}, died in ${year(parent.death!)}${age ? `, when ${given(summary)} was ${age}` : ''}.`,
    );
  }
  for (const { partner, children } of detail.partnerFamilies) {
    if (partner && died(partner.death)) {
      const role = partner.sex === 'M' ? 'husband' : partner.sex === 'F' ? 'wife' : 'partner';
      losses.push(`${possessive} ${role}, ${fullName(partner)}, died in ${year(partner.death!)}.`);
    }
    for (const { person } of children) {
      if (!died(person.death)) continue;
      const role = person.sex === 'M' ? 'son' : person.sex === 'F' ? 'daughter' : 'child';
      losses.push(`${possessive} ${role} ${given(person)} died in ${year(person.death!)}.`);
    }
  }
  if (losses.length > 0) paragraphs.push(losses.join(' '));

  // Death and burial.
  const death = firstOwn(events, ['DEAT']);
  const burial = firstOwn(events, ['BURI', 'CREM']);
  if (death) {
    const age = ageText(death.event.date_text);
    let sentence = capitalize(
      words(me.subject, 'died', when(death.event.date_text), where(death.place?.full_name)),
    );
    if (age) sentence += `, at the age of ${age}`;
    if (burial?.place) {
      sentence += `, and was ${burial.event.type === 'BURI' ? 'buried' : 'cremated'} in ${burial.place.full_name}`;
    }
    paragraphs.push(`${sentence}.`);
  }

  return paragraphs;
}
