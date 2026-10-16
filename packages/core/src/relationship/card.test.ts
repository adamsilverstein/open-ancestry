import { describe, expect, it } from 'vitest';
import type { ChildRelation, Sex } from '../layout/types';
import { cardTerm, kinshipGraph, relationship } from './index';
import type { CardStep } from './index';
import { GraphBuilder } from './test-family';

function up(rel?: 'biological' | 'adopted' | 'step' | 'foster' | 'guardian' | 'related'): CardStep {
  return rel ? { step: 'U', rel } : { step: 'U' };
}
function down(rel?: 'biological' | 'adopted' | 'step' | 'foster' | 'guardian'): CardStep {
  return rel ? { step: 'D', rel } : { step: 'D' };
}
const B = (kind?: 'full' | 'half' | 'adopted' | 'step' | 'foster', sex?: Sex): CardStep => ({
  step: 'B',
  ...(kind && { kind }),
  ...(sex && { sex }),
});
const S = (sex?: Sex): CardStep => ({ step: 'S', ...(sex && { sex }) });

// [label, path from the focus to the card, card sex, term]
const ROWS: [string, CardStep[], Sex, string | undefined][] = [
  ['focus', [], 'M', undefined],
  ['father', [up()], 'M', 'father'],
  ['stepfather', [up('step')], 'M', 'stepfather'],
  ['step-grandmother', [up('step'), up()], 'F', 'step-grandmother'],
  ['grandmother through a stepfather', [up('step'), up('biological')], 'F', 'step-grandmother'],
  ['adoptive father', [up('adopted')], 'M', 'adoptive father'],
  ['adopted son', [down('adopted')], 'M', 'adopted son'],
  ['foster mother', [up('foster')], 'F', 'foster mother'],
  ['guardian', [up('guardian')], 'F', 'guardian'],
  ['related reads as guardian', [up('related')], 'M', 'guardian'],
  ['ward', [down('guardian')], 'M', 'ward'],
  ['grandson', [down(), down()], 'M', 'grandson'],
  ['sister', [B()], 'F', 'sister'],
  ['half-sister', [B('half')], 'F', 'half-sister'],
  ['stepbrother', [B('step')], 'M', 'stepbrother'],
  ['adopted brother', [B('adopted')], 'M', 'adopted brother'],
  ['foster sister', [B('foster')], 'F', 'foster sister'],
  ['aunt', [up(), B()], 'F', 'aunt'],
  ['half-uncle', [up(), B('half')], 'M', 'half-uncle'],
  ['step-aunt (a stepfather’s sister)', [up('step'), B()], 'F', 'step-aunt'],
  ['granduncle', [up(), up(), B()], 'M', 'granduncle'],
  ['nephew', [B(), down()], 'M', 'nephew'],
  ['1st cousin', [up(), B(), down()], 'F', '1st cousin'],
  ['step-first cousin', [up('step'), B(), down()], 'M', 'step-first cousin'],
  ['half first cousin', [up(), B('half'), down()], 'F', 'half first cousin'],
  ['2nd cousin 1x removed', [up(), up(), up(), B(), down(), down()], 'M', '2nd cousin 1x removed'],
  ['wife', [S()], 'F', 'wife'],
  ['father-in-law', [S(), up()], 'M', 'father-in-law'],
  ['sister-in-law (spouse’s sister)', [S(), B()], 'F', 'sister-in-law'],
  ['sister-in-law (brother’s wife)', [B('full', 'M'), S()], 'F', 'sister-in-law'],
  ['daughter-in-law', [down(), S()], 'F', 'daughter-in-law'],
  ['stepmother (father’s wife)', [up(), S()], 'F', 'stepmother'],
  ['stepson (spouse’s son)', [S(), down()], 'M', 'stepson'],
  ['wife of uncle', [up(), B('full', 'M'), S()], 'F', 'wife of uncle'],
  ['sister of wife of uncle', [up(), B('full', 'M'), S('F'), B()], 'F', 'sister of wife of uncle'],
  ['an odd shape', [down(), up()], 'M', undefined],
  // Up then down without a sibling step proves one shared ancestor, not a full sibling.
  ['up then down, no sibling step', [up(), down()], 'M', undefined],
  ['up twice, down twice, no sibling step', [up(), up(), down(), down()], 'F', undefined],
];

