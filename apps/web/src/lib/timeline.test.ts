import { describe, expect, it } from 'vitest';
import { fixtureDetail } from './fixtureDetail.test-utils';
import { buildTimeline, filterTimeline, timelineCategories } from './timeline';

describe('buildTimeline', () => {
  const entries = buildTimeline(fixtureDetail('rowan'));

  it('sorts own and interleaved family events by date', () => {
    expect(entries.map((e) => e.title)).toEqual([
      'Birth',
      'Birth of brother Tobias Ashdown',
      'Residence',
      'Death of father Edmund Ashdown',
      'Marriage to Iris Vale',
      'Birth of daughter Lena Ashdown',
      'Birth of son Arthur Ashdown',
      'Occupation: Blacksmith',
      'Census',
      'Death of mother Clara Penhallow',
      'Death of wife Iris Vale',
      'Death of son Arthur Ashdown',
      'Death',
      'Burial',
    ]);
  });

  it('groups alternate facts under the preferred one', () => {
    const birth = entries[0]!;
    expect(birth.alternates.map((a) => a.date)).toEqual(['abt. 1879']);
    expect(birth.alternates[0]!.place).toBe('Wexmoor, Westmere');
  });

  it('formats dates, years, ages, places and source counts', () => {
    const marriage = entries.find((e) => e.title === 'Marriage to Iris Vale')!;
    expect(marriage).toMatchObject({
      kind: 'own',
      category: 'life',
      date: '14 Jun 1905',
      year: '1905',
      age: '25',
      place: 'Ashcombe, Eastholm',
    });
    expect(entries[0]).toMatchObject({ age: undefined, sourceCount: 1, year: '1880' });
    expect(entries.find((e) => e.title === 'Census')).toMatchObject({
      category: 'work',
      sourceCount: 1,
      // Year-only date: the age could be 30 or 31.
      age: 'about 31',
    });
    expect(entries.find((e) => e.title.startsWith('Death of father'))).toMatchObject({
      kind: 'family',
      category: 'family',
      personId: fixtureDetail('edmund').person.id,
    });
  });

  it('leaves out family events outside the lifetime', () => {
    expect(entries.some((e) => e.title.includes('Mabel'))).toBe(false);
  });

  it('dedupes relatives listed in several parent families', () => {
    const detail = fixtureDetail('rowan');
    const [family] = detail.parentFamilies;
    const twice = buildTimeline({
      ...detail,
      parentFamilies: [family!, { ...family!, family: { ...family!.family, id: 'adoptive' } }],
    });
    const ids = twice.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(twice.filter((e) => e.title === 'Birth of brother Tobias Ashdown')).toHaveLength(1);
  });

  it('names step and adoptive parents', () => {
    const detail = fixtureDetail('rowan');
    const [family] = detail.parentFamilies;
    const step = buildTimeline({
      ...detail,
      parentFamilies: [{ ...family!, link: { ...family!.link, partner1_rel: 'step' } }],
    });
    expect(step.map((e) => e.title)).toContain('Death of stepfather Edmund Ashdown');
    const adopted = buildTimeline({
      ...detail,
      parentFamilies: [{ ...family!, link: { ...family!.link, partner2_rel: 'adopted' } }],
    });
    expect(adopted.map((e) => e.title)).toContain('Death of adoptive mother Clara Penhallow');
  });

  it('adds half siblings passed in', () => {
    const nell = fixtureDetail('nell').summary;
    const titles = buildTimeline(fixtureDetail('rowan'), { halfSiblings: [nell] }).map(
      (e) => e.title,
    );
    expect(titles.indexOf('Birth of half sister Nell Marsh')).toBe(
      titles.indexOf('Death of father Edmund Ashdown') + 1,
    );
  });

  it('filters by category', () => {
    const visible = filterTimeline(entries, new Set(['family', 'work']));
    expect(visible.every((e) => e.category !== 'family' && e.category !== 'work')).toBe(true);
    expect(visible).toHaveLength(entries.length - 10);
    expect(timelineCategories.map((c) => c.label)).toEqual([
      'Life events',
      'Family events',
      'Residence and work',
      'Other',
    ]);
  });

  it('handles a person with no events', () => {
    const detail = fixtureDetail('lena');
    expect(
      buildTimeline({ ...detail, events: [], parentFamilies: [], partnerFamilies: [] }),
    ).toEqual([]);
  });
});

describe('lifetime window', () => {
  const detail = fixtureDetail('rowan');
  const [family] = detail.parentFamilies;
  const brief = (dateText: string, dateSort: number) => ({
    eventId: `e-${dateText}`,
    type: 'BIRT',
    dateText,
    dateQualifier: null,
    dateSort,
    place: null,
  });
  const withSummary = (birth: string | null, death: string | null) => ({
    ...detail,
    summary: {
      ...detail.summary,
      birth: birth ? brief(birth, 0) : null,
      death: death ? { ...brief(death, 0), type: 'DEAT' } : null,
    },
  });
  const sibling = (dateText: string, dateSort: number) => ({
    ...family!.siblings[0]!,
    person: {
      ...family!.siblings[0]!.person,
      id: 'sib',
      given: 'Sib',
      birth: brief(dateText, dateSort),
    },
  });

  it('keeps a sibling born early in an approximate birth year', () => {
    const entries = buildTimeline({
      ...withSummary('ABT 1890', null),
      parentFamilies: [{ ...family!, siblings: [sibling('MAR 1890', 18900315)] }],
    });
    expect(entries.some((e) => e.title === 'Birth of sister Sib Ashdown')).toBe(true);
  });

  it('keeps events late in a year-only death year', () => {
    const partner = detail.partnerFamilies[0]!;
    const child = partner.children[1]!;
    const entries = buildTimeline({
      ...withSummary('1880', '1955'),
      partnerFamilies: [
        {
          ...partner,
          children: [
            {
              ...child,
              person: {
                ...child.person,
                death: { ...brief('OCT 1955', 19551015), type: 'DEAT' },
              },
            },
          ],
        },
      ],
    });
    expect(entries.some((e) => e.title === 'Death of son Arthur Ashdown')).toBe(true);
  });

  it('keeps a child born after the death', () => {
    const partner = detail.partnerFamilies[0]!;
    const child = partner.children[0]!;
    const entries = buildTimeline({
      ...withSummary('1880', '1955'),
      partnerFamilies: [
        {
          ...partner,
          children: [{ ...child, person: { ...child.person, birth: brief('FEB 1956', 19560215) } }],
        },
      ],
    });
    expect(entries.some((e) => e.title === 'Birth of daughter Lena Ashdown')).toBe(true);
  });

  it('still drops a sibling born well before', () => {
    const entries = buildTimeline({
      ...withSummary('1890', null),
      parentFamilies: [{ ...family!, siblings: [sibling('1885', 18850701)] }],
    });
    expect(entries.some((e) => e.title.includes('Sib'))).toBe(false);
  });
});
