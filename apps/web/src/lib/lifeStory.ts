import { ageAt, formatDate, parseDate } from '@open-ancestry/core';
import type { ChildRelationship } from '@open-ancestry/db';
import type { ApiPersonSummary, EventBrief, EventDetail, PersonDetail } from '../api/types';
import {
  isBirthLink,
  isParentLink,
  linkToOtherPartner,
  linkToPartner,
  parentWord,
  siblingWord,
  siblingsOf,
  type SiblingKind,
} from './kin';
import { eventLabel } from './timeline';
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

/**
 * A date as it reads in a sentence: `on 12 Mar 1880`, `in 1880`, `about 1842`,
 * `before 1920`, `between 1870 and 1872`, `from 1900 to 1910`. `year` drops
 * the day and month. Unparseable text gives nothing rather than a bad phrase.
 */
export function datePhrase(
  text: string | null | undefined,
  { year = false }: { year?: boolean } = {},
): string {
  if (!text) return '';
  const parsed = parseDate(text);
  const { start, end } = parsed;
  if (!parsed.valid || !start) return '';
  const point = (p: typeof start) =>
    formatDate(
      { ...parsed, qualifier: 'exact', start: p, end: undefined, phrase: undefined },
      year ? 'year' : 'long',
    );
  const shown = point(start);
  switch (parsed.qualifier) {
    case 'about':
      return `about ${shown}`;
    case 'calculated':
    case 'estimated':
      return `around ${shown}`;
    case 'before':
      return `before ${shown}`;
    case 'after':
      return `after ${shown}`;
    case 'between':
      return `between ${shown} and ${point(end!)}`;
    case 'from_to':
      return `from ${shown} to ${point(end!)}`;
    case 'from':
      return `from ${shown}`;
    case 'to':
      return `until ${shown}`;
    default:
      return /^\d{1,2} /.test(shown) ? `on ${shown}` : `in ${shown}`;
  }
}

const when = (text: string | null | undefined) => datePhrase(text);
const inYear = (event: EventBrief) => datePhrase(event.dateText, { year: true });

/** Past-tense verbs for custom events whose type reads as a noun. */
const EVENT_VERBS: Record<string, string> = {
  arrival: 'arrived',
  departure: 'departed',
  emigration: 'emigrated',
  immigration: 'immigrated',
  naturalization: 'was naturalized',
  retirement: 'retired',
  graduation: 'graduated',
};

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

interface ParentLink {
  person: ApiPersonSummary;
  rel: ChildRelationship;
}

/** Every parent across the parent families, each once with their first link. */
function parentLinks(detail: PersonDetail): ParentLink[] {
  const found = new Map<string, ParentLink>();
  for (const family of detail.parentFamilies) {
    const sides = [
      [family.partner1, family.link.partner1_rel],
      [family.partner2, family.link.partner2_rel],
    ] as const;
    for (const [person, rel] of sides) {
      if (person && !found.has(person.id)) found.set(person.id, { person, rel });
    }
  }
  return [...found.values()];
}

const SIBLING_ORDER: SiblingKind[] = ['full', 'half', 'step'];

