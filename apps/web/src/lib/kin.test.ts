import { describe, expect, it } from 'vitest';
import type { ChildRelationship } from '@open-ancestry/db';
import { fixtureDetail } from './fixtureDetail.test-utils';
import { childWord, parentWord, siblingKind, siblingWord, siblingsOf } from './kin';

const rels = (partner1_rel: ChildRelationship, partner2_rel: ChildRelationship) => ({
  partner1_rel,
  partner2_rel,
});

describe('siblingKind', () => {
  const both = {
    partner1: fixtureDetail('edmund').summary,
    partner2: fixtureDetail('clara').summary,
  };
  const one = { partner1: fixtureDetail('edmund').summary, partner2: null };

  it.each<[string, typeof both | typeof one, ChildRelationship[], ChildRelationship[], string]>([
    ['both biological', both, ['biological', 'biological'], ['biological', 'biological'], 'full'],
    ['unknown links', both, ['unknown', 'unknown'], ['biological', 'unknown'], 'full'],
    ['adopted into the family', both, ['adopted', 'adopted'], ['biological', 'biological'], 'full'],
    [
      'my stepfather is their father',
      both,
      ['step', 'biological'],
      ['biological', 'biological'],
      'half',
    ],
    [
      'their stepmother is my mother',
      both,
      ['biological', 'biological'],
      ['biological', 'step'],
      'half',
    ],
    ['foster child', both, ['foster', 'biological'], ['biological', 'biological'], 'half'],
    ['no parent shared', both, ['step', 'biological'], ['biological', 'step'], 'step'],
    ['single parent', one, ['biological', 'unknown'], ['biological', 'unknown'], 'full'],
    ['single step parent', one, ['step', 'unknown'], ['biological', 'unknown'], 'step'],
  ])('%s', (_label, family, mine, theirs, kind) => {
    expect(siblingKind(family, rels(mine[0]!, mine[1]!), rels(theirs[0]!, theirs[1]!))).toBe(kind);
  });

  it('is full with no recorded partners', () => {
    const none = { partner1: null, partner2: null };
    expect(siblingKind(none, rels('step', 'step'), rels('biological', 'biological'))).toBe('full');
  });
});

describe('words', () => {
  it.each([
    ['M', 'full', 'brother'],
    ['F', 'half', 'half-sister'],
    ['U', 'half', 'half-sibling'],
    ['M', 'step', 'stepbrother'],
    ['F', 'step', 'stepsister'],
  ] as const)('sibling %s %s -> %s', (sex, kind, word) => {
    expect(siblingWord(sex, kind)).toBe(word);
  });

  it.each([
    ['M', 'biological', 'father', 'son'],
    ['F', 'step', 'stepmother', 'stepdaughter'],
    ['M', 'adopted', 'adoptive father', 'adopted son'],
    ['F', 'foster', 'foster mother', 'foster daughter'],
    ['U', 'unknown', 'parent', 'child'],
  ] as const)('%s %s -> %s / %s', (sex, rel, parent, child) => {
    expect(parentWord(sex, rel)).toBe(parent);
    expect(childWord(sex, rel)).toBe(child);
  });
});

describe('siblingsOf', () => {
  it('lists a sibling once, with the closest kind across families', () => {
    const detail = fixtureDetail('rowan');
    const [family] = detail.parentFamilies;
    const tobias = family!.siblings.find((s) => s.person.given === 'Tobias')!;
    const stepFamily = {
      ...family!,
      family: { ...family!.family, id: 'other' },
      siblings: [{ ...tobias, link: { ...tobias.link, ...rels('step', 'step') } }],
    };
    const found = siblingsOf([stepFamily, family!]);
    expect(found.find((s) => s.person.id === tobias.person.id)?.kind).toBe('full');
    expect(new Set(found.map((s) => s.person.id)).size).toBe(found.length);
  });
});
