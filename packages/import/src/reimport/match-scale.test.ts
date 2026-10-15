import { openMemoryTree } from '@open-ancestry/db';
import { describe, expect, it } from 'vitest';
import { importGedcom } from '../import';
import { TODAY, ged } from '../test-helpers';
import { matchPeople, type MatchStats, type NearMiss } from './match';
import { snapshot } from './snapshot';

/** `count` people who all share one name, born a year apart from 1400 on. */
function sameNames(count: number, offset: number): string {
  const lines: string[] = [];
  for (let n = 0; n < count; n++) {
    lines.push(
      `0 @I${n + offset}@ INDI`,
      '1 NAME John /Smith/',
      '1 SEX M',
      '1 BIRT',
      `2 DATE ${1400 + n}`,
    );
  }
  return ged(...lines);
}

async function tree(text: string) {
  const store = openMemoryTree();
  await importGedcom({ bytes: text }, store, { today: TODAY });
  return store;
}

// #202: comparing every pair that shares a name sound made matching quadratic
// in how common a name is (391s for a 100k-person tree with a small name pool).
describe('matching at scale', () => {
  it('compares a person only with same-name people born within a few years', async () => {
    const existing = await tree(sameNames(600, 1));
    const incoming = await tree(sameNames(600, 1001));
    const stats: MatchStats = { comparisons: 0 };
    const matches = matchPeople(snapshot(existing), snapshot(incoming), undefined, stats);

    // Everyone still matches their own record (the same birth year).
    const birthYear = (store: typeof existing, id: string) =>
      (
        store.db
          .prepare(
            `SELECT e.date_sort / 10000 AS y FROM event e JOIN event_role r ON r.event_id = e.id
             WHERE r.person_id = ? AND e.type = 'BIRT'`,
          )
          .get(id) as { y: number }
      ).y;
    expect(matches.size).toBe(600);
    for (const m of matches.values()) {
      expect(birthYear(existing, m.existingId)).toBe(birthYear(incoming, m.incomingId));
    }
    // Every pair would be 360,000 comparisons; a window of a few years is about 30 per person.
    expect(stats.comparisons).toBeGreaterThanOrEqual(600);
    expect(stats.comparisons).toBeLessThan(600 * 40);
    existing.close();
    incoming.close();
  });

  it('still matches a corrected birth year, and people without one', async () => {
    const existing = await tree(
      ged(
        '0 @I1@ INDI',
        '1 NAME Ada /Vale/',
        '1 SEX F',
        '1 BIRT',
        '2 DATE 1900',
        '0 @I2@ INDI',
        '1 NAME Bram /Holt/',
        '1 SEX M',
        '0 @I3@ INDI',
        '1 NAME Cora /Lind/',
        '1 SEX F',
        '1 BIRT',
        '2 DATE 1850',
      ),
    );
    const incoming = await tree(
      ged(
        '0 @I51@ INDI',
        '1 NAME Ada /Vale/',
        '1 SEX F',
        '1 BIRT',
        '2 DATE 1909',
        '0 @I52@ INDI',
        '1 NAME Bram /Holt/',
        '1 SEX M',
        '1 BIRT',
        '2 DATE 1875',
        '0 @I53@ INDI',
        '1 NAME Cora /Lind/',
        '1 SEX F',
      ),
    );
    const matches = matchPeople(snapshot(existing), snapshot(incoming));
    expect(matches.size).toBe(3);
    existing.close();
    incoming.close();
  });
});

describe('matching at scale: rare names and undated people (review of #222)', () => {
  it('still compares a rare name whose birth year has two digits swapped', async () => {
    const existing = await tree(
      ged('0 @I1@ INDI', '1 NAME Ottilie /Brandvold/', '1 SEX F', '1 BIRT', '2 DATE 1857'),
    );
    const incoming = await tree(
      ged('0 @I9@ INDI', '1 NAME Ottilie /Brandvold/', '1 SEX F', '1 BIRT', '2 DATE 1875'),
    );
    const near = new Map<string, NearMiss>();
    const matches = matchPeople(snapshot(existing), snapshot(incoming), near);
    const treeId = existing.db.prepare('SELECT id FROM person').pluck().get() as string;
    const found = [...matches.values()][0]?.existingId ?? [...near.values()][0]?.existingId;
    expect(found).toBe(treeId);
    existing.close();
    incoming.close();
  });

  it('caps comparisons for people without a birth year in a crowded name', async () => {
    const undated = (count: number, offset: number) => {
      const lines: string[] = [];
      for (let n = 0; n < count; n++) lines.push(`0 @I${n + offset}@ INDI`, '1 NAME John /Smith/');
      return lines;
    };
    const existing = await tree(
      sameNames(300, 1).replace('0 TRLR', [...undated(300, 5001), '0 TRLR'].join('\n')),
    );
    const incoming = await tree(ged(...undated(300, 9001)));
    const stats: MatchStats = { comparisons: 0 };
    matchPeople(snapshot(existing), snapshot(incoming), undefined, stats);
    // Every pair would be 300 x 600 = 180,000.
    expect(stats.comparisons).toBeLessThan(300 * 80);
    existing.close();
    incoming.close();
  });
});