export function lifeStory(detail: PersonDetail): string[] {
  const { summary, events } = detail;
  const name = fullName(summary);
  const me = PRONOUNS[summary.sex] ?? THEY;
  const possessive = capitalize(me.possessive);
  const paragraphs: string[] = [];
  const birthText = summary.birth?.dateText;
  const ageText = (text: string | null | undefined) => {
    if (!birthText || !text) return undefined;
    const age = ageAt(birthText, text);
    return age && !age.approximate ? String(age.years) : undefined;
  };

  // Birth, parents (birth, adoptive, step) and siblings.
  const parents = parentLinks(detail);
  const ofRel = (test: (rel: ChildRelationship) => boolean) =>
    parents.filter((p) => test(p.rel)).map((p) => p.person);
  const birthParents = ofRel(isBirthLink);
  const adoptive = ofRel((rel) => rel === 'adopted');
  const step = ofRel((rel) => rel === 'step');
  const foster = ofRel((rel) => rel === 'foster' || rel === 'guardian');

  const birthParts: string[] = [];
  const birth = firstOwn(events, ['BIRT', 'CHR', 'BAPM']);
  if (birth) {
    const verb = birth.event.type === 'BIRT' ? 'was born' : 'was baptized';
    let sentence = words(name, verb, when(birth.event.date_text), where(birth.place?.full_name));
    if (birthParents.length > 0) {
      const childWord = summary.sex === 'M' ? 'son' : summary.sex === 'F' ? 'daughter' : 'child';
      sentence += `, the ${childWord} of ${list(birthParents.map(fullName))}`;
    }
    birthParts.push(`${sentence}.`);
  }
  const adoption = firstOwn(events, ['ADOP']);
  if (adoptive.length > 0 || adoption) {
    const by = adoptive.length > 0 ? `by ${list(adoptive.map(fullName))}` : '';
    birthParts.push(
      `${capitalize(words(me.subject, 'was adopted', when(adoption?.event.date_text), by))}.`,
    );
  }
  if (step.length > 0) {
    const stepWords = step.map((p) => parentWord(p.sex, 'step'));
    birthParts.push(
      step.length === 1
        ? `${possessive} ${stepWords[0]} was ${fullName(step[0]!)}.`
        : `${possessive} stepparents were ${list(step.map(fullName))}.`,
    );
  }
  if (foster.length > 0) {
    birthParts.push(`${capitalize(me.subject)} was fostered by ${list(foster.map(fullName))}.`);
  }
  const siblings = siblingsOf(detail.parentFamilies);
  if (siblings.length > 0) {
    const parts: string[] = [];
    for (const kind of SIBLING_ORDER) {
      for (const sex of ['M', 'F', 'U']) {
        const n = siblings.filter(
          (s) =>
            s.kind === kind &&
            (sex === 'U' ? s.person.sex !== 'M' && s.person.sex !== 'F' : s.person.sex === sex),
        ).length;
        if (n > 0) parts.push(count(n, siblingWord(sex, kind)));
      }
    }
    birthParts.push(`${capitalize(me.subject)} had ${list(parts)}.`);
  }
  if (birthParts.length > 0) paragraphs.push(birthParts.join(' '));

  // Where they lived, what they did, and other recorded events.
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
    } else if (event.type === 'EVEN') {
      const label = eventLabel(event.type, event.custom_type);
      const verb = EVENT_VERBS[label.toLowerCase()];
      const at = [where(place?.full_name), when(event.date_text)];
      work.push(
        verb
          ? `${capitalize(words(me.subject, verb, ...at))}.`
          : `${capitalize(words(me.possessive, label.toLowerCase(), 'was recorded', ...at))}.`,
      );
    }
  }
  if (work.length > 0) paragraphs.push(work.join(' '));

  // Marriages and children. Only children of both partners are "theirs";
  // a partner's own children are named as stepchildren.
  for (const { family, partner, events: familyEvents, children } of detail.partnerFamilies) {
    const parts: string[] = [];
    const marriage = familyEvents.find((e) => e.event.type === 'MARR');
    if (partner && marriage) {
      parts.push(
        `${capitalize(words(me.subject, 'married', fullName(partner), when(marriage.event.date_text), where(marriage.place?.full_name)))}.`,
      );
    } else if (partner) {
      parts.push(`${capitalize(me.subject)} had a family with ${fullName(partner)}.`);
    }
    const mine = (c: (typeof children)[number]) => linkToPartner(family, detail.person.id, c.link);
    const theirs = (c: (typeof children)[number]) =>
      linkToOtherPartner(family, detail.person.id, c.link);
    const shared = children.filter(
      (c) => isParentLink(mine(c)) && (!partner || isParentLink(theirs(c))),
    );
    const born = shared.filter((c) => mine(c) !== 'adopted').map((c) => given(c.person));
    const adopted = shared.filter((c) => mine(c) === 'adopted').map((c) => given(c.person));
    const subject = partner ? 'Together they' : capitalize(me.subject);
    if (born.length > 0)
      parts.push(`${subject} had ${count(born.length, 'child')}: ${list(born)}.`);
    if (adopted.length > 0) {
      parts.push(`${subject} adopted ${count(adopted.length, 'child')}: ${list(adopted)}.`);
    }
    if (partner) {
      const partnerSteps = children.filter(
        (c) => isParentLink(mine(c)) && !isParentLink(theirs(c)),
      );
      if (partnerSteps.length > 0) {
        parts.push(
          `${given(partner)} was ${parentWord(partner.sex, 'step')} to ${list(partnerSteps.map((c) => given(c.person)))}.`,
        );
      }
      const mySteps = children.filter((c) => !isParentLink(mine(c)) && isParentLink(theirs(c)));
      if (mySteps.length > 0) {
        parts.push(
          `${capitalize(me.subject)} was ${parentWord(summary.sex, 'step')} to ${list(mySteps.map((c) => given(c.person)))}.`,
        );
      }
    }
    if (parts.length > 0) paragraphs.push(parts.join(' '));
  }

  // Losses during their life, in date order.
  const losses: { when: number; text: string }[] = [];
  const end = summary.death?.dateSort ?? Infinity;
  const died = (event: EventBrief | null) => !!event?.dateSort && event.dateSort <= end;
  for (const { person: parent, rel } of parents) {
    if (!died(parent.death)) continue;
    const age = ageText(parent.death!.dateText);
    losses.push({
      when: parent.death!.dateSort!,
      text: `${possessive} ${parentWord(parent.sex, rel)}, ${fullName(parent)}, died ${inYear(parent.death!)}${age ? `, when ${given(summary)} was ${age}` : ''}.`,
    });
  }
  for (const { partner, children } of detail.partnerFamilies) {
    if (partner && died(partner.death)) {
      const role = partner.sex === 'M' ? 'husband' : partner.sex === 'F' ? 'wife' : 'partner';
      losses.push({
        when: partner.death!.dateSort!,
        text: `${possessive} ${role}, ${fullName(partner)}, died ${inYear(partner.death!)}.`,
      });
    }
    for (const { person } of children) {
      if (!died(person.death)) continue;
      const role = person.sex === 'M' ? 'son' : person.sex === 'F' ? 'daughter' : 'child';
      losses.push({
        when: person.death!.dateSort!,
        text: `${possessive} ${role} ${given(person)} died ${inYear(person.death!)}.`,
      });
    }
  }
  if (losses.length > 0) {
    losses.sort((a, b) => a.when - b.when);
    paragraphs.push(losses.map((l) => l.text).join(' '));
  }

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
