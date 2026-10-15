/** Issue #128: a parent's spouse is a step-parent only if the marriage overlapped the child's life. */
import { describe, expect, it } from 'vitest';
import { kinshipGraph, relationship } from './index';
import type { KinshipGraph, Span } from './index';
import { GraphBuilder } from './test-family';

const y = (year: number) => year * 10000 + 701;
const span = (start?: number, end?: number): Span => ({
  ...(start !== undefined && { start: y(start) }),
  ...(end !== undefined && { end: y(end) }),
});

/*
 * Edith married Arthur (1918, ended by his death in 1925): son George, 1919.
 * Edith then married Leopold (1928): daughter Iris, 1930. Leopold had a son
 * Cyril with Wanda, and a daughter Nora who died in 1920 before he remarried.
 */
const base = new GraphBuilder()
  .person('arthur', 'M')
  .person('edith', 'F')
  .person('leopold', 'M')
  .person('wanda', 'F')
  .person('george', 'M')
  .person('iris', 'F')
  .person('cyril', 'M')
  .person('nora', 'F')
  .family('F6', 'arthur', 'edith', ['george'])
  .family('F7', 'leopold', 'edith', ['iris'])
  .family('F8', 'leopold', 'wanda', ['cyril', 'nora'])
  .build();

const lives: Record<string, Span> = {
  arthur: span(1890, 1925),
  edith: span(1895, 1980),
  leopold: span(1895, 1970),
  wanda: span(1897, 1926),
  george: span(1919, 1990),
  iris: span(1930, 2020),
  cyril: span(1922, 2000),
  nora: span(1919, 1920),
};
const unions: Record<string, Span> = {
  F6: span(1918, 1925),
  F7: span(1928),
  F8: span(1918, 1926),
};

const dated: KinshipGraph = {
  ...kinshipGraph(base),
  lifespan: (id) => lives[id],
  union: (familyId) => unions[familyId],
};
const undated = kinshipGraph(base);

describe('step relationships need an overlapping marriage', () => {
  // [A, B, Ancestry name, formal name when it differs]
  it.each<[string, string, string, string?]>([
    // Arthur died before Iris was born: never her stepfather.
    ['arthur', 'iris', 'husband of mother', 'mother’s husband'],
    ['iris', 'arthur', 'daughter of wife', 'wife’s daughter'],
    // Leopold married Edith during George's life.
    ['leopold', 'george', 'stepfather'],
    ['george', 'leopold', 'stepson'],
    ['cyril', 'george', 'stepbrother'],
    // Nora died before the marriage that would have made them step-siblings.
    ['nora', 'george', 'daughter of husband of mother', 'mother’s husband’s daughter'],
    ['george', 'iris', 'half-brother'],
  ])('%s is %s’s %s', (a, b, ancestry, formal = ancestry) => {
    expect(relationship(dated, a, b).name).toBe(ancestry);
    expect(relationship(dated, a, b, { style: 'formal' }).name).toBe(formal);
  });

  it('assumes an overlap when dates are missing', () => {
    expect(relationship(undated, 'arthur', 'iris').name).toBe('stepfather');
    expect(relationship(undated, 'nora', 'george').name).toBe('stepsister');
    const partial: KinshipGraph = {
      ...undated,
      lifespan: (id) => lives[id],
      union: () => undefined,
    };
    expect(relationship(partial, 'arthur', 'iris').name).toBe('stepfather');
  });
});
