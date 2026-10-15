import { describe, expect, it } from 'vitest';
import type { ChildRelationship } from '@open-ancestry/db';
import type { PersonDetail } from '../api/types';
import { fixtureDetail } from './fixtureDetail.test-utils';
import { otherSiblings, parentIds } from './otherSiblings';

/** Clara's detail with an extra child, linked to her as `rel`, in her other partnership. */
function claraWith(given: string, rel: ChildRelationship): PersonDetail {
  const clara = fixtureDetail('clara');
  const rowan = fixtureDetail('rowan');
  const own = new Set(rowan.parentFamilies.map((f) => f.family.id));
  return {
    ...clara,
    partnerFamilies: clara.partnerFamilies.map((pf) => {
      if (own.has(pf.family.id)) return pf;
      const template = pf.children[0]!;
      const side = pf.family.partner1_id === clara.person.id ? 'partner1_rel' : 'partner2_rel';
      const other = side === 'partner1_rel' ? 'partner2_rel' : 'partner1_rel';
      return {
        ...pf,
        children: [
          ...pf.children,
          {
            person: { ...template.person, id: `extra-${given}`, given },
            link: { ...template.link, id: `link-${given}`, [side]: rel, [other]: 'biological' },
          },
        ],
      };
    }),
  };
}

describe('otherSiblings', () => {
  const rowan = fixtureDetail('rowan');
  const kinds = (parents: PersonDetail[]) =>
    otherSiblings(rowan, parents).map((s) => `${s.person.given}:${s.kind}`);

  it('finds children of a parent’s other partnership as half-siblings', () => {
    const parents = parentIds(rowan).map((id) =>
      id === fixtureDetail('edmund').person.id ? fixtureDetail('edmund') : fixtureDetail('clara'),
    );
    expect(kinds(parents)).toEqual(['Nell:half']);
  });

  it('calls a parent’s stepchild a step-sibling, not a half-sibling', () => {
    expect(kinds([claraWith('Silas', 'step')])).toEqual(['Nell:half', 'Silas:step']);
  });

  it('calls a parent’s foster or guardian child a foster sibling', () => {
    expect(kinds([claraWith('Finn', 'foster')])).toEqual(['Nell:half', 'Finn:foster']);
    expect(kinds([claraWith('Gwen', 'guardian')])).toEqual(['Nell:half', 'Gwen:foster']);
  });

  it('calls the parent’s adopted child an adopted sibling', () => {
    expect(kinds([claraWith('Ada', 'adopted')])).toEqual(['Nell:half', 'Ada:adopted']);
  });

  it('never repeats full siblings, the person or a sibling', () => {
    const clara = fixtureDetail('clara');
    expect(kinds([clara, clara])).toEqual(['Nell:half']);
    expect(otherSiblings(fixtureDetail('nell'), [clara]).map((s) => s.person.given)).toContain(
      'Rowan',
    );
  });
});
