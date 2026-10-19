import { parseDate } from '@open-ancestry/core';
import { parseGedcom } from '@open-ancestry/gedcom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGedcomExport, exportGedcom } from './index';
import {
  FIXTURES,
  FIXTURE_FILES,
  TODAY,
  domainSnapshot,
  ged,
  gedcom7Problems,
  importInto,
  importedSnapshot,
  normalizeGedcom,
  rows,
} from './test-helpers';

const read = (file: string) => readFileSync(join(FIXTURES, file));
const ownVersion = (bytes: Uint8Array) =>
  (parseGedcom(bytes).header.majorVersion ?? 5) >= 7 ? ('7' as const) : ('5.5.1' as const);

// Each fixture case imports, exports and re-imports a 1k-person tree; leave room on busy CI runners.
describe('export in the version the file was imported from', { timeout: 30_000 }, () => {
  it.each(FIXTURE_FILES)('%s: normalized diff with the original is empty', async (file) => {
    const bytes = read(file);
    const store = await importInto(bytes);
    const out = exportGedcom(store, { version: ownVersion(bytes), now: TODAY });
    expect(normalizeGedcom(out)).toBe(normalizeGedcom(bytes));
  });

  it('5.5.1 output keeps Ancestry custom tags and declares UTF-8', async () => {
    const store = await importInto(read('ancestry-sample.ged'));
    const out = exportGedcom(store, { version: '5.5.1', now: TODAY });
    const head = parseGedcom(out).header;
    expect(head.charset).toBe('UTF-8');
    expect(head.version).toBe('5.5.1');
    expect(head.form).toBe('LINEAGE-LINKED');
    expect(head.source?.system).toBe('Ancestry.com Family Trees');
    for (const tag of ['_APID', '_MTTAG', '_OID', '_PHOTO', '_PRIM', '_FREL', '_MREL', '_MILT']) {
      expect(out).toMatch(new RegExp(`^\\d ${tag}\\b`, 'm'));
    }
  });

  it('rewrites an ANSEL header to UTF-8 and keeps the decoded text', async () => {
    const store = await importInto(read('gedcom/ansel.ged'));
    const out = exportGedcom(store, { version: '5.5.1', now: TODAY });
    expect(out).toContain('1 CHAR UTF-8');
    expect(out).not.toContain('ANSEL');
    expect(parseGedcom(new TextEncoder().encode(out)).warnings).toEqual([]);
  });
});

describe('GEDCOM 7 export', { timeout: 30_000 }, () => {
  it.each(FIXTURE_FILES)(
    '%s: valid GEDCOM 7 that re-imports to the same domain model',
    async (file) => {
      const store = await importInto(read(file));
      const out = buildGedcomExport(store, { version: '7', now: TODAY });
      expect(gedcom7Problems(out.text)).toEqual([]);
      const again = await importInto(out.text);
      expect(rows(again, 'SELECT format FROM import_batch')).toEqual([{ format: 'gedcom-7' }]);
      expect(importedSnapshot(again)).toEqual(
        domainSnapshot(store, (_table, id) => out.xrefs.get(id)!),
      );
    },
  );

  it('writes dates, ages and names in GEDCOM 7 grammar with the original as PHRASE', async () => {
    const store = await importInto(read('ancestry-sample.ged'));
    const out = exportGedcom(store, { version: '7', now: TODAY });
    expect(out).toContain('2 DATE ABT 1842\n3 PHRASE Abt. 1842');
    expect(out).toContain('2 DATE 28 MAY 1960\n3 PHRASE 05/28/1960');
    expect(out).toContain('2 DATE 4 NOV 1911\n3 PHRASE 4 Nov 1911');
    expect(out).toContain('2 DATE BEF 1920\n');
    expect(out).not.toContain('PHRASE BEF 1920');
    expect(out).toMatch(/^1 SCHMA\n(2 TAG _\w+ https:\/\/\S+\n)+/m);
    expect(out.startsWith('0 HEAD\n1 GEDC\n2 VERS 7.0\n')).toBe(true);
  });

  it('re-exports a GEDCOM 7 import as GEDCOM 5.5.1 that re-imports the same', async () => {
    const store = await importInto(read('gedcom/gedcom7.ged'));
    const out = buildGedcomExport(store, { version: '5.5.1', now: TODAY });
    expect(out.text).toContain('1 NOTE @@handle on the forum');
    expect(out.text).toContain('1 _SKYPEID quill.b');
    const again = await importInto(out.text);
    expect(importedSnapshot(again)).toEqual(
      domainSnapshot(store, (_table, id) => out.xrefs.get(id)!),
    );
  });
});

