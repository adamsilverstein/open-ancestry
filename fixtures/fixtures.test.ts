import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateGedcom } from './generate';

interface Line {
  level: number;
  xref: string | undefined;
  tag: string;
  value: string;
}

/** Minimal line splitter for sanity checks; the real parser lives in packages/gedcom. */
function lines(text: string): Line[] {
  return text
    .replace(/^﻿/, '')
    .split('\n')
    .filter(Boolean)
    .map((raw) => {
      const match = /^(\d+) (?:(@[^@]+@) )?(\S+)(?: (.*))?$/.exec(raw);
      if (!match) throw new Error(`Malformed line: ${raw}`);
      return {
        level: Number(match[1]),
        xref: match[2],
        tag: match[3] ?? '',
        value: match[4] ?? '',
      };
    });
}

/** Asserts structural integrity shared by every fixture. */
function checkIntegrity(text: string) {
  const all = lines(text);
  const defined = new Set(all.filter((l) => l.level === 0 && l.xref).map((l) => l.xref));
  for (const l of all) {
    if (/^@[^@]+@$/.test(l.value)) expect(defined, `${l.tag} ${l.value}`).toContain(l.value);
  }
  // Levels never jump by more than one.
  all.reduce((prev, l) => {
    expect(l.level).toBeLessThanOrEqual(prev + 1);
    return l.level;
  }, 0);

  // FAMS/FAMC on individuals agree with HUSB/WIFE/CHIL on families.
  const indiLinks = new Set<string>();
  const famLinks = new Set<string>();
  let owner: Line | undefined;
  for (const l of all) {
    if (l.level === 0) owner = l;
    if (!owner?.xref || l.level !== 1) continue;
    if (owner.tag === 'INDI' && (l.tag === 'FAMS' || l.tag === 'FAMC')) {
      indiLinks.add(`${owner.xref}|${l.value}|${l.tag === 'FAMC' ? 'child' : 'partner'}`);
    }
    if (owner.tag === 'FAM' && ['HUSB', 'WIFE', 'CHIL'].includes(l.tag)) {
      famLinks.add(`${l.value}|${owner.xref}|${l.tag === 'CHIL' ? 'child' : 'partner'}`);
    }
  }
  expect([...indiLinks].sort()).toEqual([...famLinks].sort());
  return all;
}

const tagsIn = (all: Line[]) => new Set(all.map((l) => l.tag));

describe('fixtures/ancestry-sample.ged', () => {
  const text = readFileSync(join(import.meta.dirname, 'ancestry-sample.ged'), 'utf8');

  it('starts with a UTF-8 BOM and an Ancestry header', () => {
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('1 SOUR Ancestry.com Family Trees\n2 DATA');
    expect(text).toMatch(/2 VERS 2024\.12\n/);
    expect(text).toContain('1 GEDC\n2 VERS 5.5.1');
  });

  it('is structurally sound', () => {
    const all = checkIntegrity(text);
    expect(all.filter((l) => l.tag === 'INDI')).toHaveLength(26);
  });

  it('contains every documented Ancestry quirk', () => {
    const tags = tagsIn(checkIntegrity(text));
    for (const tag of ['_APID', '_MTTAG', '_MTCAT', '_OID', '_PRIM', '_PHOTO', '_FREL', '_MREL']) {
      expect(tags).toContain(tag);
    }
    for (const tag of ['_MILT', 'WWW', 'CONC', 'CONT', 'ADOP', '_TREE'])
      expect(tags).toContain(tag);
    for (const date of [
      '05/28/1960',
      '2010-2019',
      '1925-09-05',
      'BET 1870 AND 1872',
      'Abt. 1842',
    ]) {
      expect(text).toContain(`DATE ${date}`);
    }
  });
});

describe('generateGedcom', () => {
  it('is deterministic for a seed', () => {
    expect(generateGedcom({ people: 300, seed: 7 })).toBe(generateGedcom({ people: 300, seed: 7 }));
    expect(generateGedcom({ people: 300, seed: 7 })).not.toBe(
      generateGedcom({ people: 300, seed: 8 }),
    );
  });

  it.each([1, 2, 50, 1000])('emits exactly %i people with sound structure', (people) => {
    const all = checkIntegrity(generateGedcom({ people, seed: 3 }));
    expect(all.filter((l) => l.tag === 'INDI')).toHaveLength(people);
  });

  it('matches the committed 1k fixture', () => {
    const committed = readFileSync(
      join(import.meta.dirname, 'generated', 'synthetic-1000.ged'),
      'utf8',
    );
    expect(committed).toBe(generateGedcom({ people: 1000, seed: 1 }));
  });

  it('includes Ancestry quirks at scale', () => {
    const text = generateGedcom({ people: 1000, seed: 1 });
    const tags = tagsIn(lines(text));
    for (const tag of ['_APID', '_MTTAG', '_MTCAT', '_OID', '_PRIM', '_PHOTO', '_FREL', '_MILT']) {
      expect(tags).toContain(tag);
    }
    expect(text).toContain('_FREL Adopted');
    expect(text).toContain('_FREL Step');
    expect(text).toMatch(/DATE \d{2}\/\d{2}\/\d{4}\n/);
    expect(text).toMatch(/DATE BET \d{4} AND \d{4}\n/);
    expect(text).toMatch(/DATE \d{3}0-\d{3}9\n/);
  });
});
