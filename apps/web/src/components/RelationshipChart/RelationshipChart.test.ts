import { describe, expect, it } from 'vitest';
import type { ChildRelation } from '@open-ancestry/core';
import type { PersonSummary } from '../../lib/person';
import type { RelationshipChartCell } from './RelationshipChart';
import { stepText } from './RelationshipChart';

const cell = (
  name: string,
  sex: PersonSummary['sex'],
  step?: RelationshipChartCell['step'],
  rel?: ChildRelation,
): RelationshipChartCell => ({
  person: { id: name, name, sex },
  row: 0,
  col: 0,
  role: 'between',
  ...(step && { step }),
  ...(rel && { rel }),
});

const george = cell('George Eldermoor', 'M');

describe('stepText', () => {
  // [sex of the card, its step from the previous card, link, text] (issue #128).
  it.each<[PersonSummary['sex'], RelationshipChartCell['step'], ChildRelation | undefined, string]>(
    [
      ['M', 'parent', 'step', 'stepfather of George Eldermoor'],
      ['F', 'parent', 'step', 'stepmother of George Eldermoor'],
      ['M', 'child', 'step', 'stepson of George Eldermoor'],
      ['F', 'child', 'step', 'stepdaughter of George Eldermoor'],
      ['U', 'child', 'step', 'stepchild of George Eldermoor'],
      ['F', 'parent', 'adopted', 'adoptive mother of George Eldermoor'],
      ['M', 'child', 'adopted', 'adopted son of George Eldermoor'],
      ['F', 'child', 'foster', 'foster daughter of George Eldermoor'],
      ['M', 'parent', 'biological', 'father of George Eldermoor'],
      ['F', 'spouse', undefined, 'wife of George Eldermoor'],
    ],
  )('a %s %s by a %s link reads "%s"', (sex, step, rel, text) => {
    expect(stepText(cell('Card', sex, step, rel), george)).toBe(text);
  });

  it('reads "This person" for the first card', () => {
    expect(stepText(george, undefined)).toBe('This person');
  });
});
