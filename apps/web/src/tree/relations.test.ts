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
    expect(kinship(r, 'ada', 'cass', sex)).toBe('1st cousin');
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

describe('step, adoptive and foster links', () => {
  // George's birth parents are Arthur and Mary. Mary later married Leopold,
  // George's stepfather; their daughter Iris is George's half-sister.
  // Peter was adopted by Harold and Dorothy, whose son Thomas is his brother.
  const sex: Record<string, 'M' | 'F'> = {
    arthur: 'M',
    mary: 'F',
    leopold: 'M',
    george: 'M',
    iris: 'F',
    harold: 'M',
    dorothy: 'F',
    thomas: 'M',
    peter: 'M',
    walt: 'M',
    gil: 'M',
    nan: 'F',
    sue: 'F',
  };
  const kin: TreeGraph = {
    people: Object.fromEntries(Object.entries(sex).map(([id, s]) => [id, person(id, s)])),
    families: [
      {
        id: 'f-birth',
        partners: ['arthur', 'mary'],
        children: [{ id: 'george', preferred: true }],
      },
      {
        id: 'f-step',
        partners: ['leopold', 'mary'],
        children: [
          { id: 'george', rel1: 'step', rel2: 'biological' },
          { id: 'iris', rel1: 'biological', rel2: 'biological' },
        ],
      },
      { id: 'f-walt', partners: ['walt', null], children: [{ id: 'leopold' }] },
      {
        id: 'f-ash',
        partners: ['harold', 'dorothy'],
        children: [
          { id: 'thomas', rel1: 'biological', rel2: 'biological' },
          { id: 'peter', rel1: 'adopted', rel2: 'adopted' },
        ],
      },
      {
        id: 'f-foster',
        partners: ['gil', 'nan'],
        children: [
          { id: 'sue', rel1: 'foster', rel2: 'foster' },
          { id: 'george', rel1: 'foster', rel2: 'foster' },
        ],
      },
    ],
  };
  const sexOfKin = (key: string) => sex[key.split('~')[0]!] ?? 'U';
  const labels = (focus: string, options: Parameters<typeof layoutFamily>[2] = {}) => {
    const l = layoutFamily(kin, focus, options);
    return kinshipLabels(buildRelations(l, kin), l.focusKey!, sexOfKin);
  };

  it('names birth parents plainly', () => {
    const k = labels('george');
    expect(k.arthur).toBe('father');
    expect(k.mary).toBe('mother');
  });

  it('names a stepparent and keeps a half-sibling half in the step set', () => {
    const k = labels('george', { selectedParentFamilies: { george: 'f-step' } });
    expect(k.leopold).toBe('stepfather');
    expect(k.mary).toBe('mother');
    expect(k.iris).toBe('half-sister');
    // Further up through the step link.
    expect(k.walt).toBe('step-grandfather');
  });

  it('names adoptive parents, and the adoptive family’s children as siblings', () => {
    const k = labels('peter');
    expect(k.harold).toBe('adoptive father');
    expect(k.dorothy).toBe('adoptive mother');
    // Siblings through an adoption, in the relationship calculator's words.
    expect(k.thomas).toBe('adopted brother');
    const t = labels('thomas');
    expect(t.harold).toBe('father');
    expect(t.peter).toBe('adopted brother');
  });

  it('names foster parents and foster siblings', () => {
    const k = labels('george', { selectedParentFamilies: { george: 'f-foster' } });
    expect(k.gil).toBe('foster father');
    expect(k.nan).toBe('foster mother');
    expect(k.sue).toBe('foster sister');
  });

  it('names stepsiblings who share no parent by birth or adoption', () => {
    const blended: TreeGraph = {
      people: { ...kin.people, ann: person('ann', 'F') } as Record<string, TreePerson>,
      families: [
        {
          id: 'f-blend',
          partners: ['leopold', 'mary'],
          children: [
            { id: 'george', rel1: 'step', rel2: 'biological' },
            { id: 'ann', rel1: 'biological', rel2: 'step' },
          ],
        },
      ],
    };
    const l = layoutFamily(blended, 'george', {});
    const k = kinshipLabels(buildRelations(l, blended), l.focusKey!, (key) =>
      key === 'ann' ? 'F' : 'M',
    );
    expect(k.ann).toBe('stepsister');
  });

  it('names the stepfather’s own family step-, never half- or plain (#157 review)', () => {
    const wide: TreeGraph = {
      people: {
        ...kin.people,
        ruth: person('ruth', 'F'),
        max: person('max', 'M'),
        hilda: person('hilda', 'F'),
        karl: person('karl', 'M'),
      } as Record<string, TreePerson>,
      families: [
        ...kin.families.filter((f) => f.id !== 'f-walt'),
        // Leopold's earlier marriage: Max is George's stepbrother.
        { id: 'f-ruth', partners: ['leopold', 'ruth'], children: [{ id: 'max' }] },
        // Leopold's sister Hilda and her son Karl: step-aunt and step-cousin.
        { id: 'f-walt', partners: ['walt', null], children: [{ id: 'leopold' }, { id: 'hilda' }] },
        { id: 'f-hilda', partners: [null, 'hilda'], children: [{ id: 'karl' }] },
      ],
    };
    const sexes2: Record<string, 'M' | 'F'> = {
      ...sex,
      ruth: 'F',
      max: 'M',
      hilda: 'F',
      karl: 'M',
    };
    const l = layoutFamily(wide, 'george', {
      selectedParentFamilies: { george: 'f-step' },
      expanded: ['hilda:down'],
    });
    const k = kinshipLabels(buildRelations(l, wide), l.focusKey!, (key) => sexes2[key] ?? 'U');
    expect(k.leopold).toBe('stepfather');
    expect(k.max).toBe('stepbrother');
    expect(k.hilda).toBe('step-aunt');
    expect(k.karl).toBe('step-first cousin');
    expect(k.iris).toBe('half-sister');
  });

  it('keeps a half-sister half when the stepfather adopted the child (#157 review)', () => {
    const adopted: TreeGraph = {
      people: kin.people,
      families: [
        { id: 'f-birth', partners: ['arthur', 'mary'], children: [{ id: 'george' }] },
        {
          id: 'f-step',
          partners: ['leopold', 'mary'],
          children: [
            { id: 'george', rel1: 'adopted', rel2: 'biological' },
            { id: 'iris', rel1: 'biological', rel2: 'biological' },
          ],
        },
      ],
    };
    for (const set of ['f-birth', 'f-step']) {
      const l = layoutFamily(adopted, 'george', { selectedParentFamilies: { george: set } });
      const k = kinshipLabels(buildRelations(l, adopted), l.focusKey!, sexOfKin);
      expect(k.iris, set).toBe('half-sister');
    }
  });

  it('names guardian links as the relationship calculator does', () => {
    const g: TreeGraph = {
      people: kin.people,
      families: [
        {
          id: 'f-guard',
          partners: ['harold', 'dorothy'],
          children: [
            { id: 'thomas', rel1: 'biological', rel2: 'biological' },
            { id: 'peter', rel1: 'guardian', rel2: 'guardian' },
          ],
        },
      ],
    };
    const l = layoutFamily(g, 'peter', {});
    const k = kinshipLabels(buildRelations(l, g), l.focusKey!, sexOfKin);
    // Guardianship is care, not parenthood: guardian, and the guardian's child a foster brother.
    expect(k.harold).toBe('guardian');
    expect(k.thomas).toBe('foster brother');
  });

  it('treats a missing relationship as by birth', () => {
    const k = labels('george', { selectedParentFamilies: { george: 'f-birth' } });
    expect(k.arthur).toBe('father');
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
      // Best of three, so a busy CI runner or a GC pause on one pass doesn't
      // fail it; a quadratic walk over 3,000 children is slow on every pass.
      let elapsed = Infinity;
      let rel = buildRelations(layout, big);
      let labels = kinshipLabels(rel, focus, male);
      for (let pass = 0; pass < 3; pass++) {
        const start = performance.now();
        rel = buildRelations(layout, big);
        labels = kinshipLabels(rel, focus, male);
        elapsed = Math.min(elapsed, performance.now() - start);
      }
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

describe('labels in a blended family', () => {
  // Remarriage (half siblings), an adopted and a step child, and a child (eve)
  // in two families, drawn in her preferred one. Hand-checked; a change to the
  // walk that lets a farther sibling-group member label first breaks these.
  const blended: Record<string, 'M' | 'F'> = {
    dad: 'M',
    mum: 'F',
    mum2: 'F',
    exh: 'M',
    ann: 'F',
    ben: 'M',
    ivy: 'F',
    cal: 'M',
    dee: 'F',
    eve: 'F',
    fox: 'M',
    gil: 'M',
    hal: 'M',
  };
  const g: TreeGraph = {
    people: Object.fromEntries(Object.entries(blended).map(([id, sex]) => [id, person(id, sex)])),
    families: [
      {
        id: 'f1',
        partners: ['dad', 'mum'],
        children: [
          { id: 'ann' },
          { id: 'ben', rel1: 'adopted', rel2: 'adopted' },
          { id: 'ivy', rel1: 'step' },
          { id: 'eve', order: 0, preferred: true },
        ],
      },
      { id: 'f2', partners: ['dad', 'mum2'], children: [{ id: 'cal' }] },
      { id: 'f3', partners: ['exh', 'mum2'], children: [{ id: 'dee' }] },
      { id: 'f4', partners: ['fox', null], children: [{ id: 'eve', order: 1 }, { id: 'gil' }] },
      { id: 'f5', partners: ['hal', 'ann'], children: [] },
    ],
  };
  const labels = (focus: string, withGraph = false) => {
    const l = layoutFamily(g, focus, {});
    const rel = buildRelations(l, withGraph ? g : undefined);
    return kinshipLabels(rel, l.focusKey!, (k) => blended[k.split('~')[0]!] ?? 'U');
  };

  it('names half, adopted and step siblings, and in-laws', () => {
    expect(labels('ann')).toMatchObject({
      ben: 'brother',
      ivy: 'sister',
      eve: 'sister',
      cal: 'half-brother',
      dad: 'father',
      mum: 'mother',
      hal: 'husband',
    });
    expect(labels('cal')).toMatchObject({
      ann: 'half-sister',
      ben: 'half-brother',
      eve: 'half-sister',
      dee: 'half-sister',
      hal: 'brother-in-law',
    });
    expect(labels('eve')).toMatchObject({
      ann: 'sister',
      cal: 'half-brother',
      hal: 'brother-in-law',
    });
    expect(labels('dad')).toMatchObject({ ivy: 'daughter', mum2: 'wife', hal: 'son-in-law' });
  });

  it('qualifies step and adopted links from the graph, first sibling to reach them deciding', () => {
    expect(labels('ann', true)).toMatchObject({
      ben: 'adopted brother',
      ivy: 'half-sister',
      cal: 'half-brother',
    });
    // Ben is Dad's son only by adoption: an adopted brother, as the calculator says.
    expect(labels('cal', true)).toMatchObject({ ivy: 'stepsister', ben: 'adopted brother' });
    expect(labels('dad', true)).toMatchObject({ ben: 'adopted son', ivy: 'stepdaughter' });
    expect(labels('ivy', true)).toMatchObject({ dad: 'stepfather', cal: 'stepbrother' });
    expect(labels('ben', true)).toMatchObject({ dad: 'adoptive father', ann: 'adopted sister' });
  });
});
