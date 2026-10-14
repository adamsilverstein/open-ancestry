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
      age: 25,
      place: 'Ashcombe, Eastholm',
    });
    expect(entries[0]).toMatchObject({ age: undefined, sourceCount: 1, year: '1880' });
    expect(entries.find((e) => e.title === 'Census')).toMatchObject({
      category: 'work',
      sourceCount: 1,
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

  it('filters by category', () => {
    const visible = filterTimeline(entries, new Set(['family', 'work']));
    expect(visible.every((e) => e.category !== 'family' && e.category !== 'work')).toBe(true);
    expect(visible).toHaveLength(entries.length - 8);
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
