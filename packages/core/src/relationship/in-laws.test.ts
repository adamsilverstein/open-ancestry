/** Issue #129: in-law ties are named beside blood ones. */
import { describe, expect, it } from 'vitest';
import { kinshipGraph, relationship } from './index';
import { GraphBuilder } from './test-family';

/*
 * Walter's parents are Josiah and Harriet; Mabel's are Josiah's sister Ada
 * and Harriet's brother Hugh. Walter and Mabel, double 1st cousins, marry.
 */
const g = kinshipGraph(
  new GraphBuilder()
    .person('gpA', 'M')
    .person('gmA', 'F')
    .person('gpB', 'M')
    .person('gmB', 'F')
    .person('josiah', 'M')
    .person('ada', 'F')
    .person('harriet', 'F')
    .person('hugh', 'M')
    .person('walter', 'M')
    .person('mabel', 'F')
    .person('kid', 'F')
    .family('FA', 'gpA', 'gmA', ['josiah', 'ada'])
    .family('FB', 'gpB', 'gmB', ['harriet', 'hugh'])
    .family('FW', 'josiah', 'harriet', ['walter'])
    .family('FM', 'hugh', 'ada', ['mabel'])
    .family('FWM', 'walter', 'mabel', ['kid'])
    .build(),
);

describe('in-law relationships beside blood ones', () => {
  it.each([
    ['walter', 'mabel', 'husband and also double 1st cousin'],
    ['mabel', 'walter', 'wife and also double 1st cousin'],
    ['harriet', 'mabel', 'aunt and also mother-in-law'],
    ['josiah', 'mabel', 'uncle and also father-in-law'],
    ['mabel', 'josiah', 'niece and also daughter-in-law'],
    ['mabel', 'harriet', 'niece and also daughter-in-law'],
    // A child of both partners is never also a stepdaughter (the cousin tie is real collapse).
    ['kid', 'mabel', 'daughter and also double 1st cousin 1x removed'],
    ['mabel', 'kid', 'mother and also double 1st cousin 1x removed'],
    ['hugh', 'walter', 'uncle and also father-in-law'],
  ])('%s is %s’s %s', (a, b, name) => {
    expect(relationship(g, a, b).name).toBe(name);
  });

  it('keeps the marriage path for each in-law name', () => {
    const r = relationship(g, 'harriet', 'mabel');
    expect(r.relationships.map((x) => x.kind)).toEqual(['blood', 'marriage']);
    expect(r.relationships[1]!.paths[0]).toEqual({
      ids: ['harriet', 'walter', 'mabel'],
      steps: [{ kind: 'child', rel: 'unknown' }, { kind: 'spouse' }],
    });
  });
});
