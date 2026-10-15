import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { importInto, ged, rows } from './test-helpers';
import { importGedcom } from './import';
import { openMemoryTree } from '@open-ancestry/db';
import { TODAY } from './test-helpers';

const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** The header of a PNG: enough for its size to be read. */
const pngHeader = (width: number, height: number) =>
  new Uint8Array([
    0x89,
    ...ascii('PNG\r\n\x1a\n'),
    ...u32be(13),
    ...ascii('IHDR'),
    ...u32be(width),
    ...u32be(height),
    8,
    2,
    0,
    0,
    0,
  ]);

describe('media size at import', () => {
  it('records the pixel size of a linked image, so clients can pick thumbnails without probing', async () => {
    const zip = zipSync({
      'gedcom.ged': new TextEncoder().encode(
        ged(
          '0 @I1@ INDI',
          '1 OBJE',
          '2 FILE photos/scan.png',
          '3 FORM png',
          '1 OBJE',
          '2 FILE notes.txt',
        ),
      ),
      'photos/scan.png': pngHeader(300, 200),
      'notes.txt': new TextEncoder().encode('not an image'),
    });
    const store = openMemoryTree();
    await importGedcom({ gedzip: zip, fileName: 'f.gdz' }, store, { today: TODAY });
    expect(rows(store, 'SELECT local_path, width, height FROM media ORDER BY local_path')).toEqual([
      { local_path: 'notes.txt', width: null, height: null },
      { local_path: 'photos/scan.png', width: 300, height: 200 },
    ]);
  });

  it('keeps the size Ancestry wrote (_WDTH, _HGHT) for files it cannot read', async () => {
    const { store } = await importInto(
      ged('0 @O1@ OBJE', '1 FILE https://www.ancestry.com/x.jpg', '1 _WDTH 640', '1 _HGHT 480'),
    );
    expect(rows(store, 'SELECT width, height FROM media')).toEqual([{ width: 640, height: 480 }]);
  });
});
