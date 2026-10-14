/*
 * Property tests: a generated corpus of Ancestry-style GEDCOM 5.5.1 files
 * through import and export. ROUNDTRIP_RUNS sets the number of files (default
 * 40). To replay a CI failure, run with FC_SEED=<seed> FC_PATH=<path> from the
 * failure message.
 */
import { arbDateText, arbSpanDate } from '@open-ancestry/core/testing/dates';
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
const replay = process.env.FC_SEED
  ? { seed: Number(process.env.FC_SEED), path: process.env.FC_PATH, endOnFailure: true }
  : {};

// ------------------------------------------------------------------ corpus

/** Precomposed, decomposed and mixed forms: import and export must not care which. */
const unicode = (s: string) => fc.constantFrom(s.normalize('NFC'), s.normalize('NFD'));
const word = fc.oneof(
  fc.constantFrom('Ann', 'Thaddeus', 'Mary Ann', 'Ngozi', "O'Neil", 'Smith-Jones', 'דוד', '李'),
  unicode('Zoë'),
  unicode('José'),
  unicode('Łucja Ōta'),
  fc.stringMatching(/^[A-Z][a-z]{1,8}$/),
);
const place = fc.oneof(
  fc.constantFrom('Millbrook, Harlow County, Vermont, USA', 'Ashford', 'Tel Aviv, ישראל'),
  unicode('Kraków, Małopolskie, Polska'),
  unicode('Zürich, Schweiz'),
);
/** Every date form the importer reads: core's generators plus Ancestry's and other calendars. */
const date = fc.oneof(
  arbDateText,
  arbSpanDate.map((d) => d.text),
  fc.constantFrom(
    'Abt. 1842',
    'abt 1850',
    'c. 1850',
    'Abt. 1850-1860',
    '05/28/1960',
    '1941-09-05',
    '@#DHEBREW@ 1 TSH 5780',
    '@#DFRENCH R@ 1 VEND 10',
    'INT 1900 (family Bible)',
    '(unknown)',
    'Deceased',
    '31 FEB 1900',
  ),
);
const short = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ,.;:'()-]{0,40}[A-Za-z0-9.]$/),
  fc.constantFrom('Kept the family Bible 😀', 'Note with a@@b inside', 'ראשון', 'Line, then more'),
);
/** Long enough that export splits it with CONC, with multi-byte characters near the split. */
const long = fc
  .tuple(fc.integer({ min: 230, max: 250 }), fc.constantFrom('é', '😀', 'ש', '李'), short)
  .map(([n, c, tail]) => `${'a'.repeat(n)}${c.repeat(12)} ${tail} ${'b'.repeat(80)}`);
const text = fc.oneof({ weight: 4, arbitrary: short }, { weight: 1, arbitrary: long });
/** A note as Ancestry writes it: CONT between lines, CONC splitting lines over 248 characters. */
const noteLines = (level: number, tag: string, lines: string[]) => {
  const out: string[] = [];
  lines.forEach((line, i) => {
    const chunks = line.match(/[\s\S]{1,200}(?![\uDC00-\uDFFF])/gu) ?? [''];
    out.push(`${i === 0 ? `${level} ${tag}` : `${level + 1} CONT`} ${chunks[0]}`);
    for (const chunk of chunks.slice(1)) out.push(`${level + 1} CONC ${chunk}`);
  });
  return out;
};
const apid = fc
  .tuple(fc.integer({ min: 1000, max: 9999 }), fc.integer({ min: 1, max: 9_999_999 }))
  .map(([db, id]) => `1,${db}::${id}`);
const citation = (level: number) =>
  fc
    .tuple(fc.integer({ min: 1, max: 2 }), short, apid)
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
    fc.option(short, { nil: undefined }),
    short,
  )
  .map(([tag, d, p, cite, custom, value]) => [
    tag === 'OCCU' ? `1 OCCU ${value}` : `1 ${tag}`,
    ...(tag === 'EVEN' ? [`2 TYPE ${value}`] : []),
    ...(d ? [`2 DATE ${d}`] : []),
    ...(p ? [`2 PLAC ${p}`] : []),
    ...(cite ?? []),
    // A custom substructure under a standard tag.
    ...(custom ? [`2 _DETAIL ${custom}`] : []),
  ]);
const person = fc.record({
  given: word,
  surname: word,
  married: fc.option(word, { nil: undefined }),
  sex: fc.constantFrom('M', 'F', 'U'),
  events: fc.array(event, { maxLength: 4 }),
  notes: fc.array(fc.array(text, { minLength: 1, maxLength: 3 }), { maxLength: 1 }),
  sharedNote: fc.boolean(),
  photo: fc.boolean(),
  custom: fc.option(short, { nil: undefined }),
  asso: fc.option(fc.tuple(fc.nat(), fc.constantFrom('Godparent', 'Witness', 'Neighbour')), {
    nil: undefined,
  }),
});

