/**
 * Card labels and the relationship calculator must never call the same two
 * people different things. Random families (seeded, so failures reproduce)
 * with remarriage and adopted, step, foster and guardian links, laid out
 * from many people; every card's label is checked against the calculator.
 */
import { describe, expect, it } from 'vitest';
import {
  kinshipGraph,
  layoutFamily,
  relationship,
  type ChildRelation,
  type TreeFamily,
  type TreeGraph,
  type TreePerson,
} from '@open-ancestry/core';
import { buildRelations, kinshipLabels } from './relations';

/** mulberry32: a small seeded PRNG. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ODD: ChildRelation[] = ['adopted', 'step', 'foster', 'guardian'];

/** Four generations from two founding couples; no one marries a relative. */
function family(seed: number): TreeGraph {
  const rnd = random(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const people = new Map<string, TreePerson>();
  const families: TreeFamily[] = [];
  let n = 0;
  const person = (sex: 'M' | 'F') => {
    const id = `p${n++}`;
    people.set(id, { id, sex, name: id, living: false });
    return id;
  };
  const link = (): { rel1?: ChildRelation; rel2?: ChildRelation } => {
    if (rnd() > 0.15) return {};
    const rel = pick(ODD);
    const r = rnd();
    return r < 0.4 ? { rel1: rel } : r < 0.8 ? { rel2: rel } : { rel1: rel, rel2: rel };
  };
  const couple = (a: string, b: string) => {
    const f: TreeFamily = { id: `f${families.length}`, partners: [a, b], children: [] };
    families.push(f);
    const count = 1 + Math.floor(rnd() * 3);
    const kids: string[] = [];
    for (let i = 0; i < count; i++) {
      const kid = person(rnd() < 0.5 ? 'M' : 'F');
      (f.children as TreeFamily['children'][number][]).push({ id: kid, ...link() });
      kids.push(kid);
    }
    return kids;
  };
  let generation = [person('M'), person('F'), person('M'), person('F')];
  let couples: [string, string][] = [
    [generation[0]!, generation[1]!],
    [generation[2]!, generation[3]!],
  ];
  for (let g = 0; g < 3; g++) {
    const next: string[] = [];
    for (const [a, b] of couples) {
      next.push(...couple(a, b));
      // A remarriage now and then: half and step relatives.
      if (rnd() < 0.3) next.push(...couple(a, person(people.get(b)!.sex as 'M' | 'F')));
    }
    // Everyone in the next generation marries someone from outside.
    couples = next.map((id): [string, string] => {
      const sex = people.get(id)!.sex === 'M' ? 'F' : 'M';
      return sex === 'F' ? [id, person('F')] : [person('M'), id];
    });
    generation = next;
  }
  return { people, families };
}

describe('tree card labels match the relationship calculator', () => {
  it('on 40 random families, from every fourth person', () => {
    const diffs: string[] = [];
    let compared = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const g = family(seed);
      const kin = kinshipGraph(g);
      const people = g.people as ReadonlyMap<string, TreePerson>;
      const ids = [...people.keys()];
      for (let i = 0; i < ids.length; i += 4) {
        const focus = ids[i]!;
        const layout = layoutFamily(g, focus, { siblingsDepth: 2 });
        const labels = kinshipLabels(buildRelations(layout, g), layout.focusKey!, (k) => {
          return people.get(k.split('~')[0]!)?.sex ?? 'U';
        });
        for (const node of layout.nodes) {
          const label = labels[node.key];
          if (!label || node.isDuplicate) continue;
          const result = relationship(kin, node.personId, focus);
          const names = result.relationships.map((r) => r.name);
          // Several relationships (one person reached two ways): the card names one.
          if (names.length > 1 && names.includes(label)) continue;
          compared++;
          if (names[0] !== label)
            diffs.push(
              `seed ${seed} ${node.personId} to ${focus}: card "${label}", calculator "${names[0]}"`,
            );
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
    expect(diffs).toEqual([]);
  });
});