type Child = NonNullable<Parameters<GraphBuilder['family']>[3]>[number];

/**
 * The child's link to the other partner: a stepparent's partner is a birth
 * parent, while adoptive, foster and guardian couples share the link.
 */
const otherLink = (rel: ChildRelation | undefined): ChildRelation =>
  rel === 'adopted' || rel === 'foster' || rel === 'guardian' || rel === 'related'
    ? rel
    : 'biological';

/**
 * A family in which `path` really leads from the focus (`n0`) to the card, so
 * cardTerm can be checked against the calculator on the same people.
 */
function graphFor(path: CardStep[], cardSex: Sex) {
  const b = new GraphBuilder();
  let people = 0;
  let families = 0;
  const node = (sex: Sex = 'U') => {
    const id = `n${people++}`;
    b.person(id, sex);
    return id;
  };
  // Families go to the builder at the end, after siblings have joined them.
  const all: { id: string; p1: string | null; p2: string | null; children: Child[] }[] = [];
  const family = (p1: string | null, p2: string | null, children: Child[] = []) => {
    const f = { id: `F${families++}`, p1, p2, children };
    all.push(f);
    return f;
  };
  const parentFamily = new Map<string, ReturnType<typeof family>>();
  const parentsOf = (id: string) => {
    let f = parentFamily.get(id);
    if (!f) parentFamily.set(id, (f = family(node(), node(), [id])));
    return f;
  };
  let current = node();
  path.forEach((step, i) => {
    const sex = i === path.length - 1 ? cardSex : (step.sex ?? 'U');
    if (step.step === 'U') {
      const parent = node(sex);
      parentFamily.set(
        current,
        family(parent, node(), [[current, step.rel ?? 'biological', otherLink(step.rel)]]),
      );
      current = parent;
    } else if (step.step === 'D') {
      const child = node(sex);
      family(current, node(), [[child, step.rel ?? 'biological', otherLink(step.rel)]]);
      current = child;
    } else if (step.step === 'S') {
      const partner = node(sex);
      family(current, partner);
      current = partner;
    } else if (step.step === 'B') {
      const shared = parentsOf(current);
      const sibling = node(sex);
      const kind = step.kind ?? 'full';
      if (kind === 'full') shared.children.push(sibling);
      else if (kind === 'adopted' || kind === 'foster') shared.children.push([sibling, kind]);
      else if (kind === 'half') family(shared.p1, node(), [sibling]);
      else {
        // A stepsibling: the child of someone who married one of my parents.
        const other = node();
        family(other, null, [sibling]);
        family(shared.p1, other);
      }
      current = sibling;
    }
  });
  for (const f of all) b.family(f.id, f.p1, f.p2, f.children);
  return { graph: kinshipGraph(b.build()), card: current };
}

describe('cardTerm', () => {
  it.each(ROWS)('%s', (_label, path, sex, term) => {
    expect(cardTerm(path, sex)).toBe(term);
  });

  it.each(ROWS.filter((row) => row[3] !== undefined))(
    '%s matches the calculator on a real family',
    (_label, path, sex, term) => {
      const { graph, card } = graphFor(path, sex);
      expect(relationship(graph, card, 'n0').name).toBe(term);
    },
  );

  it('works out the sibling kind from shared parents', () => {
    const b = 'biological' as const;
    // My stepfather's son by an earlier marriage: no shared parent.
    const stepbrother: CardStep = {
      step: 'B',
      shared: [
        [b, 'step'],
        ['step', b],
      ],
    };
    expect(cardTerm([stepbrother], 'M')).toBe('stepbrother');
    // My mother's daughter by another partner.
    const half: CardStep = { step: 'B', shared: [[b, b]], apart: true };
    expect(cardTerm([half], 'F')).toBe('half-sister');
    expect(
      cardTerm(
        [
          {
            step: 'B',
            shared: [
              [b, b],
              [b, b],
            ],
          },
        ],
        'F',
      ),
    ).toBe('sister');
  });

  it('uses the formal style when asked', () => {
    expect(cardTerm([up(), up(), B()], 'M', 'formal')).toBe('great-uncle');
    expect(cardTerm([up(), B('full', 'M'), S()], 'F', 'formal')).toBe('aunt by marriage');
  });
});
