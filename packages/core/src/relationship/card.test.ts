import { describe, expect, it } from 'vitest';
import type { Sex } from '../layout/types';
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

describe('cardTerm', () => {
  // [path from the focus to the card, card sex, term]
  it.each<[string, CardStep[], Sex, string | undefined]>([
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
    [
      '2nd cousin 1x removed',
      [up(), up(), up(), B(), down(), down()],
      'M',
      '2nd cousin 1x removed',
    ],
    ['wife', [S()], 'F', 'wife'],
    ['father-in-law', [S(), up()], 'M', 'father-in-law'],
    ['sister-in-law (spouse’s sister)', [S(), B()], 'F', 'sister-in-law'],
    ['sister-in-law (brother’s wife)', [B('full', 'M'), S()], 'F', 'sister-in-law'],
    ['daughter-in-law', [down(), S()], 'F', 'daughter-in-law'],
    ['stepmother (father’s wife)', [up(), S()], 'F', 'stepmother'],
    ['stepson (spouse’s son)', [S(), down()], 'M', 'stepson'],
    ['wife of uncle', [up(), B('full', 'M'), S()], 'F', 'wife of uncle'],
    [
      'sister of wife of uncle',
      [up(), B('full', 'M'), S('F'), B()],
      'F',
      'sister of wife of uncle',
    ],
    ['an odd shape', [down(), up()], 'M', undefined],
  ])('%s', (_label, path, sex, term) => {
    expect(cardTerm(path, sex)).toBe(term);
  });

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

  it('agrees with the calculator', () => {
    const g = kinshipGraph(
      new GraphBuilder()
        .person('gf', 'M')
        .person('gm', 'F')
        .person('dad', 'M')
        .person('stepdad', 'M')
        .person('mom', 'F')
        .person('aunt', 'F')
        .person('me', 'F')
        .person('cousin', 'M')
        .person('sdSis', 'F')
        .person('sdParent', 'F')
        .family('Fg', 'gf', 'gm', ['dad', 'aunt'])
        .family('Fa', null, 'aunt', ['cousin'])
        .family('Fs', null, 'sdParent', ['stepdad', 'sdSis'])
        .family('Fp', 'dad', 'mom', ['me'])
        .family('Fq', 'stepdad', 'mom', [['me', 'step', 'biological']])
        .build(),
    );
    const cases: [string, CardStep[], Sex][] = [
      ['aunt', [up(), B()], 'F'],
      ['cousin', [up(), B(), down()], 'M'],
      ['gm', [up(), up()], 'F'],
      ['stepdad', [up('step')], 'M'],
      ['sdSis', [up('step'), B()], 'F'],
    ];
    for (const [who, path, sex] of cases) {
      expect(cardTerm(path, sex)).toBe(relationship(g, who, 'me').name);
    }
  });
});
