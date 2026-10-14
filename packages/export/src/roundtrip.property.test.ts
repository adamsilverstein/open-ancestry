import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildGedcomExport, exportGedcom } from './index';
import {
  TODAY,
  domainSnapshot,
  gedcom7Problems,
  importInto,
  importedSnapshot,
} from './test-helpers';

const RUNS = Number(process.env.ROUNDTRIP_RUNS ?? 40);

// ------------------------------------------------------------------ corpus

const word = fc.oneof(
  fc.constantFrom(
    'Ann',
    'Thaddeus',
    'Zoë',
    'José',
    'Łucja',
    'דוד',
    '李',
    'Ngozi',
    'Ō',
    'Mary Ann',
    "O'Neil",
    'Smith-Jones',
  ),
  fc.stringMatching(/^[A-Z][a-z]{1,8}$/),
);
const place = fc.constantFrom(
  'Millbrook, Harlow County, Vermont, USA',
  'Kraków, Małopolskie, Polska',
  'Zürich, Schweiz',
  'Ashford',
  'Tel Aviv, ישראל',
);
const year = fc.integer({ min: 1600, max: 2020 });
const month = fc.constantFrom(
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
);
const day = fc.integer({ min: 1, max: 28 });
const date = fc.oneof(
  fc.tuple(day, month, year).map(([d, m, y]) => `${d} ${m} ${y}`),
  year.map((y) => `${y}`),
  year.map((y) => `ABT ${y}`),
  year.map((y) => `Abt. ${y}`),
  year.map((y) => `BEF ${y}`),
  year.map((y) => `AFT ${y}`),
  fc.tuple(year, fc.integer({ min: 0, max: 30 })).map(([y, n]) => `BET ${y} AND ${y + n}`),
  fc.tuple(year, fc.integer({ min: 0, max: 30 })).map(([y, n]) => `FROM ${y} TO ${y + n}`),
  fc
    .tuple(day, month, year)
    .map(([d, m, y]) => `${d} ${m} ${y}/${String((y + 1) % 100).padStart(2, '0')}`),
  fc.tuple(day, month, year).map(([d, m, y]) => `@#DJULIAN@ ${d} ${m} ${y}`),
  fc
    .tuple(fc.integer({ min: 1, max: 12 }), day, year)
    .map(([m, d, y]) => `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`),
  year.map((y) => `INT ${y} (family Bible)`),
  fc.constantFrom('(unknown)', 'Deceased', '31 FEB 1900'),
);
const text = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ,.;:'()-]{0,40}[A-Za-z0-9.]$/),
  fc.constantFrom('Kept the family Bible 😀', 'Note with a@@b inside', 'ראשון', 'Line, then more'),
);
const note = fc
  .array(text, { minLength: 1, maxLength: 3 })
  .map((lines) => [`1 NOTE ${lines[0]}`, ...lines.slice(1).map((l) => `2 CONT ${l}`)]);
const apid = fc
  .tuple(fc.integer({ min: 1000, max: 9999 }), fc.integer({ min: 1, max: 9_999_999 }))
  .map(([db, id]) => `1,${db}::${id}`);
const citation = (level: number) =>
  fc
    .tuple(fc.integer({ min: 1, max: 2 }), text, apid)
    .map(([s, page, a]) => [
      `${level} SOUR @S${s}@`,
      `${level + 1} PAGE ${page}`,
      `${level + 1} _APID ${a}`,
    ]);
const event = fc
  .tuple(
    fc.constantFrom('BIRT', 'DEAT', 'BURI', 'CHR', 'RESI', 'OCCU', 'EVEN', '_MILT'),
    fc.option(date, { nil: undefined }),
    fc.option(place, { nil: undefined }),
    fc.option(citation(2), { nil: undefined }),
    text,
  )
  .map(([tag, d, p, cite, value]) => [
    tag === 'OCCU' ? `1 OCCU ${value}` : `1 ${tag}`,
    ...(tag === 'EVEN' ? [`2 TYPE ${value}`] : []),
    ...(d ? [`2 DATE ${d}`] : []),
    ...(p ? [`2 PLAC ${p}`] : []),
    ...(cite ?? []),
  ]);
const person = fc.record({
  given: word,
  surname: word,
  sex: fc.constantFrom('M', 'F', 'U'),
  events: fc.array(event, { maxLength: 4 }),
  notes: fc.array(note, { maxLength: 1 }),
  custom: fc.option(text, { nil: undefined }),
});

