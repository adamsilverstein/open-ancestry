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

  it('does not also call a guardian couple step-parents', () => {
    const couple = kinshipGraph(
      new GraphBuilder()
        .person('g1', 'F')
        .person('g2', 'M')
        .person('kid', 'F')
        .family('Fg', 'g2', 'g1', [['kid', 'guardian']])
        .build(),
    );
    expect(relationship(couple, 'g1', 'kid').name).toBe('guardian');
    expect(relationship(couple, 'kid', 'g2').name).toBe('ward');
  });

  it('still calls a guardian married to the birth mother a stepfather too', () => {
    const family = kinshipGraph(
      new GraphBuilder()
        .person('guard', 'M')
        .person('mom', 'F')
        .person('kid', 'F')
        .family('Fm', 'guard', 'mom', [['kid', 'guardian', 'biological']])
        .build(),
    );
    expect(relationship(family, 'guard', 'kid').name).toBe('guardian and also stepfather');
    expect(relationship(family, 'kid', 'guard').name).toBe('ward and also stepdaughter');
    expect(relationship(family, 'mom', 'kid').name).toBe('mother');
  });
});
