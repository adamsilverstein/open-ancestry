import { createTree } from '@open-ancestry/db';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importGedcom } from './import';
import { classifyFile, kindFromType, mediaType, MediaSource, writeMediaFile } from './media';
import { coordinate, placeParts, Places } from './places';
import { childRelationship, nameType, privacy, relationshipStatus } from './tags';
import { dateColumns, surnameKey } from './index';
import { ged } from './test-helpers';

describe('tags', () => {
  it('maps child relationships case-insensitively', () => {
    expect(childRelationship('Natural')).toBe('biological');
    expect(childRelationship(' BIRTH ')).toBe('biological');
    expect(childRelationship('Guardian')).toBe('guardian');
    expect(childRelationship('SEALING')).toBe('unknown');
    expect(childRelationship('nonsense')).toBeUndefined();
    expect(childRelationship(undefined)).toBeUndefined();
  });

  it('maps name types', () => {
    expect(nameType('MarriedName')).toBe('married');
    expect(nameType('Also Known As')).toBe('aka');
    expect(nameType('maiden')).toBe('maiden');
    expect(nameType('whatever')).toBe('other');
    expect(nameType(undefined)).toBe('other');
  });

  it('maps RESN to the most restrictive privacy level', () => {
    expect(privacy('privacy')).toBe('private');
    expect(privacy('CONFIDENTIAL, LOCKED')).toBe('locked');
    expect(privacy('LOCKED, PRIVACY')).toBe('locked');
    expect(privacy('public')).toBeUndefined();
    expect(privacy('')).toBeUndefined();
    expect(privacy(undefined)).toBeUndefined();
  });

  it('maps _STAT relationship status', () => {
    expect(relationshipStatus('Never Married')).toBe('partners');
    expect(relationshipStatus('Domestic partnership')).toBe('civil_union');
    expect(relationshipStatus('Married')).toBe('married');
    expect(relationshipStatus('Unknown')).toBe('unknown');
    expect(relationshipStatus('Engaged')).toBeUndefined();
    expect(relationshipStatus(undefined)).toBeUndefined();
  });
});

describe('places', () => {
  it('splits jurisdictions and drops empty ones', () => {
    expect(placeParts(' Elderford ,Cask  County,, Ohio ')).toEqual([
      'Elderford',
      'Cask County',
      'Ohio',
    ]);
    expect(placeParts(' , , ')).toEqual([]);
  });

  it('parses coordinates with hemispheres and signs', () => {
    expect(coordinate('N51.5', 'lat')).toBe(51.5);
    expect(coordinate('S33.9', 'lat')).toBe(-33.9);
    expect(coordinate('E151.2', 'long')).toBe(151.2);
    expect(coordinate('-71.25', 'long')).toBe(-71.25);
    expect(coordinate('W0', 'long')).toBe(-0);
    expect(coordinate('E10', 'lat')).toBeUndefined();
    expect(coordinate('N10', 'long')).toBeUndefined();
    expect(coordinate('91', 'lat')).toBeUndefined();
    expect(coordinate('abc', 'lat')).toBeUndefined();
    expect(coordinate(undefined, 'lat')).toBeUndefined();
  });

  it('reuses places and keeps the first coordinates', () => {
    let n = 0;
    const places = new Places(() => `p${n++}`);
    const id = places.resolve('A, B')!;
    expect(places.resolve('A,  B')).toBe(id);
    expect(places.resolve('')).toBeUndefined();
    expect(places.setCoordinates(id, 1, 2)).toBe(true);
    expect(places.setCoordinates(id, 1, 2)).toBe(true);
    expect(places.setCoordinates(id, 3, 4)).toBe(false);
    expect(places.setCoordinates('nope', 1, 2)).toBe(false);
    expect([...places.rows()].map((p) => p.full_name)).toEqual(['B', 'A, B']);
  });
});

