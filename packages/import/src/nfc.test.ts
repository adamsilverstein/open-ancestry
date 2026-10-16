import { openTree } from '@open-ancestry/db';
import { zipSync } from 'fflate';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { importGedcom } from './import';
import { MediaSource, classifyFile } from './media';
import { TODAY, ged, importInto, rows, value } from './test-helpers';
import { makeTempDir } from '../../../fixtures/temp-dir';

const NFD = (s: string) => s.normalize('NFD');
const NFC = (s: string) => s.normalize('NFC');
const enc = (s: string) => new TextEncoder().encode(s);

let tmp: string;
beforeEach(() => {
  tmp = makeTempDir('oa-nfc-');
});

describe('NFD text in a GEDCOM file', () => {
  const file = ged(
    '0 @I1@ INDI',
    `1 NAME ${NFD('José /Müller/')}`,
    '1 BIRT',
    `2 PLAC ${NFD('Zürich, Schweiz')}`,
    `1 NOTE ${NFD('Geboren in Zürich')}`,
    '1 _MTTAG @T1@',
    '1 _MTTAG @T2@',
    '0 @I2@ INDI',
    '1 NAME B /C/',
    '1 BIRT',
    `2 PLAC ${NFC('Zürich, Schweiz')}`,
    '0 @T1@ _MTTAG',
    `1 NAME ${NFC('Geprüft')}`,
    '0 @T2@ _MTTAG',
    `1 NAME ${NFD('Geprüft')}`,
  );

  it('dedupes places written in NFD and NFC to one row per level', async () => {
    const { store } = await importInto(file);
    expect(rows(store, 'SELECT full_name FROM place ORDER BY full_name')).toEqual([
      { full_name: 'Schweiz' },
      { full_name: NFC('Zürich, Schweiz') },
    ]);
    expect(value(store, 'SELECT count(DISTINCT place_id) FROM event')).toBe(1);
  });

  it('stores names, notes and tags as NFC', async () => {
    const { store } = await importInto(file);
    expect(rows(store, "SELECT given, surname FROM person_name WHERE surname <> 'C'")).toEqual([
      { given: NFC('José'), surname: NFC('Müller') },
    ]);
    expect(value(store, 'SELECT text FROM note')).toBe(NFC('Geboren in Zürich'));
    expect(rows(store, 'SELECT name FROM tag')).toEqual([{ name: NFC('Geprüft') }]);
  });

  it('keeps raw_record byte-exact, so the original NFD text round-trips', async () => {
    const { store } = await importInto(file);
    const raw = value<string>(store, "SELECT raw_text FROM raw_record WHERE xref = '@I1@'");
    expect(raw).toContain(`1 NAME ${NFD('José /Müller/')}`);
    expect(raw).toContain(`2 PLAC ${NFD('Zürich, Schweiz')}`);
  });

  it('keeps unmapped lines verbatim', async () => {
    const { store } = await importInto(ged('0 @I1@ INDI', `1 _CUSTOM ${NFD('Zoë')}`));
    expect(value(store, 'SELECT line FROM unmapped_line')).toBe(`1 _CUSTOM ${NFD('Zoë')}`);
  });

  it('names the tree in NFC', async () => {
    const dir = join(tmp, 'named.oatree');
    await importGedcom(
      { bytes: ged('0 @I1@ INDI'), fileName: `${NFD('Familie Müller')}.ged` },
      { dir },
      { today: TODAY },
    );
    const store = openTree(dir);
    expect(value(store, "SELECT value FROM meta WHERE key = 'tree_name'")).toBe(
      NFC('Familie Müller'),
    );
    store.close();
  });
});

describe('media paths in different normalization forms', () => {
  const zoeNFC = NFC('photos/Zoë.jpg');
  const zoeNFD = NFD('photos/Zoë.jpg');
  const mediaGed = (path: string) => ged('0 @I1@ INDI', '1 OBJE', `2 FILE ${path}`, '3 FORM jpg');

  it.each([
    ['NFC FILE, NFD zip entry', zoeNFC, zoeNFD],
    ['NFD FILE, NFC zip entry', zoeNFD, zoeNFC],
  ])('links a GEDZIP entry: %s', async (_, filePath, entryPath) => {
    const zip = zipSync({ 'gedcom.ged': enc(mediaGed(filePath)), [entryPath]: enc('jpeg-bytes') });
    const dir = join(tmp, 'z.oatree');
    const report = await importGedcom(
      { gedzip: zip, fileName: 'f.gdz' },
      { dir },
      { today: TODAY },
    );
    expect(report.media).toMatchObject({ linked: 1, missing: [] });
    const store = openTree(dir);
    // Stored under its NFC name, and the file is where local_path says.
    expect(value(store, 'SELECT local_path FROM media')).toBe(zoeNFC);
    store.close();
    expect(readdirSync(join(dir, 'media', 'photos'))).toEqual([NFC('Zoë.jpg')]);
  });

  it('links a macOS-style NFD file name in a media folder', async () => {
    const media = join(tmp, 'media-src');
    mkdirSync(join(media, 'photos'), { recursive: true });
    // macOS file APIs hand back decomposed names; write one that way.
    writeFileSync(join(media, NFD('photos/Zoë.jpg')), 'jpeg-bytes');
    const { report } = await importInto(mediaGed(zoeNFC), { mediaDir: media });
    expect(report.media).toMatchObject({ linked: 1, missing: [] });
  });

  it('matches case-insensitively and by file name across normalization forms', () => {
    const source = MediaSource.fromEntries(new Map([[NFD('Photos/ZOË.JPG'), enc('x')]]));
    expect(source.find(classifyFile(NFC('photos/zoë.jpg')))).toBeDefined();
    expect(source.find(classifyFile(NFC('C:\\pics\\zoë.jpg')))).toBeDefined();
  });

  it('decodes percent-encoded GEDCOM 7 paths to NFC', async () => {
    const encoded = encodeURI(zoeNFD);
    const zip = zipSync({
      'gedcom.ged': enc(
        [
          '0 HEAD',
          '1 GEDC',
          '2 VERS 7.0',
          '0 @I1@ INDI',
          '1 OBJE @O1@',
          '0 @O1@ OBJE',
          `1 FILE ${encoded}`,
          '2 FORM image/jpeg',
          '0 TRLR',
          '',
        ].join('\n'),
      ),
      [zoeNFC]: enc('jpeg-bytes'),
    });
    const dir = join(tmp, 'g7.oatree');
    const report = await importGedcom(
      { gedzip: zip, fileName: 'g7.gdz' },
      { dir },
      { today: TODAY },
    );
    expect(report.media).toMatchObject({ linked: 1, missing: [] });
  });
});
