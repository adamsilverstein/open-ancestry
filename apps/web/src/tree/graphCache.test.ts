import { describe, expect, it } from 'vitest';
import { GraphCache } from './graphCache';
import type { ApiNeighborhood, ApiPersonSummary } from './api';

const summary = (id: string, extra: Partial<ApiPersonSummary> = {}): ApiPersonSummary => ({
  id,
  sex: 'M',
  living: 'dead',
  privacy: 'public',
  primaryMediaId: null,
  given: id,
  surname: 'Vale',
  surnamePrefix: null,
  prefix: null,
  suffix: null,
  nickname: null,
  birth: null,
  death: null,
  ...extra,
});

const family = (id: string, p1: string | null, p2: string | null) => ({
  id,
  partner1Id: p1,
  partner2Id: p2,
  relationshipType: 'married' as const,
  partner1Order: 0,
  partner2Order: 0,
});
const child = (familyId: string, childId: string, isPreferred = true) => ({
  familyId,
  childId,
  partner1Rel: 'biological' as const,
  partner2Rel: 'biological' as const,
  sortOrder: 0,
  childOrder: 0,
  isPreferred,
});

const first: ApiNeighborhood = {
  focusId: 'ada',
  people: [summary('ada'), summary('bram'), summary('elsa', { sex: 'F' })],
  families: [family('f1', 'bram', 'elsa')],
  children: [child('f1', 'ada')],
  moreUp: ['bram'],
  moreDown: ['ada'],
  truncated: false,
};

describe('GraphCache', () => {
  it('merges neighborhoods and bumps its version only on change', () => {
    const cache = new GraphCache();
    expect(cache.merge(first)).toBe(true);
    const v = cache.version;
    expect(cache.merge(first)).toBe(false);
    expect(cache.version).toBe(v);
    expect(cache.summary('elsa')?.sex).toBe('F');
    expect(cache.has('ada')).toBe(true);
    expect(cache.has('zed')).toBe(false);
  });

  it('keeps hasMore hints until the missing relatives arrive', () => {
    const cache = new GraphCache();
    cache.merge(first);
    expect(cache.needsParents('bram')).toBe(true);
    expect(cache.needsChildren('ada')).toBe(true);
    const graph = cache.graph();
    const people = graph.people as ReadonlyMap<string, { hasMoreParents?: boolean }>;
    expect(people.get('bram')?.hasMoreParents).toBe(true);

    cache.merge({
      focusId: 'bram',
      people: [summary('bram'), summary('otto')],
      families: [family('f0', 'otto', null)],
      children: [child('f0', 'bram')],
      moreUp: ['otto'],
      moreDown: [],
      truncated: false,
    });
    expect(cache.needsParents('bram')).toBe(false);
    expect(cache.needsParents('otto')).toBe(true);
    expect(cache.graph().families).toHaveLength(2);
  });

  it('clears the children hint once a partner family has children', () => {
    const cache = new GraphCache();
    cache.merge(first);
    cache.merge({
      focusId: 'ada',
      people: [summary('ada'), summary('wren')],
      families: [family('f2', null, 'ada')],
      children: [child('f2', 'wren')],
      moreUp: [],
      moreDown: [],
      truncated: false,
    });
    expect(cache.needsChildren('ada')).toBe(false);
  });

  it('memoizes the graph per version', () => {
    const cache = new GraphCache();
    cache.merge(first);
    expect(cache.graph()).toBe(cache.graph());
  });

  it('lists the preferred parents of a person', () => {
    const cache = new GraphCache();
    cache.merge(first);
    expect(cache.parentsOf('ada')).toEqual(['bram', 'elsa']);
    expect(cache.parentsOf('bram')).toEqual([]);
  });

  it('snapshots everything merged as one slice for a new worker', () => {
    const cache = new GraphCache();
    cache.merge(first);
    const copy = new GraphCache();
    copy.merge(cache.snapshot());
    expect(copy.input()).toEqual(cache.input());
  });
});
