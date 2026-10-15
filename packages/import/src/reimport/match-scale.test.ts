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

describe('matching at scale: corrected birth years in crowded names (100k bench regression)', () => {
  // The 100k compare bench reported 124 renumbered records as new: an export
  // that turns "BET 1920 AND 1929" into "1 JAN 1929" moves the birth year by
  // up to 9 years, and in a name shared by dozens of people the 8 nearest
  // birth years never reached the real record. Its death year still matched.
  it('compares same-name people with the same death year, however far the birth year moved', async () => {
    const person = (xref: string, born: number, died: number) => [
      `0 ${xref} INDI`,
      '1 NAME John /Smith/',
      '1 SEX M',
      '1 BIRT',
      `2 DATE ${born}`,
      '1 DEAT',
      `2 DATE ${died}`,
    ];
    // 40 same-name people born 1900-1939 with distinct death years, plus the one who moves.
    const crowd = (offset: number) =>
      Array.from({ length: 40 }, (_, n) => person(`@I${n + offset}@`, 1900 + n, 1960 + n)).flat();
    const existing = await tree(ged(...crowd(1), ...person('@I900@', 1920, 2014)));
    const incoming = await tree(ged(...crowd(1001), ...person('@I1900@', 1929, 2014)));
    const e = snapshot(existing);
    const moved = [...e.people.values()].find((p) => p.deathYear === 2014)!;
    const matches = matchPeople(e, snapshot(incoming));
    expect([...matches.values()].some((m) => m.existingId === moved.row.id)).toBe(true);
    existing.close();
    incoming.close();
  });
});

describe('matching at scale: a birth range refined to one of its years', () => {
  // The rest of the 100k regression: living people (no death year) whose
  // "BET 1940 AND 1949" became "1 JAN 1949". The range still covers the year.
  it('compares a same-name person whose birth range covers the new birth year', async () => {
    const person = (xref: string, date: string) => [
      `0 ${xref} INDI`,
      '1 NAME John /Smith/',
      '1 SEX M',
      '1 BIRT',
      `2 DATE ${date}`,
    ];
    const crowd = (offset: number) =>
      Array.from({ length: 40 }, (_, n) =>
        person(`@I${n + offset}@`, String(1930 + (n % 25))),
      ).flat();
    const existing = await tree(ged(...crowd(1), ...person('@I900@', 'BET 1940 AND 1949')));
    const incoming = await tree(ged(...crowd(1001), ...person('@I1900@', '1 JAN 1949')));
    const e = snapshot(existing);
    const ranged = [...e.people.values()].find((p) =>
      p.events.some((ev) => ev.row.date_text === 'BET 1940 AND 1949'),
    )!;
    const near = new Map<string, NearMiss>();
    const matches = matchPeople(e, snapshot(incoming), near);
    const incomingId = [...snapshot(incoming).people.values()].find((p) =>
      p.events.some((ev) => ev.row.date_text === '1 JAN 1949'),
    )!.row.id;
    const found = matches.get(incomingId)?.existingId ?? near.get(incomingId)?.existingId;
    expect(found).toBe(ranged.row.id);
    existing.close();
    incoming.close();
  });
});

describe('matching at scale: undated people still match themselves', () => {
  // The 100k compare bench found 124 renumbered records reported as new: people
  // with no birth or death year in a crowded name were compared with no one.
  it('matches a person without dates whose name is shared by many dated people', async () => {
    const undatedAda = (xref: string) => [`0 ${xref} INDI`, '1 NAME John /Smith/', '1 SEX M'];
    const existing = await tree(
      sameNames(40, 1).replace('0 TRLR', [...undatedAda('@I900@'), '0 TRLR'].join('\n')),
    );
    const incoming = await tree(
      sameNames(40, 1001).replace('0 TRLR', [...undatedAda('@I1900@'), '0 TRLR'].join('\n')),
    );
    const matches = matchPeople(snapshot(existing), snapshot(incoming));
    expect(matches.size).toBe(41);
    existing.close();
    incoming.close();
  });
});
