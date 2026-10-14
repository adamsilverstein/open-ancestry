import { describe, expect, it } from 'vitest';
import { fixtureDetail } from './fixtureDetail.test-utils';
import type { PersonDetail } from '../api/types';
import { datePhrase, lifeStory } from './lifeStory';

describe('lifeStory', () => {
  it('narrates birth, family, work, marriage, losses and death', () => {
    const story = lifeStory(fixtureDetail('rowan'));
    expect(story).toEqual([
      'Rowan Ashdown was born on 12 Mar 1880 in Brackenford, Westmere, the son of Edmund Ashdown and Clara Penhallow. He had one brother and one sister.',
      'In 1900 he lived in Wexmoor, Westmere. He worked as a blacksmith in 1910.',
      'He married Iris Vale on 14 Jun 1905 in Ashcombe, Eastholm. Together they had two children: Lena and Arthur.',
      'His father, Edmund Ashdown, died in 1901, when Rowan was 21. His mother, Clara Penhallow, died in 1930. His wife, Iris Vale, died in 1940. His son Arthur died in 1944.',
      'He died on 3 Nov 1950 in Thornbury, Northvale, at the age of 70, and was buried in Thornbury, Northvale.',
    ]);
  });

  it('uses the right pronouns and copes with sparse records', () => {
    const lena = lifeStory(fixtureDetail('lena'));
    expect(lena[0]).toBe(
      'Lena Ashdown was born on 30 Sep 1906 in Brackenford, Westmere, the daughter of Rowan Ashdown and Iris Vale. She had one brother.',
    );
    const pip = lifeStory(fixtureDetail('pip'));
    expect(pip[0]).toBe(
      'Pip Ashdown was born in 1935 in Brackenford, Westmere, the son of Arthur Ashdown.',
    );
  });

  it('says so when there is nothing to tell', () => {
    const detail = fixtureDetail('lena');
    expect(lifeStory({ ...detail, events: [], parentFamilies: [], partnerFamilies: [] })).toEqual(
      [],
    );
  });
});

describe('lifeStory losses', () => {
  it('tells deaths in date order, not family order', () => {
    const detail = fixtureDetail('rowan');
    const [family] = detail.parentFamilies;
    const swapped = {
      ...detail,
      parentFamilies: [{ ...family!, partner1: family!.partner2, partner2: family!.partner1 }],
    };
    expect(lifeStory(swapped)[3]).toMatch(/^His father, Edmund Ashdown, died in 1901/);
  });
});

describe('datePhrase', () => {
  it.each([
    ['12 MAR 1880', 'on 12 Mar 1880'],
    ['MAR 1880', 'in Mar 1880'],
    ['1880', 'in 1880'],
    ['Abt. 1842', 'about 1842'],
    ['CAL 1842', 'around 1842'],
    ['EST 1842', 'around 1842'],
    ['BEF 1920', 'before 1920'],
    ['AFT 1950', 'after 1950'],
    ['BET 1870 AND 1872', 'between 1870 and 1872'],
    ['2010-2019', 'between 2010 and 2019'],
    ['FROM 1900 TO 1910', 'from 1900 to 1910'],
    ['FROM 1900', 'from 1900'],
    ['TO 1910', 'until 1910'],
    ['INT 1941 (the war year)', 'in 1941'],
    ['unknown', ''],
    ['', ''],
  ])('%j -> %j', (text, phrase) => {
    expect(datePhrase(text)).toBe(phrase);
  });

  it('drops day and month for years', () => {
    expect(datePhrase('BEF 3 JAN 1920', { year: true })).toBe('before 1920');
    expect(datePhrase('12 MAR 1880', { year: true })).toBe('in 1880');
  });
});

describe('lifeStory family wording', () => {
  const rowan = fixtureDetail('rowan');
  const [family] = rowan.parentFamilies;
  const withParents = (
    patch: Partial<NonNullable<typeof family>['link']>,
    extra: Partial<PersonDetail> = {},
  ) =>
    lifeStory({
      ...rowan,
      parentFamilies: [{ ...family!, link: { ...family!.link, ...patch } }],
      ...extra,
    });

  it('names a stepfather apart from the parents', () => {
    const story = withParents({ partner1_rel: 'step' });
    expect(story[0]).toContain('the son of Clara Penhallow.');
    expect(story[0]).toContain('His stepfather was Edmund Ashdown.');
    expect(story.join(' ')).toContain('His stepfather, Edmund Ashdown, died in 1901');
  });

  it('tells an adoption with its date', () => {
    const adoption = {
      ...rowan.events[0]!,
      event: { ...rowan.events[0]!.event, id: 'adop', type: 'ADOP', date_text: '1882' },
      role: { ...rowan.events[0]!.role, is_preferred: 1 as const },
    };
    const story = withParents(
      { partner1_rel: 'adopted', partner2_rel: 'adopted' },
      { events: [...rowan.events, adoption] },
    );
    expect(story[0]).not.toContain('the son of');
    expect(story[0]).toContain('He was adopted in 1882 by Edmund Ashdown and Clara Penhallow.');
  });

  it('counts half- and step-siblings', () => {
    const story = lifeStory({
      ...rowan,
      parentFamilies: [
        {
          ...family!,
          siblings: family!.siblings.map((s) =>
            s.person.given === 'Tobias' ? { ...s, link: { ...s.link, partner1_rel: 'step' } } : s,
          ),
        },
      ],
    });
    expect(story[0]).toContain('He had one sister and one half-brother.');
  });

  it('keeps stepchildren out of the couple’s children', () => {
    const partner = rowan.partnerFamilies[0]!;
    const mine = partner.family.partner1_id === rowan.person.id ? 'partner1_rel' : 'partner2_rel';
    const theirs = mine === 'partner1_rel' ? 'partner2_rel' : 'partner1_rel';
    const [lena, arthur] = partner.children;
    const story = lifeStory({
      ...rowan,
      partnerFamilies: [
        {
          ...partner,
          children: [
            { ...lena!, link: { ...lena!.link, [theirs]: 'step' } },
            { ...arthur!, link: { ...arthur!.link, [mine]: 'step' } },
          ],
        },
      ],
    });
    expect(story[2]).toBe(
      'He married Iris Vale on 14 Jun 1905 in Ashcombe, Eastholm. Iris was stepmother to Lena. He was stepfather to Arthur.',
    );
  });

  it('says when the couple adopted', () => {
    const partner = rowan.partnerFamilies[0]!;
    const story = lifeStory({
      ...rowan,
      partnerFamilies: [
        {
          ...partner,
          children: partner.children.map((c) => ({
            ...c,
            link: { ...c.link, partner1_rel: 'adopted' as const, partner2_rel: 'adopted' as const },
          })),
        },
      ],
    });
    expect(story[2]).toContain('Together they adopted two children: Lena and Arthur.');
  });

  it('tells custom events, with a verb when the type has one', () => {
    const base = rowan.events[0]!;
    const custom = (id: string, type: string, date: string) => ({
      ...base,
      event: { ...base.event, id, type: 'EVEN', custom_type: type, date_text: date },
      place: { ...base.place!, full_name: 'Millbrook, Vermont' },
      role: { ...base.role, is_preferred: 1 as const },
    });
    const story = lifeStory({
      ...rowan,
      events: [custom('a', 'Arrival', '1866'), custom('b', 'Land grant', 'ABT 1870')],
    });
    expect(story).toContain(
      'He arrived in Millbrook, Vermont in 1866. His land grant was recorded in Millbrook, Vermont about 1870.',
    );
  });
});
