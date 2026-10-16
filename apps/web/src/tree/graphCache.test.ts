import { describe, expect, it } from 'vitest';
import {
  indexGraph,
  layoutFamily,
  layoutFan,
  layoutPedigree,
  type ChildRelation,
} from '@open-ancestry/core';
import { GraphCache } from './graphCache';
import { buildRelations, kinshipLabels } from './relations';
import type { ApiNeighborhood, ApiPersonSummary } from './api';

const summary = (id: string, extra: Partial<ApiPersonSummary> = {}): ApiPersonSummary => ({
  id,
  sex: 'M',
  living: 'dead',
  privacy: 'public',
  primaryMediaId: null,
  primaryPhotoLocal: false,
  primaryPhotoVersion: null,
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

/** Deterministic pseudo-random numbers (mulberry32), so failures reproduce. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RELS: ChildRelation[] = ['biological', 'biological', 'adopted', 'step', 'foster', 'unknown'];

/** Messy slices: missing partners, a person as both partners, children of unloaded families. */
function randomSlices(seed: number, count: number): ApiNeighborhood[] {
  const rnd = random(seed);
  const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)]!;
  const ids = Array.from({ length: 40 }, (_, i) => `p${i}`);
  const fams = Array.from({ length: 25 }, (_, i) => `f${i}`);
  const maybe = () => (rnd() < 0.15 ? null : pick(ids));
  return Array.from({ length: count }, (_, s) => {
    const p1 = maybe();
    return {
      focusId: pick(ids),
      people: ids
        .filter(() => rnd() < 0.3)
        .map((id) => summary(id, { sex: rnd() < 0.5 ? 'M' : 'F' })),
      families: fams
        .filter(() => rnd() < 0.25)
        .map((id) => ({
          ...family(id, rnd() < 0.1 ? p1 : maybe(), rnd() < 0.1 ? p1 : maybe()),
          partner1Order: Math.floor(rnd() * 3),
          partner2Order: Math.floor(rnd() * 3),
        })),
      children: Array.from({ length: 12 }, () => ({
        ...child(pick(fams), pick(ids), rnd() < 0.5),
        partner1Rel: pick(RELS),
        partner2Rel: pick(RELS),
        sortOrder: Math.floor(rnd() * 4),
        childOrder: Math.floor(rnd() * 3),
      })),
      moreUp: ids.filter(() => rnd() < 0.1),
      moreDown: ids.filter(() => rnd() < 0.1),
      truncated: s % 2 === 0,
    };
  });
}

describe('GraphCache.index', () => {
  const famIds = (list: readonly { id: string }[]) => list.map((f) => f.id);

  it('answers exactly as indexing the merged graph would', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const cache = new GraphCache();
      for (const slice of randomSlices(seed, 4)) {
        cache.merge(slice);
        const expected = indexGraph(cache.graph());
        const actual = cache.index();
        for (let i = 0; i < 42; i++) {
          const id = `p${i}`;
          expect(actual.person(id), `${seed} ${id}`).toEqual(expected.person(id));
          expect(famIds(actual.parentFamilies(id)), `${seed} ${id} up`).toEqual(
            famIds(expected.parentFamilies(id)),
          );
          expect(famIds(actual.partnerFamilies(id)), `${seed} ${id} spouses`).toEqual(
            famIds(expected.partnerFamilies(id)),
          );
        }
        // Families are looked up by id, so the graph's own objects work too.
        for (const f of cache.graph().families) {
          expect(actual.partners(f), `${seed} ${f.id}`).toEqual(expected.partners(f));
          expect(actual.children(f), `${seed} ${f.id}`).toEqual(expected.children(f));
          for (const c of f.children) {
            expect(actual.entry(f, c.id)).toEqual(expected.entry(f, c.id));
          }
        }
      }
    }
  });

  it('lays out the same as the merged graph', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const cache = new GraphCache();
      for (const slice of randomSlices(seed, 4)) cache.merge(slice);
      for (let i = 0; i < 40; i += 3) {
        const id = `p${i}`;
        const options = { ancestorsDepth: 3, descendantsDepth: 3 };
        expect(layoutFamily(cache.index(), id, options)).toEqual(
          layoutFamily(cache.graph(), id, options),
        );
        expect(layoutPedigree(cache.index(), id, options)).toEqual(
          layoutPedigree(cache.graph(), id, options),
        );
        expect(layoutFan(cache.index(), id)).toEqual(layoutFan(cache.graph(), id));
      }
    }
  });

  it('labels kin from the index as from the merged graph (step, adopted links)', () => {
    // Mixed sexes, so gendered words (stepmother, adopted daughter) are compared too.
    const sex = (key: string) => (Number(key.replace(/\D/g, '')) % 2 ? 'F' : 'M');
    for (let seed = 1; seed <= 20; seed++) {
      const cache = new GraphCache();
      for (const slice of randomSlices(seed, 4)) {
        cache.merge(slice);
        const index = cache.index();
        const graph = cache.graph();
        for (const f of graph.families) expect(index.family(f.id)?.id).toBe(f.id);
        expect(index.family('nope')).toBeUndefined();
        for (let i = 0; i < 40; i += 3) {
          for (const layout of [
            layoutFamily(index, `p${i}`, {}),
            layoutPedigree(index, `p${i}`, {}),
          ]) {
            if (!layout.focusKey) continue;
            expect(kinshipLabels(buildRelations(layout, index), layout.focusKey, sex)).toEqual(
              kinshipLabels(buildRelations(layout, graph), layout.focusKey, sex),
            );
          }
        }
      }
    }
  });

  it('lays out a small view in time that does not grow with everything merged', () => {
    /** Ada's family plus `extra` unrelated people (couples with a child). */
    const sized = (extra: number) => {
      const cache = new GraphCache();
      cache.merge(first);
      const people: ApiPersonSummary[] = [];
      const families: ReturnType<typeof family>[] = [];
      const children: ReturnType<typeof child>[] = [];
      for (let i = 0; i < extra; i += 3) {
        people.push(summary(`x${i}`), summary(`x${i + 1}`, { sex: 'F' }), summary(`x${i + 2}`));
        families.push(family(`xf${i}`, `x${i}`, `x${i + 1}`));
        children.push(child(`xf${i}`, `x${i + 2}`));
      }
      cache.merge({ ...first, people, families, children, moreUp: [], moreDown: [] });
      return cache;
    };
    /** Median time of a new slice arriving, then a layout of Ada's view. */
    const time = (cache: GraphCache) => {
      layoutFamily(cache.index(), 'ada');
      const runs: number[] = [];
      for (let i = 0; i < 7; i++) {
        const start = performance.now();
        cache.merge({ ...first, people: [summary(`new${i}`)], families: [], children: [] });
        layoutFamily(cache.index(), 'ada');
        runs.push(performance.now() - start);
      }
      return runs.sort((a, b) => a - b)[3]!;
    };
    const small = time(sized(1_000));
    const large = time(sized(100_000));
    // Within 2x, with a little slack for timer noise at sub-millisecond times.
    expect(large).toBeLessThan(Math.max(2 * small, small + 2));
  });
});