describe('media helpers', () => {
  it('classifies FILE values', () => {
    expect(classifyFile('https://a.example/x.jpg')).toEqual({
      type: 'remote',
      url: 'https://a.example/x.jpg',
    });
    expect(classifyFile('photos\\a.jpg')).toEqual({ type: 'local', path: 'photos/a.jpg' });
    expect(classifyFile('./photos/./a.jpg')).toEqual({ type: 'local', path: 'photos/a.jpg' });
    expect(classifyFile('/Users/x/a.jpg')).toEqual({ type: 'absolute', name: 'a.jpg' });
    expect(classifyFile('file:///Users/x/a.jpg')).toEqual({ type: 'absolute', name: 'a.jpg' });
    expect(classifyFile('\\\\server\\share\\a.jpg')).toEqual({ type: 'absolute', name: 'a.jpg' });
    expect(classifyFile('C:\\')).toEqual({ type: 'unsafe' });
    expect(classifyFile('a/../../b.jpg')).toEqual({ type: 'unsafe' });
    expect(classifyFile('.')).toEqual({ type: 'unsafe' });
  });

  it('derives MIME types and kinds', () => {
    expect(mediaType('JPG')).toEqual({ mime: 'image/jpeg', kind: 'photo' });
    expect(mediaType('image/png')).toEqual({ mime: 'image/png', kind: 'photo' });
    expect(mediaType('application/x-unknown')).toBeUndefined();
    expect(mediaType('https://x.example/a.MOV?x=1')).toEqual({
      mime: 'video/quicktime',
      kind: 'video',
    });
    expect(mediaType('notes.xyz')).toBeUndefined();
    expect(mediaType('')).toBeUndefined();
    expect(kindFromType('Audio recording')).toBe('audio');
    expect(kindFromType('film')).toBe('video');
    expect(kindFromType('Tombstone')).toBe('photo');
    expect(kindFromType('certificate')).toBe('document');
    expect(kindFromType(' ')).toBeUndefined();
  });

  it('matches by unique file name only', () => {
    const source = MediaSource.fromEntries(
      new Map([
        ['a/x.jpg', new Uint8Array([1])],
        ['b/x.jpg', new Uint8Array([2])],
        ['c/y.jpg', new Uint8Array([3])],
      ]),
    );
    expect(source.find({ type: 'local', path: 'A/X.JPG' })?.path).toBe('a/x.jpg');
    expect(source.find({ type: 'absolute', name: 'x.jpg' })).toBeUndefined();
    expect(source.find({ type: 'absolute', name: 'Y.jpg' })?.path).toBe('c/y.jpg');
    expect(source.find({ type: 'local', path: 'elsewhere/y.jpg' })?.path).toBe('c/y.jpg');
    expect(source.find({ type: 'remote', url: 'https://x' })).toBeUndefined();
    expect(MediaSource.none().available).toBe(false);
  });

  it('refuses to write outside the media folder', () => {
    expect(() => writeMediaFile('/tmp/oa-media-root', '../escape.jpg', new Uint8Array())).toThrow(
      /unsafe/,
    );
  });
});

describe('media folder edge cases', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'oa-media-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('skips file names that cannot be stored and reports copy failures as warnings', async () => {
    const source = join(tmp, 'src');
    mkdirSync(join(source, 'photos'), { recursive: true });
    writeFileSync(join(source, 'photos', 'a.jpg'), 'a');
    writeFileSync(join(source, 'odd\\name.jpg'), 'b');
    const dir = join(tmp, 't.oatree');
    const store = createTree(dir);
    // A file where the importer needs a folder makes the copy fail.
    writeFileSync(join(dir, 'media', 'photos'), 'in the way');
    const report = await importGedcom(
      {
        bytes: ged(
          '0 @O1@ OBJE',
          '1 FILE photos/a.jpg',
          '0 @O2@ OBJE',
          '1 FILE odd\\name.jpg',
          '0 @O3@ OBJE',
          '1 FILE D:\\nowhere\\gone.jpg',
        ),
      },
      store,
      { mediaDir: source },
    );
    expect(report.warnings.map((w) => w.code)).toEqual([
      'media-copy-failed',
      'media-missing',
      'media-missing',
    ]);
    expect(report.media.linked).toBe(0);
    expect(report.unmapped.map((u) => u.path)).toEqual(['OBJE.FILE']);
    expect(report.media.missing.map((m) => m.path)).toEqual([
      'odd/name.jpg',
      'D:\\nowhere\\gone.jpg',
    ]);
    store.close();
  });

  it('ignores an unreadable media folder', () => {
    expect(
      MediaSource.fromDir(join(tmp, 'missing')).find({ type: 'absolute', name: 'a.jpg' }),
    ).toBeUndefined();
  });
});

describe('shared derived columns', () => {
  it('computes surname keys and date columns the same way the importer does', () => {
    expect(surnameKey('Ashgrove')).toMatch(/\bA261\b/);
    expect(surnameKey('')).toBeNull();
    expect(surnameKey(null)).toBeNull();
    expect(dateColumns('BET 1870 AND 1872')).toMatchObject({
      date_qualifier: 'between',
      calendar: null,
    });
    expect(dateColumns('@#DJULIAN@ 5 SEP 1700')).toMatchObject({ calendar: 'julian' });
    expect(dateColumns('sometime')).toEqual({
      date_text: 'sometime',
      date_qualifier: 'text',
      date_sort: null,
      date_sort_end: null,
      calendar: null,
    });
  });
});
