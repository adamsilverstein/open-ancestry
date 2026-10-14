import { describe, expect, it } from 'vitest';
import { ancestorGenerations, families, openMemoryTree, persons, wouldCreateCycle } from './index';

/*
 * Grandparents G1 and G2 have P; P and Q have C1 and C2. C1 marries R, whose
 * parent is G1's other child S (cousins marrying: pedigree collapse), and
 * they have D.
 */
function tree() {
  const store = openMemoryTree();
  const { result } = store.transact('seed', (tx) => {
    const p = (given: string) => persons.create(tx, { names: [{ given }] }).id;
    const [g1, g2, pp, q, c1, c2, s, r, d] = ['G1', 'G2', 'P', 'Q', 'C1', 'C2', 'S', 'R', 'D'].map(
      p,
    ) as [string, string, string, string, string, string, string, string, string];
    families.create(tx, {
      partner1_id: g1,
      partner2_id: g2,
      children: [{ child_id: pp }, { child_id: s }],
    });
    families.create(tx, {
      partner1_id: pp,
      partner2_id: q,
      children: [{ child_id: c1 }, { child_id: c2 }],
    });
    families.create(tx, { partner1_id: s, children: [{ child_id: r }] });
    families.create(tx, { partner1_id: c1, partner2_id: r, children: [{ child_id: d }] });
    return { g1, g2, pp, q, c1, c2, s, r, d };
  });
  return { store, ...result };
}

describe('ancestorGenerations', () => {
  it('counts generations down to a descendant, by the shortest line', () => {
    const t = tree();
    expect(ancestorGenerations(t.store, t.pp, t.c1)).toBe(1);
    expect(ancestorGenerations(t.store, t.g1, t.c1)).toBe(2);
    // G1 is D's great-grandparent through both C1 and R.
    expect(ancestorGenerations(t.store, t.g1, t.d)).toBe(3);
    expect(ancestorGenerations(t.store, t.s, t.d)).toBe(2);
  });

  it('is null for anyone who is not an ancestor, including the person themself', () => {
    const t = tree();
    expect(ancestorGenerations(t.store, t.c1, t.pp)).toBeNull();
    expect(ancestorGenerations(t.store, t.c1, t.c2)).toBeNull();
    expect(ancestorGenerations(t.store, t.q, t.r)).toBeNull();
    expect(ancestorGenerations(t.store, t.c1, t.c1)).toBeNull();
  });

  it('stops at a loop an imported file already has', () => {
    const t = tree();
    t.store.transact('loop', (tx) => {
      families.create(tx, { partner1_id: t.d, children: [{ child_id: t.g1 }] });
    });
    expect(ancestorGenerations(t.store, t.d, t.c1)).toBe(3);
    expect(ancestorGenerations(t.store, t.c2, t.g1)).toBeNull();
  });
});

describe('wouldCreateCycle', () => {
  it('refuses making a person their own parent or the parent of an ancestor', () => {
    const t = tree();
    expect(wouldCreateCycle(t.store, t.c1, t.c1)).toBe(true);
    expect(wouldCreateCycle(t.store, t.c1, t.pp)).toBe(true);
    expect(wouldCreateCycle(t.store, t.d, t.g2)).toBe(true);
  });

  it('allows ordinary links, including pedigree collapse', () => {
    const t = tree();
    expect(wouldCreateCycle(t.store, t.pp, t.r)).toBe(false);
    expect(wouldCreateCycle(t.store, t.c2, t.d)).toBe(false);
    expect(wouldCreateCycle(t.store, t.g1, t.d)).toBe(false);
  });
});