/** A small synthetic Ancestry-style GEDCOM 5.5.1 file in the form an export writes it. */
const corpus = fc
  .record({
    people: fc.array(person, { minLength: 1, maxLength: 10 }),
    couples: fc.array(fc.tuple(fc.nat(), fc.nat(), fc.array(fc.nat(), { maxLength: 3 })), {
      maxLength: 4,
    }),
    sourceTitles: fc.tuple(short, short),
    sharedNote: fc.array(text, { minLength: 1, maxLength: 2 }),
    customRecord: fc.option(short, { nil: undefined }),
  })
  .map(({ people, couples, sourceTitles, sharedNote, customRecord }) => {
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
      out.push(`2 SURN ${p.surname}`);
      if (p.married) out.push(`1 NAME ${p.given} /${p.married}/`, '2 TYPE married');
      out.push(`1 SEX ${p.sex}`);
      for (const e of p.events) out.push(...e);
      for (const lines of p.notes) out.push(...noteLines(1, 'NOTE', lines));
      if (p.sharedNote) out.push('1 NOTE @N1@');
      if (p.photo) out.push('1 OBJE @O1@', '2 _PRIM Y');
      if (p.custom) out.push(`1 _CUSTOM ${p.custom}`);
      if (p.asso && n > 1) {
        const other = p.asso[0] % n === i ? (i + 1) % n : p.asso[0] % n;
        out.push(`1 ASSO @I${other + 1}@`, `2 RELA ${p.asso[1]}`);
      }
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
      out.push(`1 _TMPLT`, `2 FIELD`, `3 NAME Page`);
    });
    if (people.some((p) => p.sharedNote)) out.push(...noteLines(0, '@N1@ NOTE', sharedNote));
    if (people.some((p) => p.photo)) {
      out.push(
        '0 @O1@ OBJE',
        '1 FILE https://example.com/photo.jpg',
        '2 FORM jpg',
        '2 TITL A photo',
      );
    }
    if (customRecord) out.push('0 @X1@ _CUSTREC', `1 NAME ${customRecord}`);
    out.push('0 TRLR', '');
    return out.join('\n');
  });

/** Problems the GEDCOM 7 check reports for valid calendar dates (#102); everything else must be clean. */
const calendarFalsePositive = (problem: string) =>
  /^bad DATE "(?:(?:ABT|BEF|AFT|BET|FROM|TO|CAL|EST|INT) )?(?:JULIAN|HEBREW|FRENCH_R) /.test(
    problem,
  );

describe('property: import -> export round trips', { timeout: 300_000 }, () => {
  it('copy path: an unedited 5.5.1 export reproduces the file byte for byte', async () => {
    await fc.assert(
      fc.asyncProperty(corpus, async (text) => {
        const store = await importInto(text);
        expect(exportGedcom(store, { version: '5.5.1', now: TODAY })).toBe(text);
        store.close();
      }),
      { numRuns: RUNS, ...replay },
    );
  });

  it('generated path: a 5.5.1 export written from the tables re-imports to the same domain model', async () => {
    await fc.assert(
      fc.asyncProperty(corpus, async (text) => {
        const store = await importInto(text);
        // Dropping raw_record forces every record through the canonical writer.
        store.db.exec('DELETE FROM raw_record');
        const out = buildGedcomExport(store, { version: '5.5.1', now: TODAY });
        expect(out.stats.verbatim).toBe(0);
        const again = await importInto(out.text);
        expect(importedSnapshot(again)).toEqual(
          domainSnapshot(store, (_table, id) => out.xrefs.get(id)!),
        );
        for (const s of [store, again]) s.close();
      }),
      { numRuns: RUNS, ...replay },
    );
  });

  it('a GEDCOM 7 export is valid and re-imports to the same domain model, and back to 5.5.1', async () => {
    await fc.assert(
      fc.asyncProperty(corpus, async (text) => {
        const store = await importInto(text);
        const out = buildGedcomExport(store, { version: '7', now: TODAY });
        expect(gedcom7Problems(out.text).filter((p) => !calendarFalsePositive(p))).toEqual([]);
        const again = await importInto(out.text);
        expect(importedSnapshot(again)).toEqual(
          domainSnapshot(store, (_table, id) => out.xrefs.get(id)!),
        );
        const back = buildGedcomExport(again, { version: '5.5.1', now: TODAY });
        const thrice = await importInto(back.text);
        expect(importedSnapshot(thrice)).toEqual(
          domainSnapshot(again, (_table, id) => back.xrefs.get(id)!),
        );
        for (const s of [store, again, thrice]) s.close();
      }),
      { numRuns: RUNS, ...replay },
    );
  });
});
