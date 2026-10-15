/** Guardian and `related` links read the same in the calculator as on the person page (core kin). */
import { describe, expect, it } from 'vitest';
import { childWord, parentWord } from '../kin';
import { kinshipGraph, relationship } from './index';
import { GraphBuilder } from './test-family';

const g = kinshipGraph(
  new GraphBuilder()
    .person('gran', 'F')
    .person('aunt', 'F')
    .person('ward', 'M')
    .person('cousin', 'M')
    .person('ward2', 'F')
    .family('Fg', null, 'gran', ['aunt'])
    .family('Fa', null, 'aunt', [['ward', 'guardian'], 'cousin', ['ward2', 'related']])
    .build(),
);

describe('guardian links', () => {
  it.each([
    ['aunt', 'ward', 'guardian'],
    ['ward', 'aunt', 'ward'],
    ['aunt', 'ward2', 'guardian'],
    ['ward2', 'aunt', 'ward'],
    // Further out, care reads as foster, as kin's lineQualifier says.
    ['gran', 'ward', 'foster grandmother'],
    ['cousin', 'ward', 'foster brother'],
  ])('%s is %s’s %s', (a, b, name) => {
    expect(relationship(g, a, b).name).toBe(name);
  });

  it('matches the person page words for the direct link', () => {
    expect(relationship(g, 'aunt', 'ward').name).toBe(parentWord('F', 'guardian'));
    expect(relationship(g, 'ward', 'aunt').name).toBe(childWord('M', 'guardian'));
  });
});
