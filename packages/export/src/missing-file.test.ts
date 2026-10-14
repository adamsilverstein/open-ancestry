import { describe, expect, it } from 'vitest';
import { buildGedcomExport } from './gedcom';
import { fileProblems, gedcom7Problems, ged, importInto, rows, TODAY } from './test-helpers';

/*
 * Issue #196: media whose file was missing at import kept no path, so every
 * generated export (GEDCOM 7, GEDZIP, privatized) wrote an empty FILE line.
 */

const FILE = ged(
  '0 @I1@ INDI',
  '1 NAME Ada /Vale/',
  '1 BIRT',
  '2 DATE 1890',
  '1 OBJE',
  '2 FILE photos/liv ëa.jpg',
  '3 FORM jpg',
  '1 OBJE @O1@',
  '0 @O1@ OBJE',
  '1 FILE scans/rec.jpg',
  '2 FORM jpg',
  '2 TITL Record',
);

const fileLines = (text: string) => text.split('\n').filter((l) => / FILE\b/.test(l));

describe('media missing at import (#196)', () => {
  it('keeps the inline OBJE FILE line with the media it belongs to', async () => {
    const store = await importInto(FILE);
    const media = rows<{ id: string; local_path: string | null }>(
      store,
      'SELECT m.id, m.local_path FROM media m WHERE m.external_id IS NULL',
    );
    expect(media).toHaveLength(1);
    expect(
      rows(store, "SELECT owner_type, owner_id, line FROM unmapped_line WHERE path LIKE '%.FILE'"),
    ).toContainEqual({
      owner_type: 'media',
      owner_id: media[0]!.id,
      line: '2 FILE photos/liv ëa.jpg',
    });
  });

  it.each([
    ['GEDCOM 7', { version: '7' }],
    ['GEDCOM 7, privatized', { version: '7', privatizeLiving: true }],
    ['GEDCOM 5.5.1, privatized', { version: '5.5.1', privatizeLiving: true }],
  ] as const)('%s keeps the original paths and writes no empty FILE', async (_, options) => {
    const store = await importInto(FILE);
    const out = buildGedcomExport(store, { ...options, now: TODAY });
    expect(fileProblems(out.text)).toEqual([]);
    const v7 = options.version === '7';
    expect(fileLines(out.text)).toEqual([
      '1 FILE scans/rec.jpg',
      v7 ? '1 FILE photos/liv%20%C3%ABa.jpg' : '1 FILE photos/liv ëa.jpg',
    ]);
    if (v7) expect(gedcom7Problems(out.text)).toEqual([]);
    expect(out.warnings.filter((w) => /FILE/.test(w))).toEqual([]);
  });

  it('leaves out media it has no path for, with a warning, rather than an empty FILE', async () => {
    const store = await importInto(FILE);
    // A tree imported before the FILE line was kept with its media.
    store.db
      .prepare(
        "UPDATE unmapped_line SET owner_type = 'person', owner_id = (SELECT id FROM person) WHERE owner_type = 'media' AND path LIKE 'INDI.%'",
      )
      .run();
    const out = buildGedcomExport(store, { version: '7', now: TODAY });
    expect(fileProblems(out.text)).toEqual([]);
    expect(gedcom7Problems(out.text)).toEqual([]);
    expect(fileLines(out.text)).toEqual(['1 FILE scans/rec.jpg']);
    expect(out.warnings).toContainEqual(expect.stringMatching(/has no file path and was left out/));
  });
});

describe('fileProblems', () => {
  it('flags a FILE line with no value', () => {
    expect(fileProblems('0 @O1@ OBJE\n1 FILE\n2 FORM jpg\n')).toEqual([
      'FILE with no value at OBJE.FILE (line 2)',
    ]);
    expect(fileProblems('0 @O1@ OBJE\n1 FILE a.jpg\n')).toEqual([]);
  });
});