describe('GEDCOM 5.5.1 export that is generated, not copied', { timeout: 30_000 }, () => {
  it.each(FIXTURE_FILES)(
    '%s: privatize off, every record regenerated, same domain',
    async (file) => {
      const store = await importInto(read(file));
      // Dropping raw_record forces every record through the canonical writer.
      store.db.exec('DELETE FROM raw_record');
      const out = buildGedcomExport(store, { version: '5.5.1', now: TODAY });
      expect(out.stats.verbatim).toBe(0);
      const again = await importInto(out.text);
      expect(importedSnapshot(again)).toEqual(
        domainSnapshot(store, (_table, id) => out.xrefs.get(id)!),
      );
    },
  );
});

describe('calendar dates', { timeout: 30_000 }, () => {
  // [GEDCOM 5.5.1 DATE, the GEDCOM 7 DATE it exports as]
  const CALENDAR_DATES: [string, string][] = [
    ['@#DJULIAN@ 1 MAR 1700', 'JULIAN 1 MAR 1700'],
    ['@#DJULIAN@ 11 FEB 1731/32', 'JULIAN 11 FEB 1732'],
    ['11 FEB 1731/32', 'JULIAN 11 FEB 1732'],
    ['@#DGREGORIAN@ 5 SEP 1941', '5 SEP 1941'],
    ['@#DHEBREW@ 1 TSH 5780', 'HEBREW 1 TSH 5780'],
    ['@#DHEBREW@ ADS 5784', 'HEBREW ADS 5784'],
    ['@#DFRENCH R@ 1 VEND 10', 'FRENCH_R 1 VEND 10'],
    ['@#DFRENCH R@ 5 COMP 3', 'FRENCH_R 5 COMP 3'],
    ['44 B.C.', '44 BCE'],
    ['@#DJULIAN@ 15 MAR 44 B.C.', 'JULIAN 15 MAR 44 BCE'],
    ['ABT @#DFRENCH R@ 5', 'ABT FRENCH_R 5'],
    ['BEF @#DJULIAN@ 1752', 'BEF JULIAN 1752'],
    ['BET @#DJULIAN@ 1700 AND @#DJULIAN@ 1701', 'BET JULIAN 1700 AND JULIAN 1701'],
    ['FROM @#DHEBREW@ TSH 5700 TO @#DHEBREW@ ELL 5710', 'FROM HEBREW TSH 5700 TO HEBREW ELL 5710'],
    // Old Style to New Style: the end is Gregorian and must stay Gregorian.
    ['BET @#DJULIAN@ 1 JAN 1751 AND 1 JAN 1753', 'BET JULIAN 1 JAN 1751 AND 1 JAN 1753'],
    ['FROM 1700 TO @#DJULIAN@ 1710', 'FROM 1700 TO JULIAN 1710'],
    ['@#DUNKNOWN@ 1900', '1900'],
  ];
  const source = ged(
    '0 @I1@ INDI',
    '1 NAME Ada /Calendar/',
    ...CALENDAR_DATES.flatMap(([date], i) => ['1 EVEN', `2 TYPE Calendar ${i}`, `2 DATE ${date}`]),
  );

  it('exports valid GEDCOM 7 calendar dates with the original as PHRASE', async () => {
    const store = await importInto(source);
    const out = exportGedcom(store, { version: '7', now: TODAY });
    expect(gedcom7Problems(out)).toEqual([]);
    for (const [original, v7] of CALENDAR_DATES) {
      const phrase = original.startsWith('@') ? `@${original}` : original;
      expect(out).toContain(`2 DATE ${v7}\n3 PHRASE ${phrase}\n`);
    }
  });

  it('round trips 5.5.1 -> 7 -> 5.5.1 without losing a date', async () => {
    const store = await importInto(source);
    const v7 = buildGedcomExport(store, { version: '7', now: TODAY });
    const fromV7 = await importInto(v7.text);
    expect(importedSnapshot(fromV7)).toEqual(
      domainSnapshot(store, (_table, id) => v7.xrefs.get(id)!),
    );
    const v551 = buildGedcomExport(fromV7, { version: '5.5.1', now: TODAY });
    for (const [original] of CALENDAR_DATES) expect(v551.text).toContain(`2 DATE ${original}\n`);
    const again = await importInto(v551.text);
    expect(importedSnapshot(again)).toEqual(importedSnapshot(fromV7));
  });
});

