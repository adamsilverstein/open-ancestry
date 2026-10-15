import { describe, expect, it } from 'vitest';
import type { ApiPersonSummary } from '../api/types';
import { fixtureDetail } from './fixtureDetail.test-utils';
import {
  fullName,
  initials,
  isLivingStatus,
  lifeDate,
  nearestRelative,
  toPersonSummary,
} from './person';

describe('initials', () => {
  it('uses the first and last name', () => {
    expect(initials('Eleanor May Whitcombe')).toBe('EW');
    expect(initials('  thaddeus  ')).toBe('T');
    expect(initials('')).toBe('?');
  });
});

const base: ApiPersonSummary = {
  id: 'X',
  sex: 'X',
  living: 'unknown',
  privacy: 'public',
  primaryMediaId: null,
  primaryPhotoLocal: false,
  given: null,
  surname: null,
  surnamePrefix: null,
  prefix: null,
  suffix: null,
  nickname: null,
  birth: null,
  death: null,
};

describe('API person adapters', () => {
  it('builds display names', () => {
    expect(fullName(fixtureDetail('rowan').summary)).toBe('Rowan Ashdown');
    expect(
      fullName({
        ...base,
        prefix: 'Dr.',
        given: 'Ada',
        surnamePrefix: 'van',
        surname: 'Dijk',
        suffix: 'Jr.',
      }),
    ).toBe('Dr. Ada van Dijk Jr.');
    expect(fullName(base)).toBe('Unknown name');
  });

  it('maps qualifiers and years from event briefs', () => {
    const brief = { eventId: 'e', type: 'BIRT', dateText: 'ABT 1879', place: null };
    expect(lifeDate({ ...brief, dateQualifier: 'about', dateSort: 18790701 })).toEqual({
      year: 1879,
      qualifier: 'abt',
    });
    expect(lifeDate({ ...brief, dateQualifier: 'exact', dateSort: 18800312 })).toEqual({
      year: 1880,
      qualifier: undefined,
    });
    expect(lifeDate({ ...brief, dateQualifier: null, dateSort: null })).toBeUndefined();
    expect(lifeDate(null)).toBeUndefined();
  });

  it('converts summaries for the design system components', () => {
    const rowan = toPersonSummary(fixtureDetail('rowan').summary);
    expect(rowan).toMatchObject({
      name: 'Rowan Ashdown',
      sex: 'M',
      birth: { year: 1880 },
      death: { year: 1950 },
      living: false,
    });
    expect(toPersonSummary({ ...base, living: 'living' })).toMatchObject({
      sex: 'U',
      living: true,
    });
  });

  it('treats unknown and inferred living as living', () => {
    expect(isLivingStatus('living')).toBe(true);
    expect(isLivingStatus('inferred_living')).toBe(true);
    expect(isLivingStatus('unknown')).toBe(true);
    expect(isLivingStatus('dead')).toBe(false);
    expect(isLivingStatus('inferred_dead')).toBe(false);
  });
});

describe('nearestRelative', () => {
  it('prefers a parent, then a partner, then nobody', () => {
    const rowan = fixtureDetail('rowan');
    const parent = rowan.parentFamilies[0]!;
    expect(nearestRelative(rowan)).toBe((parent.partner1 ?? parent.partner2)!.id);

    const noParents = { ...rowan, parentFamilies: [] };
    const partner = rowan.partnerFamilies.find((f) => f.partner)!.partner!;
    expect(nearestRelative(noParents)).toBe(partner.id);

    const childless = { ...noParents, partnerFamilies: [] };
    expect(nearestRelative(childless)).toBeUndefined();
  });

  const rowan = fixtureDetail('rowan');
  const someone = (id: string) => ({ ...rowan.summary, id });

  it('uses a single parent when the other is unknown', () => {
    const family = { ...rowan.parentFamilies[0]!, partner1: null, partner2: someone('mum') };
    expect(nearestRelative({ ...rowan, parentFamilies: [family] })).toBe('mum');
  });

  it('falls back to a child when there are no parents or partners', () => {
    const own = rowan.partnerFamilies[0]!;
    const family = {
      ...own,
      partner: null,
      children: [{ ...own.children[0]!, person: someone('kid') }],
    };
    expect(nearestRelative({ ...rowan, parentFamilies: [], partnerFamilies: [family] })).toBe(
      'kid',
    );
  });

  it('falls back to a sibling when the parents are unknown', () => {
    const parents = rowan.parentFamilies[0]!;
    const family = {
      ...parents,
      partner1: null,
      partner2: null,
      siblings: [{ ...parents.siblings[0]!, person: someone('sib') }],
    };
    expect(nearestRelative({ ...rowan, parentFamilies: [family], partnerFamilies: [] })).toBe(
      'sib',
    );
  });
});
