import { openTree } from '@open-ancestry/db';
import { importGedcom } from '@open-ancestry/import';
import { unzipSync, zipSync } from 'fflate';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildGedzipExport, planGedzipExport, streamGedzip } from './index';
import { TODAY } from './test-helpers';
import { makeTempDir } from '../../../fixtures/temp-dir';

/*
 * Issue #263: a privatized GEDZIP copied media bytes as they were, so a
 * photo's EXIF artist and GPS, its JPEG comment, PNG text chunks and WebP
 * EXIF and XMP could name a living person. Every name and coordinate below
 * is synthetic.
 */

const SECRET = 'Zedekiah Livingson';
const GPS_TEXT = '40.7128N 74.0060W';
const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${SECRET}</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>`;
const EXIF = {
  IFD0: { Artist: SECRET, ImageDescription: `${SECRET} at ${GPS_TEXT}` },
  IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 42/1 46/1' },
};
const latin1 = (text: string) => Buffer.from(text, 'latin1');
const leaks = (bytes: Uint8Array) =>
  ['Zedekiah', 'Livingson', GPS_TEXT].filter((s) => Buffer.from(bytes).includes(s));

/** A JPEG segment: marker, then length (which counts itself) and data. */
const segment = (marker: number, data: Buffer) =>
  Buffer.concat([
    Buffer.from([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 255]),
    data,
  ]);

/** A PNG chunk with its CRC. */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([latin1(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Inserts PNG chunks just before IEND. */
function withPngChunks(png: Buffer, chunks: Buffer[]): Buffer {
  const iend = png.length - 12;
  return Buffer.concat([png.subarray(0, iend), ...chunks, png.subarray(iend)]);
}

let jpeg: Buffer;
let png: Buffer;
let webp: Buffer;
const pdf = latin1(`%PDF-1.4\n1 0 obj << /Author (${SECRET}) >> endobj\n%%EOF\n`);

beforeAll(async () => {
  const image = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#4a7' } });
  const base = await image().jpeg().withIccProfile('srgb').withExif(EXIF).withXmp(XMP).toBuffer();
  // A COM segment and an IPTC (APP13) segment after SOI, as cameras and editors write them.
  jpeg = Buffer.concat([
    base.subarray(0, 2),
    segment(0xfe, latin1(`Photo of ${SECRET}`)),
    segment(0xed, Buffer.concat([latin1('Photoshop 3.0\0'), latin1(SECRET)])),
    base.subarray(2),
  ]);
  const plainPng = await image().png().withExif(EXIF).withXmp(XMP).toBuffer();
  png = withPngChunks(plainPng, [
    pngChunk('tEXt', latin1(`Author\0${SECRET}`)),
    pngChunk('zTXt', Buffer.concat([latin1('Comment\0\0'), deflateSync(latin1(SECRET))])),
    pngChunk('iTXt', latin1(`Title\0\0\0\0\0${SECRET}`)),
  ]);
  webp = await image().webp().withExif(EXIF).withXmp(XMP).toBuffer();
  for (const fixture of [jpeg, png, webp]) expect(leaks(fixture).length).toBeGreaterThan(0);
});

async function tree() {
  const dir = join(makeTempDir('oa-strip-'), 'Photos.oatree');
  const gedcom = [
    '0 HEAD',
    '1 GEDC',
    '2 VERS 5.5.1',
    '0 @I1@ INDI',
    `1 NAME Zedekiah /Livingson/`,
    '1 BIRT',
    '2 DATE 2001',
    '0 @I2@ INDI',
    '1 NAME Abner /Oldline/',
    '1 DEAT',
    '2 DATE 1920',
    ...['O1', 'O2', 'O3', 'O4'].map((x) => `1 OBJE @${x}@`),
    '0 @O1@ OBJE',
    '1 FILE photos/abner.jpg',
    '2 FORM jpg',
    '0 @O2@ OBJE',
    '1 FILE photos/abner.png',
    '2 FORM png',
    '0 @O3@ OBJE',
    '1 FILE photos/abner.webp',
    '2 FORM webp',
    '0 @O4@ OBJE',
    '1 FILE papers/abner.pdf',
    '2 FORM pdf',
    '0 TRLR',
    '',
  ].join('\n');
  const archive = zipSync({
    'gedcom.ged': new TextEncoder().encode(gedcom),
    'photos/abner.jpg': jpeg,
    'photos/abner.png': png,
    'photos/abner.webp': webp,
    'papers/abner.pdf': pdf,
  });
  await importGedcom({ gedzip: archive }, { dir }, { today: TODAY });
  return openTree(dir);
}

async function expectClean(files: Record<string, Uint8Array>) {
  for (const name of ['photos/abner.jpg', 'photos/abner.png', 'photos/abner.webp']) {
    const bytes = files[name];
    expect(bytes, name).toBeDefined();
    expect(leaks(bytes!), name).toEqual([]);
    // Still a valid image of the same size, with no EXIF or XMP left.
    const meta = await sharp(bytes!).metadata();
    expect([meta.width, meta.height, meta.exif, meta.xmp], name).toEqual([
      8,
      8,
      undefined,
      undefined,
    ]);
    await sharp(bytes!).raw().toBuffer();
  }
  // JFIF and the ICC profile stay: they hold no one's name and change how the image looks.
  const jpegMeta = await sharp(files['photos/abner.jpg']!).metadata();
  expect(jpegMeta.icc).toBeDefined();
  // A file whose metadata cannot be removed is left out.
  expect(files['papers/abner.pdf']).toBeUndefined();
}

describe('privatized GEDZIP media metadata (#263)', () => {
  it('streams photos without EXIF, GPS, comments, text chunks or XMP, and leaves out a PDF', async () => {
    const store = await tree();
    const plan = planGedzipExport(store, { privatizeLiving: true, now: TODAY });
    expect(plan.warnings.join('\n')).toMatch(/papers\/abner\.pdf was left out/);
    const files = unzipSync(await buffer(streamGedzip(plan)));
    await expectClean(files);
    store.close();
  });

  it('strips the same metadata in the in-memory build', async () => {
    const store = await tree();
    const built = buildGedzipExport(store, { privatizeLiving: true, now: TODAY });
    await expectClean(unzipSync(built.bytes));
    store.close();
  });

  it('copies every file byte for byte when not privatizing', async () => {
    const store = await tree();
    const streamed = unzipSync(await buffer(streamGedzip(planGedzipExport(store, { now: TODAY }))));
    const built = unzipSync(buildGedzipExport(store, { now: TODAY }).bytes);
    for (const files of [streamed, built]) {
      expect(Buffer.from(files['photos/abner.jpg']!).equals(jpeg)).toBe(true);
      expect(Buffer.from(files['photos/abner.png']!).equals(png)).toBe(true);
      expect(Buffer.from(files['photos/abner.webp']!).equals(webp)).toBe(true);
      expect(Buffer.from(files['papers/abner.pdf']!).equals(pdf)).toBe(true);
    }
    store.close();
  });
});