describe('decade and century periods', () => {
  const periods = [
    'FROM 1850s',
    'TO 1850s',
    'FROM 1850s TO 1860s',
    'FROM 1700s TO 1800s',
    'TO 2000s',
  ];

  it('keep their text and parsed columns through a GEDCOM 5.5.1 and 7 round trip', async () => {
    const store = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 NAME Odile /Fernsby/',
        ...periods.flatMap((date) => ['1 RESI', `2 DATE ${date}`]),
      ),
    );
    const columns = (s: typeof store) =>
      rows(
        s,
        `SELECT date_text, date_qualifier, date_sort, date_sort_end, calendar FROM event
         JOIN event_role r ON r.event_id = event.id ORDER BY r.sort_order`,
      );
    const before = columns(store);
    expect(before.map((e) => e.date_qualifier)).toEqual(['from', 'to', 'from_to', 'from_to', 'to']);
    const seven = exportGedcom(store, { version: '7', now: TODAY });
    expect(seven).toContain('2 DATE FROM 1850\n3 PHRASE FROM 1850s');
    expect(seven).toContain('2 DATE FROM 1850 TO 1869\n3 PHRASE FROM 1850s TO 1860s');
    expect(gedcom7Problems(seven)).toEqual([]);
    expect(columns(await importInto(seven))).toEqual(before);
    store.db.exec('DELETE FROM raw_record');
    expect(columns(await importInto(exportGedcom(store, { now: TODAY })))).toEqual(before);
  });
});

describe(
  'dual-dated leap days and qualified dates with a phrase (#272)',
  { timeout: 30_000 },
  () => {
    const source = ged(
      '0 @I1@ INDI',
      '1 NAME Ada /Leap/',
      '1 BIRT',
      '2 DATE 29 FEB 1751/52',
      '1 RESI',
      '2 DATE BEF 1850 (per census)',
    );

    it('writes GEDCOM 7 with the new-style year and the qualifier, the original as PHRASE', async () => {
      const store = await importInto(source);
      const out = exportGedcom(store, { version: '7', now: TODAY });
      expect(gedcom7Problems(out)).toEqual([]);
      // An Old Style (Julian) day in its new-style year.
      expect(out).toContain('2 DATE JULIAN 29 FEB 1752\n3 PHRASE 29 FEB 1751/52\n');
      expect(out).toContain('2 DATE BEF 1850\n3 PHRASE BEF 1850 (per census)\n');
      const again = await importInto(out);
      expect(rows(again, 'SELECT date_text, date_qualifier FROM event ORDER BY date_text')).toEqual(
        [
          { date_text: '29 FEB 1751/52', date_qualifier: 'exact' },
          { date_text: 'BEF 1850 (per census)', date_qualifier: 'before' },
        ],
      );
      // Sorted as the Julian day the export names, before and after (#298).
      const sortOf = (s: typeof store) =>
        rows(s, "SELECT date_sort FROM event WHERE date_text = '29 FEB 1751/52'");
      expect(sortOf(store)).toEqual([{ date_sort: 17520311 }]);
      expect(sortOf(again)).toEqual(sortOf(store));
      expect(parseDate('JULIAN 29 FEB 1752').sortKey).toBe(17520311);
    });

    it('keeps both dates as written in GEDCOM 5.5.1', async () => {
      const store = await importInto(source);
      store.db.exec('DELETE FROM raw_record');
      const out = exportGedcom(store, { version: '5.5.1', now: TODAY });
      expect(out).toContain('2 DATE 29 FEB 1751/52\n');
      expect(out).toContain('2 DATE BEF 1850 (per census)\n');
    });
  },
);
