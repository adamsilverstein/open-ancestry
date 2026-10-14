import { parseGedcom, serializeGedcom } from '@open-ancestry/gedcom';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { importInto, rawText } from './test-helpers';
import { ImportError } from './types';

const RUNS = Number(process.env.FUZZ_RUNS ?? 60);

// Record-shaped noise: real tags in random nesting, with pointers that may or
// may not resolve, so the mapper sees every kind of broken structure.
const xref = fc.constantFrom('@I1@', '@I2@', '@F1@', '@S1@', '@O1@', '@N1@', '@T1@', '@R1@');
const recordTag = fc.constantFrom(
  'INDI',
  'FAM',
  'SOUR',
  'REPO',
  'OBJE',
  'NOTE',
  '_MTTAG',
  'SUBM',
  '_X',
);
const tag = fc.constantFrom(
  'NAME',
  'SEX',
  'BIRT',
  'DEAT',
  'MARR',
  'EVEN',
  'TYPE',
  'DATE',
  'PLAC',
  'MAP',
  'LATI',
  'LONG',
  'FAMC',
  'FAMS',
  'HUSB',
  'WIFE',
  'CHIL',
  'PEDI',
  '_FREL',
  '_MREL',
  'SOUR',
  'PAGE',
  'QUAY',
  'DATA',
  'TEXT',
  '_APID',
  'OBJE',
  'FILE',
  'FORM',
  'TITL',
  '_OID',
  '_PRIM',
  '_PHOTO',
  'NOTE',
  'CONC',
  'CONT',
  '_MTTAG',
  '_MTCAT',
  'RESN',
  'ADDR',
  'AGE',
  'REPO',
  'CALN',
  'ADOP',
  'GIVN',
  'SURN',
  '_MARNM',
  '_ZZZ',
);
const value = fc.oneof(
  fc.string({ maxLength: 16 }),
  xref,
  fc.constantFrom(
    'ABT 1850',
    '1950',
    'N51.5',
    'Step',
    'Adopted',
    'Y',
    '9',
    'a, b, c',
    '../x.jpg',
    '',
  ),
);
const line = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.tuple(fc.option(xref), recordTag).map(([x, t]) => `0 ${x ? x + ' ' : ''}${t}`),
  },
  {
    weight: 8,
    arbitrary: fc
      .tuple(fc.integer({ min: 1, max: 4 }), tag, fc.option(value))
      .map(([l, t, v]) => `${l} ${t}${v === null ? '' : ' ' + v}`),
  },
  { weight: 1, arbitrary: fc.constantFrom('', 'bare text', '  3 DATE 1900', '0 TRLR') },
);
const document = fc
  .array(line, { maxLength: 60 })
  .map((lines) => ['0 HEAD', '1 CHAR UTF-8', ...lines].join('\n'));

describe('fuzz: import never throws on bad data', () => {
  it('keeps every line accounted for and the raw text intact', async () => {
    await fc.assert(
      fc.asyncProperty(document, async (text) => {
        let result;
        try {
          result = await importInto(text);
        } catch (error) {
          expect(error).toBeInstanceOf(ImportError);
          return;
        }
        const { store, report } = result;
        expect(report.lines.mapped + report.lines.preserved).toBe(report.lines.total);
        expect(rawText(store)).toBe(serializeGedcom(parseGedcom(text)));
        store.close();
      }),
      { numRuns: RUNS },
    );
  });
});

describe('fuzz counterexamples', () => {
  // Shrunk from a failing CI run (seed 1931474607): a SOUR under a SOUR record
  // reached the citation_link owner CHECK and threw a SqliteError.
  it.each([
    '0 HEAD\n1 CHAR UTF-8\n0 SOUR\n1 SOUR !',
    '0 HEAD\n0 @O1@ OBJE\n1 FILE x.jpg\n1 OBJE @O1@',
  ])('imports %j without throwing', async (text) => {
    const { store, report } = await importInto(text);
    expect(report.lines.mapped + report.lines.preserved).toBe(report.lines.total);
    expect(rawText(store)).toBe(serializeGedcom(parseGedcom(text)));
  });
});