/** A small synthetic Ancestry-style GEDCOM 5.5.1 file in the exact form an export writes. */
const corpus = fc
  .record({
    people: fc.array(person, { minLength: 1, maxLength: 10 }),
    couples: fc.array(fc.tuple(fc.nat(), fc.nat(), fc.array(fc.nat(), { maxLength: 3 })), {
      maxLength: 4,
    }),
    sourceTitles: fc.tuple(text, text),
  })
  .map(({ people, couples, sourceTitles }) => {
    const n = people.length;
    const fams: { husb: number; wife: number; chil: number[] }[] = [];
    for (const [a, b, kids] of couples) {
      const husb = a % n;
      const wife = b % n;
      if (husb === wife) continue;
      const chil = [...new Set(kids.map((k) => k % n))].filter((c) => c !== husb && c !== wife);
      fams.push({ husb, wife, chil });
    }
    const out = [
      '0 HEAD',
      '1 SOUR Ancestry.com Family Trees',
      '2 VERS 2024.12',
      '1 GEDC',
      '2 VERS 5.5.1',
      '2 FORM LINEAGE-LINKED',
      '1 CHAR UTF-8',
    ];
    people.forEach((p, i) => {
      out.push(`0 @I${i + 1}@ INDI`, `1 NAME ${p.given} /${p.surname}/`, `2 GIVN ${p.given}`);
      out.push(`2 SURN ${p.surname}`, `1 SEX ${p.sex}`);
      for (const e of p.events) out.push(...e);
      for (const nl of p.notes) out.push(...nl);
      if (p.custom) out.push(`1 _CUSTOM ${p.custom}`);
      fams.forEach((f, fi) => {
        if (f.chil.includes(i)) out.push(`1 FAMC @F${fi + 1}@`);
      });
      fams.forEach((f, fi) => {
        if (f.husb === i || f.wife === i) out.push(`1 FAMS @F${fi + 1}@`);
      });
    });
    fams.forEach((f, fi) => {
      out.push(`0 @F${fi + 1}@ FAM`, `1 HUSB @I${f.husb + 1}@`, `1 WIFE @I${f.wife + 1}@`);
      for (const c of f.chil) out.push(`1 CHIL @I${c + 1}@`);
    });
    sourceTitles.forEach((title, i) => {
      out.push(`0 @S${i + 1}@ SOUR`, `1 TITL ${title}`, `1 _APID 1,${7000 + i}::0`);
    });
    out.push('0 TRLR', '');
    return out.join('\n');
  });

/** Problems the GEDCOM 7 check reports for valid calendar dates (#102); everything else must be clean. */
const calendarFalsePositive = (problem: string) =>
  /^bad DATE "(?:(?:ABT|BEF|AFT|BET|FROM|TO|CAL|EST) )?JULIAN /.test(problem);

describe('property: import -> export round trips', { timeout: 120_000 }, () => {
  it('an unedited 5.5.1 export reproduces the file byte for byte', async () => {
    await fc.assert(
      fc.asyncProperty(corpus, async (text) => {
        const store = await importInto(text);
        expect(exportGedcom(store, { version: '5.5.1', now: TODAY })).toBe(text);
        store.close();
      }),
      { numRuns: RUNS },
    );
  });

  it('a GEDCOM 7 export is valid and re-imports to the same domain model', async () => {
    await fc.assert(
      fc.asyncProperty(corpus, async (text) => {
        const store = await importInto(text);
        const out = buildGedcomExport(store, { version: '7', now: TODAY });
        expect(gedcom7Problems(out.text).filter((p) => !calendarFalsePositive(p))).toEqual([]);
        const again = await importInto(out.text);
        expect(importedSnapshot(again)).toEqual(
          domainSnapshot(store, (_table, id) => out.xrefs.get(id)!),
        );
        // And back to 5.5.1: the same domain model again.
        const back = buildGedcomExport(again, { version: '5.5.1', now: TODAY });
        const thrice = await importInto(back.text);
        expect(importedSnapshot(thrice)).toEqual(
          domainSnapshot(again, (_table, id) => back.xrefs.get(id)!),
        );
        for (const s of [store, again, thrice]) s.close();
      }),
      { numRuns: RUNS },
    );
  });
});
