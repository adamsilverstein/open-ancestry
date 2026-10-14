import { describe, expect, it } from 'vitest';
import { layoutFamily, type TreeGraph, type TreePerson } from '@open-ancestry/core';
import { buildRelations, kinship, kinshipLabels, neighbor } from './relations';

const person = (id: string, sex: 'M' | 'F'): TreePerson => ({ id, sex, name: id, living: false });
const sexes: Record<string, 'M' | 'F'> = {
  ada: 'F',
  bram: 'M',
  elsa: 'F',
  hugo: 'M',
  corin: 'M',
  wren: 'F',
  dax: 'M',
  otto: 'M',
  greta: 'F',
  fenn: 'M',
  abel: 'M',
  cora: 'F',
  juno: 'F',
};
const graph: TreeGraph = {
  people: Object.fromEntries(Object.entries(sexes).map(([id, sex]) => [id, person(id, sex)])),
  families: [
    { id: 'f-abel', partners: ['abel', 'cora'], children: [{ id: 'otto' }] },
    { id: 'f-otto', partners: ['otto', 'greta'], children: [{ id: 'fenn' }, { id: 'bram' }] },
    { id: 'f-bram', partners: ['bram', 'elsa'], children: [{ id: 'hugo' }, { id: 'ada' }] },
    { id: 'f-ada', partners: ['corin', 'ada'], children: [{ id: 'wren' }] },
    { id: 'f-wren', partners: ['dax', 'wren'], children: [{ id: 'juno' }] },
  ],
};
const layout = layoutFamily(graph, 'ada', {});
const relations = buildRelations(layout);
const sexOf = (key: string) => sexes[key.split('~')[0]!] ?? 'U';
const x = (key: string) => layout.nodes.find((n) => n.key === key)!.x;

describe('buildRelations', () => {
  it('links parents, children and partners from the layout edges', () => {
    expect(relations.parents.get('ada')).toEqual(['bram', 'elsa']);
    expect(relations.children.get('bram')).toEqual(expect.arrayContaining(['hugo', 'ada']));
    expect(relations.partners.get('ada')).toEqual(['corin']);
    expect(relations.partners.get('corin')).toEqual(['ada']);
  });
});

describe('neighbor', () => {
  it('moves up to a parent and down to a child', () => {
    expect(neighbor(relations, 'ada', 'up')).toBe('bram');
    expect(neighbor(relations, 'ada', 'down')).toBe('wren');
    expect(neighbor(relations, 'wren', 'up')).toBe('ada');
  });

  it('moves left and right to the nearest card in the same row', () => {
    const left = neighbor(relations, 'ada', 'left');
    const right = neighbor(relations, 'ada', 'right');
    for (const key of [left, right].filter(Boolean)) {
      expect(['hugo', 'corin']).toContain(key);
    }
    expect(left === null || x(left) < x('ada')).toBe(true);
    expect(right === null || x(right) > x('ada')).toBe(true);
  });

  it('returns null when there is nothing in that direction', () => {
    expect(neighbor(relations, 'juno', 'down')).toBeNull();
    expect(neighbor(relations, 'missing', 'up')).toBeNull();
  });
});

describe('kinship', () => {
  const k = (key: string) => kinship(relations, 'ada', key, sexOf);
  it('names direct ancestors and descendants', () => {
    expect(k('bram')).toBe('father');
    expect(k('elsa')).toBe('mother');
    expect(k('otto')).toBe('grandfather');
    expect(k('abel')).toBe('great-grandfather');
    expect(k('wren')).toBe('daughter');
    expect(k('juno')).toBe('granddaughter');
  });

  it('names spouses, siblings, aunts, uncles and in-laws', () => {
    expect(k('corin')).toBe('husband');
    expect(k('hugo')).toBe('brother');
    expect(k('fenn')).toBe('uncle');
    expect(k('dax')).toBe('son-in-law');
  });

  it('names nephews, nieces and cousins', () => {
    const wide: TreeGraph = {
      people: {
        ...graph.people,
        nico: person('nico', 'M'),
        cass: person('cass', 'F'),
      } as Record<string, TreePerson>,
      families: [
        ...graph.families,
        { id: 'f-hugo', partners: ['hugo', null], children: [{ id: 'nico' }] },
        { id: 'f-fenn', partners: ['fenn', null], children: [{ id: 'cass' }] },
      ],
    };
    const l = layoutFamily(wide, 'ada', { expanded: ['hugo:down', 'fenn:down'] });
    const r = buildRelations(l);
    const sex = (key: string) => (key === 'nico' ? 'M' : 'F');
    expect(kinship(r, 'ada', 'nico', sex)).toBe('nephew');
    expect(kinship(r, 'ada', 'cass', sex)).toBe('cousin');
  });

  it('returns null for the focus person and strangers', () => {
    expect(k('ada')).toBeNull();
    expect(k('nobody')).toBeNull();
  });

  it('counts great-greats with ordinals', async () => {
    const { ancestorTerm } = await import('./relations');
    expect(ancestorTerm(4, 'M')).toBe('2nd great-grandfather');
    expect(ancestorTerm(5, 'F')).toBe('3rd great-grandmother');
    expect(ancestorTerm(1, 'U')).toBe('parent');
  });
});

describe('kinshipLabels', () => {
  it('labels every related card in one walk, matching kinship()', () => {
    const labels = kinshipLabels(relations, 'ada', sexOf);
    expect(labels.ada).toBeUndefined();
    for (const node of layout.nodes) {
      expect(labels[node.key] ?? null).toBe(kinship(relations, 'ada', node.key, sexOf));
    }
    expect(labels.fenn).toBe('uncle');
    expect(kinshipLabels(relations, 'missing', sexOf)).toEqual({});
  });
});

describe('a very large family', () => {
  // Bad data the import accepts (one "unknown parents" family holding everyone).
  const kids = Array.from({ length: 3000 }, (_, i) => `k${i}`);
  const big: TreeGraph = {
    people: Object.fromEntries(
      ['dad', 'mum', ...kids].map((id) => [id, person(id, id === 'mum' ? 'F' : 'M')]),
    ),
    families: [{ id: 'f', partners: ['dad', 'mum'], children: kids.map((id) => ({ id })) }],
  };
  const male = (key: string) => (key.startsWith('mum') ? 'F' : 'M');

  it('links and labels 3,000 children in linear time', () => {
    for (const focus of ['dad', 'k1500']) {
      const layout = layoutFamily(big, focus, {});
      const start = performance.now();
      const rel = buildRelations(layout);
      const labels = kinshipLabels(rel, focus, male);
      const elapsed = performance.now() - start;
      expect(elapsed, `focus ${focus}`).toBeLessThan(100);
      if (focus === 'dad') {
        expect(labels.k0).toBe('son');
        expect(rel.children.get('dad')).toHaveLength(3000);
      } else {
        expect(labels.k0).toBe('brother');
        expect(labels.dad).toBe('father');
        expect(rel.parents.get('k1500')).toEqual(['dad', 'mum']);
      }
    }
  });
});
