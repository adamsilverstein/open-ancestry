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
