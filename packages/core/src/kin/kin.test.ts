import { describe, expect, it } from 'vitest';
import type { ChildRelation } from '../layout/types';
import {
  childWord,
  isBirthParent,
  isParent,
  lineQualifier,
  parentLink,
  parentWord,
  qualify,
  siblingKind,
  siblingWord,
} from './index';
import type { SharedAdult, SiblingKind } from './index';

describe('parent links', () => {
  it.each<[ChildRelation, string, boolean, boolean]>([
    ['biological', 'birth', true, true],
    ['unknown', 'birth', true, true],
    ['private', 'birth', true, true],
    ['adopted', 'adoptive', true, false],
    ['step', 'step', false, false],
    ['foster', 'foster', false, false],
    ['guardian', 'guardian', false, false],
    ['related', 'guardian', false, false],
  ])('%s is %s (parent %s, birth %s)', (rel, link, parent, birth) => {
    expect(parentLink(rel)).toBe(link);
    expect(isParent(rel)).toBe(parent);
    expect(isBirthParent(rel)).toBe(birth);
  });

  it('treats a missing link as birth', () => {
    expect(parentLink(undefined)).toBe('birth');
    expect(parentLink(null)).toBe('birth');
  });
});

describe('siblingKind', () => {
  const b: ChildRelation = 'biological';
  it.each<[string, SharedAdult[], boolean, SiblingKind]>([
    [
      'both children of both partners',
      [
        [b, b],
        [b, b],
      ],
      false,
      'full',
    ],
    [
      'an adopted and a birth child of the same couple',
      [
        [b, 'adopted'],
        [b, 'adopted'],
      ],
      false,
      'adopted',
    ],
    [
      'two children adopted by one couple',
      [
        ['adopted', 'adopted'],
        ['adopted', 'adopted'],
      ],
      false,
      'adopted',
    ],
    ["a parent's adopted child in another partnership", [[b, 'adopted']], true, 'adopted'],
    [
      'shares a birth mother; adopted by her husband',
      [
        [b, b],
        [b, 'adopted'],
      ],
      false,
      'half',
    ],
    ['one recorded parent', [[b, b]], false, 'full'],
    ['no recorded parents', [], false, 'full'],
    [
      "mother's child by a later husband",
      [
        [b, b],
        [b, 'step'],
      ],
      false,
      'half',
    ],
    ["a parent's child in another partnership", [[b, b]], true, 'half'],
    [
      "stepfather's own son",
      [
        [b, 'step'],
        ['step', b],
      ],
      false,
      'step',
    ],
    ["a parent's stepchild in another partnership", [[b, 'step']], true, 'step'],
    ["foster mother's own son", [['foster', b]], false, 'foster'],
    ['two foster children', [['foster', 'foster']], false, 'foster'],
    ["guardian's child", [['guardian', b]], true, 'foster'],
    ["a relative's child, raised together", [['related', b]], false, 'foster'],
  ])('%s: %s', (_label, shared, apart, kind) => {
    expect(siblingKind(shared, apart)).toBe(kind);
  });
});

describe('words', () => {
  it.each<[string, Parameters<typeof qualify>[1], string]>([
    ['father', 'step', 'stepfather'],
    ['grandmother', 'step', 'step-grandmother'],
    ['aunt', 'step', 'step-aunt'],
    ['1st cousin', 'step', 'step-first cousin'],
    ['2nd cousin 1x removed', 'step', 'step-second cousin 1x removed'],
    ['11th cousin', 'step', 'step-11th cousin'],
    ['sister', 'half', 'half-sister'],
    ['uncle', 'half', 'half-uncle'],
    ['1st cousin 1x removed', 'half', 'half first cousin 1x removed'],
    ['2nd cousin', 'half', 'half second cousin'],
    ['son', 'adopted', 'adopted son'],
    ['mother', 'adoptive', 'adoptive mother'],
    ['brother', 'foster', 'foster brother'],
    ['niece', undefined, 'niece'],
  ])('%s + %s = %s', (word, q, out) => {
    expect(qualify(word, q)).toBe(out);
  });

  it.each<[string, ChildRelation, string, string]>([
    ['M', 'biological', 'father', 'son'],
    ['F', 'step', 'stepmother', 'stepdaughter'],
    ['M', 'adopted', 'adoptive father', 'adopted son'],
    ['U', 'foster', 'foster parent', 'foster child'],
    ['F', 'guardian', 'guardian', 'ward'],
    ['F', 'related', 'guardian', 'ward'],
    ['M', 'private', 'father', 'son'],
  ])('%s %s: %s / %s', (sex, rel, parent, child) => {
    expect(parentWord(sex, rel)).toBe(parent);
    expect(childWord(sex, rel)).toBe(child);
  });

  it.each<[string, SiblingKind, string]>([
    ['M', 'full', 'brother'],
    ['F', 'half', 'half-sister'],
    ['M', 'adopted', 'adopted brother'],
    ['M', 'step', 'stepbrother'],
    ['F', 'foster', 'foster sister'],
    ['U', 'half', 'half-sibling'],
  ])('%s %s sibling: %s', (sex, kind, word) => {
    expect(siblingWord(sex, kind)).toBe(word);
  });
});

describe('lineQualifier', () => {
  it.each<[(ChildRelation | undefined)[], string | undefined]>([
    [['biological', 'biological'], undefined],
    [['step', 'biological'], 'step'],
    [['biological', 'adopted', 'step'], 'step'],
    [['foster'], 'foster'],
    [['related', 'biological'], 'foster'],
    [['adopted', 'biological'], 'adoptive'],
    [[undefined, 'private'], undefined],
  ])('%j -> %s', (rels, q) => {
    expect(lineQualifier(rels)).toBe(q);
  });

  it('names adoption by direction', () => {
    expect(lineQualifier(['adopted'], 'adopted')).toBe('adopted');
  });
});

describe('siblingKind with a shared parent who is birth parent to neither (#296 review)', () => {
  it('is full when both are adopted or step to the other parent', () => {
    expect(
      siblingKind([
        ['biological', 'biological'],
        ['adopted', 'adopted'],
      ]),
    ).toBe('full');
    expect(
      siblingKind([
        ['biological', 'biological'],
        ['step', 'step'],
      ]),
    ).toBe('full');
  });

  it('is half when that parent is birth parent to exactly one', () => {
    expect(
      siblingKind([
        ['biological', 'biological'],
        ['adopted', 'biological'],
      ]),
    ).toBe('half');
  });
});
