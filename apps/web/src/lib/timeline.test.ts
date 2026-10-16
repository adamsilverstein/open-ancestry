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

  it('adds siblings from other partnerships, worded by kind', () => {
    const nell = fixtureDetail('nell').summary;
    const silas = { ...nell, id: 'silas', given: 'Silas', sex: 'M' as const };
    const finn = { ...nell, id: 'finn', given: 'Finn', sex: 'M' as const };
    const titles = buildTimeline(fixtureDetail('rowan'), {
      otherSiblings: [
        { person: nell, kind: 'half' },
        { person: silas, kind: 'step' },
        { person: finn, kind: 'foster' },
      ],
    }).map((e) => e.title);
    expect(titles).toContain('Birth of stepbrother Silas Marsh');
    expect(titles).toContain('Birth of foster brother Finn Marsh');
    expect(titles.indexOf('Birth of half-sister Nell Marsh')).toBe(
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

  it('gives no age for events after the death or at age zero', () => {
    const partner = detail.partnerFamilies[0]!;
    const child = partner.children[0]!;
    const [family] = detail.parentFamilies;
    const entries = buildTimeline({
      ...withSummary('ABT 1880', '1955'),
      partnerFamilies: [
        {
          ...partner,
          children: [{ ...child, person: { ...child.person, birth: brief('FEB 1956', 19560215) } }],
        },
      ],
      parentFamilies: [{ ...family!, siblings: [sibling('1880', 18800701)] }],
    });
    // Posthumous child: no age. Same-year sibling: not "about 0".
    expect(entries.find((e) => e.title === 'Birth of daughter Lena Ashdown')!.age).toBeUndefined();
    expect(entries.find((e) => e.title === 'Birth of sister Sib Ashdown')!.age).toBeUndefined();
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

  describe('family events that may follow the death', () => {
    const partner = detail.partnerFamilies[0]!;
    const withPartnerDeath = (dateText: string, dateSort: number) =>
      buildTimeline({
        ...withSummary('1880', '4 NOV 1911'),
        summary: {
          ...withSummary('1880', '4 NOV 1911').summary,
          death: { ...brief('4 NOV 1911', 19111104), type: 'DEAT' },
        },
        // The person's own death, on the date the summary gives.
        events: detail.events
          .filter((e) => e.event.type === 'DEAT')
          .map((e) => ({
            ...e,
            event: { ...e.event, date_text: '4 NOV 1911', date_sort: 19111104 },
          })),
        parentFamilies: [],
        partnerFamilies: [
          {
            ...partner,
            children: [],
            events: [],
            partner: { ...partner.partner!, death: { ...brief(dateText, dateSort), type: 'DEAT' } },
          },
        ],
      });
    const titles = (entries: ReturnType<typeof buildTimeline>) => entries.map((e) => e.title);

    it('sorts a BEF death that straddles the death date by its date, with no age (#278)', () => {
      // "bef. 1920" sorts after a 1911 death, like every other date in the app.
      const entries = withPartnerDeath('BEF 1920', 19200100);
      expect(titles(entries)).toEqual(['Death', 'Death of wife Iris Vale']);
      expect(entries[1]!.age).toBeUndefined();
    });

    it('keeps an AFT death that starts in the lifetime, with no age', () => {
      const entries = withPartnerDeath('AFT 1905', 19051232);
      expect(titles(entries)).toEqual(['Death of wife Iris Vale', 'Death']);
      expect(entries[0]!.age).toBeUndefined();
    });

    it('keeps the age of a BEF death that cannot follow the death', () => {
      const entries = withPartnerDeath('BEF 1910', 19100100);
      expect(entries[0]).toMatchObject({ title: 'Death of wife Iris Vale', age: 'about 30' });
    });

    it('leaves out an AFT death that starts after the death, like an exact one', () => {
      expect(titles(withPartnerDeath('AFT 1912', 19121232))).toEqual(['Death']);
      expect(titles(withPartnerDeath('1915', 19150701))).toEqual(['Death']);
    });
  });
});

describe('half and step wording', () => {
  const detail = fixtureDetail('rowan');
  const [family] = detail.parentFamilies;
  const tobias = family!.siblings.find((s) => s.person.given === 'Tobias')!;

  it('names a sibling who shares one parent as a half-sibling', () => {
    const entries = buildTimeline({
      ...detail,
      parentFamilies: [
        {
          ...family!,
          siblings: [{ ...tobias, link: { ...tobias.link, partner1_rel: 'step' } }],
        },
      ],
    });
    expect(entries.map((e) => e.title)).toContain('Birth of half-brother Tobias Ashdown');
  });

  it('names a sibling who shares no parent as a step-sibling', () => {
    const entries = buildTimeline({
      ...detail,
      parentFamilies: [
        {
          ...family!,
          link: { ...family!.link, partner1_rel: 'step' },
          siblings: [{ ...tobias, link: { ...tobias.link, partner2_rel: 'step' } }],
        },
      ],
    });
    expect(entries.map((e) => e.title)).toContain('Birth of stepbrother Tobias Ashdown');
  });

  it('names stepchildren and adopted children', () => {
    const partner = detail.partnerFamilies[0]!;
    const side = partner.family.partner1_id === detail.person.id ? 'partner1_rel' : 'partner2_rel';
    const [lena, arthur] = partner.children;
    const entries = buildTimeline({
      ...detail,
      partnerFamilies: [
        {
          ...partner,
          children: [
            { ...lena!, link: { ...lena!.link, [side]: 'step' } },
            { ...arthur!, link: { ...arthur!.link, [side]: 'adopted' } },
          ],
        },
      ],
    });
    const titles = entries.map((e) => e.title);
    expect(titles).toContain('Birth of stepdaughter Lena Ashdown');
    expect(titles).toContain('Birth of adopted son Arthur Ashdown');
  });
});
