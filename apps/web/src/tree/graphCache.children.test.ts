// @vitest-environment node
/**
 * A person whose partner families were only partly loaded by
 * earlier slices (one family's line child) is treated as having all their
 * children loaded, so expanding them never fetches the rest.
 */
import { describe, expect, it } from 'vitest';
import { families, getNeighborhood, persons } from '@open-ancestry/db';
import { memoryTree } from '../../../../packages/db/src/test/helpers';
import { GraphCache } from './graphCache';
import type { ApiNeighborhood } from './api';

describe('GraphCache needsChildren with partly loaded families', () => {
  it('still needs children when only the line child of one of several families is loaded', () => {
    const store = memoryTree();
    const ids = store.transact('seed', (tx) => {
      const p = (given: string, sex: 'M' | 'F') =>
        persons.create(tx, { sex, names: [{ given, surname: 'Synth' }] }).id;
      const [ggf, ggm, g, s, sw, w1, w2, par, pw, u, h, x, xw, z, y] = [
        p('Ggf', 'M'),
        p('Ggm', 'F'),
        p('Gil', 'M'),
        p('Sim', 'M'),
        p('Sw', 'F'),
        p('Wa', 'F'),
        p('Wb', 'F'),
        p('Par', 'M'),
        p('Pw', 'F'),
        p('Una', 'F'),
        p('Hal', 'M'),
        p('Xan', 'M'),
        p('Xw', 'F'),
        p('Zed', 'M'),
        p('Yul', 'M'),
      ];
      families.create(tx, {
        partner1_id: ggf,
        partner2_id: ggm,
        children: [{ child_id: g! }, { child_id: s! }],
      });
      families.create(tx, { partner1_id: s, partner2_id: sw, children: [{ child_id: y! }] });
      families.create(tx, {
        partner1_id: g,
        partner2_id: w1,
        children: [{ child_id: par! }, { child_id: u! }],
      });
      families.create(tx, { partner1_id: g, partner2_id: w2, children: [{ child_id: h! }] });
      families.create(tx, { partner1_id: par, partner2_id: pw, children: [{ child_id: x! }] });
      families.create(tx, { partner1_id: x, partner2_id: xw, children: [{ child_id: z! }] });
      return { g: g!, u: u!, h: h!, z: z!, y: y! };
    }).result;
    const request = { up: 4, down: 3, siblingsDepth: 2 };
    const cache = new GraphCache();
    // Family view on Zed: Gil is a great-grandfather, so only his line child is loaded.
    cache.merge(getNeighborhood(store, ids.z, request) as unknown as ApiNeighborhood);
    // Family view on Yul: Gil is an uncle, a leaf sibling with children not fetched.
    const second = getNeighborhood(store, ids.y, request);
    expect(second.moreDown).toContain(ids.g);
    cache.merge(second as unknown as ApiNeighborhood);

    expect(cache.has(ids.u)).toBe(false);
    expect(cache.has(ids.h)).toBe(false);
    // Una and Hal were never loaded, so expanding Gil down must fetch.
    expect(cache.needsChildren(ids.g)).toBe(true);
    // Expanding fetches a slice on Gil: now every child of his is loaded.
    cache.merge(
      getNeighborhood(store, ids.g, {
        up: 0,
        down: 1,
        siblingsDepth: 0,
      }) as unknown as ApiNeighborhood,
    );
    expect(cache.has(ids.u) && cache.has(ids.h)).toBe(true);
    expect(cache.needsChildren(ids.g)).toBe(false);
    store.close();
  });
});

describe('GraphCache needsSiblings', () => {
  it('needs siblings a slice left out until a slice holds them', () => {
    const store = memoryTree();
    const ids = store.transact('seed', (tx) => {
      const p = (given: string) => persons.create(tx, { names: [{ given, surname: 'Synth' }] }).id;
      const [gp, dad, aunt, me] = [p('Gp'), p('Dad'), p('Aunt'), p('Me')];
      families.create(tx, { partner1_id: gp, children: [{ child_id: dad! }, { child_id: aunt! }] });
      families.create(tx, { partner1_id: dad, children: [{ child_id: me! }] });
      return { dad: dad!, aunt: aunt!, me: me! };
    }).result;
    const cache = new GraphCache();
    cache.merge(
      getNeighborhood(store, ids.me, {
        up: 2,
        down: 0,
        siblingsDepth: 1,
      }) as unknown as ApiNeighborhood,
    );
    expect(cache.needsSiblings(ids.dad)).toBe(true);
    expect(
      cache.graph().people instanceof Map &&
        (cache.graph().people as Map<string, { hasMoreSiblings?: boolean }>).get(ids.dad)
          ?.hasMoreSiblings,
    ).toBe(true);
    // Expanding fetches a slice on Dad with his siblings.
    cache.merge(
      getNeighborhood(store, ids.dad, {
        up: 1,
        down: 0,
        siblingsDepth: 1,
      }) as unknown as ApiNeighborhood,
    );
    expect(cache.has(ids.aunt)).toBe(true);
    expect(cache.needsSiblings(ids.dad)).toBe(false);
    store.close();
  });
});
