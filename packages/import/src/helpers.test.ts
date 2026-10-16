import { createTree } from '@open-ancestry/db';
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { importGedcom } from './import';
import {
  classifyFile,
  kindFromType,
  mediaType,
  MediaSource,
  storeMediaFile,
  suffixedPath,
} from './media';
import { coordinate, placeParts, Places } from './places';
import { childRelationship, morePrivate, nameType, privacy, relationshipStatus } from './tags';
import { dateColumns, surnameKey } from './index';
import { ged } from './test-helpers';
import { makeTempDir } from '../../../fixtures/temp-dir';

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

  it('maps RESN to the most restrictive privacy level, locked below private', () => {
    expect(privacy('privacy')).toBe('private');
    expect(privacy('locked')).toBe('locked');
    expect(privacy('CONFIDENTIAL, LOCKED')).toBe('confidential');
    expect(privacy('LOCKED, PRIVACY')).toBe('private');
    expect(privacy('locked, privacy')).toBe('private');
    expect(privacy('public')).toBeUndefined();
    expect(privacy('')).toBeUndefined();
    expect(privacy(undefined)).toBeUndefined();
  });

  it('fails closed on RESN text it cannot read exactly', () => {
    expect(privacy('locked confidential')).toBe('confidential');
    expect(privacy('privacy.')).toBe('private');
    expect(privacy('confidential\n(family request)')).toBe('confidential');
    expect(privacy('Confidentiality')).toBe('confidential');
    expect(privacy('restricted')).toBe('private');
    expect(privacy('locked; do not share')).toBe('private');
  });

  it('orders privacy levels with locked below private', () => {
    expect(morePrivate('locked', 'private')).toBe('private');
    expect(morePrivate('confidential', 'locked')).toBe('confidential');
    expect(morePrivate('public', 'locked')).toBe('locked');
    expect(morePrivate(undefined, 'private')).toBe('private');
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
    expect(() =>
      storeMediaFile('/tmp/oa-media-root', '../escape.jpg', new Uint8Array(), () => 'h'),
    ).toThrow(/unsafe/);
  });

  it('suffixes names before the extension', () => {
    expect(suffixedPath('photos/a.jpg', 2)).toBe('photos/a-2.jpg');
    expect(suffixedPath('photos/README', 3)).toBe('photos/README-3');
    expect(suffixedPath('a.b/.hidden', 2)).toBe('a.b/.hidden-2');
    expect(suffixedPath('scan.tar.gz', 2)).toBe('scan.tar-2.gz');
  });
});

describe('media folder edge cases', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTempDir('oa-media-');
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
    // Reported under media and warnings, not again as unmapped tags (issue #121).
    expect(report.unmapped.map((u) => u.path)).toEqual([]);
    expect(report.media.missing.map((m) => m.path)).toEqual([
      'odd/name.jpg',
      'D:\\nowhere\\gone.jpg',
    ]);
    store.close();
  });

  it('refuses to read a file swapped for another, or for a link, after the folder was read (#266)', () => {
    const source = join(tmp, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'a.jpg'), 'a');
    writeFileSync(join(source, 'b.jpg'), 'b');
    const media = MediaSource.fromDir(source);
    // Swapped after the walk: another file now has the name.
    writeFileSync(join(tmp, 'other.jpg'), 'other');
    renameSync(join(tmp, 'other.jpg'), join(source, 'a.jpg'));
    expect(() => media.find({ type: 'local', path: 'a.jpg' })!.read()).toThrow(
      /a\.jpg changed after the media folder was read/,
    );
    // Replaced by a symlink: never followed.
    rmSync(join(source, 'b.jpg'));
    symlinkSync(join(tmp, 'other.jpg'), join(source, 'b.jpg'));
    expect(() => media.find({ type: 'local', path: 'b.jpg' })!.read()).toThrow();
  });

  it('refuses a file that grew after the folder was read, without reading it all (#266)', () => {
    const source = join(tmp, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'a.jpg'), 'small');
    const media = MediaSource.fromDir(source);
    const file = media.find({ type: 'local', path: 'a.jpg' })!;
    expect(file.size).toBe(5);
    // Same file, same single link: only its size changed, past what was checked.
    appendFileSync(join(source, 'a.jpg'), 'x'.repeat(1024 * 1024));
    expect(() => file.read()).toThrow(/a\.jpg changed after the media folder was read/);
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

describe('spilling media to disk', () => {
  it.skipIf(process.platform === 'win32')(
    'writes spilled files private to the owner (#267)',
    () => {
      const dir = makeTempDir('oa-spill-');
      const source = MediaSource.fromEntries(
        new Map([['photos/a.jpg', new TextEncoder().encode('bytes')]]),
      );
      const spilled = source.spill(dir);
      expect(statSync(join(dir, 'photos', 'a.jpg')).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'photos')).mode & 0o777).toBe(0o700);
      expect(spilled.find({ type: 'local', path: 'photos/a.jpg' } as never)).toBeTruthy();
    },
  );
});

describe('storing media in a tree', () => {
  let root: string;
  const hash = (b: Uint8Array) => Buffer.from(b).toString('hex');
  beforeEach(() => {
    root = makeTempDir('oa-store-');
  });

  it.skipIf(process.platform === 'win32')('writes media private to the owner (0600)', () => {
    const enc = new TextEncoder().encode('bytes');
    const stored = storeMediaFile(root, 'p/private.jpg', enc, hash);
    expect(statSync(join(root, 'p', 'private.jpg')).mode & 0o777).toBe(0o600);
    expect(stored.written).toBe(true);
  });

  it('never overwrites: same bytes are reused, different bytes get a suffix', () => {
    mkdirSync(join(root, 'p'));
    writeFileSync(join(root, 'p', 'a.jpg'), 'old');
    writeFileSync(join(root, 'p', 'a-2.jpg'), 'other');
    const enc = (t: string) => new TextEncoder().encode(t);
    expect(storeMediaFile(root, 'p/a.jpg', enc('old'), hash)).toEqual({
      path: 'p/a.jpg',
      written: false,
      folder: undefined,
    });
    expect(storeMediaFile(root, 'p/a.jpg', enc('new'), hash)).toEqual({
      path: 'p/a-3.jpg',
      written: true,
      folder: undefined,
    });
    expect(readFileSync(join(root, 'p', 'a.jpg'), 'utf8')).toBe('old');
    expect(readFileSync(join(root, 'p', 'a-2.jpg'), 'utf8')).toBe('other');
    expect(readFileSync(join(root, 'p', 'a-3.jpg'), 'utf8')).toBe('new');
    expect(storeMediaFile(root, 'q/b.jpg', enc('x'), hash).folder).toBe(join(root, 'q'));
  });

  it('never writes through or reuses a symlink inside the media folder', () => {
    const outside = makeTempDir('oa-outside-');
    try {
      symlinkSync(outside, join(root, 'linked'));
      const enc = (t: string) => new TextEncoder().encode(t);
      expect(() => storeMediaFile(root, 'linked/a.jpg', enc('x'), hash)).toThrow(
        /outside the tree/,
      );
      expect(readdirSync(outside)).toEqual([]);
      writeFileSync(join(outside, 'secret.jpg'), 'same');
      symlinkSync(join(outside, 'secret.jpg'), join(root, 'b.jpg'));
      expect(storeMediaFile(root, 'b.jpg', enc('same'), hash).path).toBe('b-2.jpg');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('never creates folders outside the tree through a symlinked folder (L3, #267)', () => {
    // Before, mkdir -p ran first and made deep/er inside the link's target,
    // then the containment check threw.
    const outside = makeTempDir('oa-outside-');
    symlinkSync(outside, join(root, 'linked'));
    const enc = new TextEncoder().encode('x');
    expect(() => storeMediaFile(root, 'linked/deep/er/a.jpg', enc, hash)).toThrow(
      /outside the tree/,
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it('keeps files already in a tree folder and stores identical content once', async () => {
    const source = join(root, 'src');
    mkdirSync(join(source, 'photos'), { recursive: true });
    writeFileSync(join(source, 'photos', 'portrait.jpg'), 'new portrait');
    writeFileSync(join(source, 'photos', 'copy.jpg'), 'new portrait');
    writeFileSync(join(source, 'photos', 'same.jpg'), 'same');
    const dir = join(root, 't.oatree');
    const store = createTree(dir);
    mkdirSync(join(dir, 'media', 'photos'));
    writeFileSync(join(dir, 'media', 'photos', 'portrait.jpg'), 'someone else');
    writeFileSync(join(dir, 'media', 'photos', 'same.jpg'), 'same');
    const report = await importGedcom(
      {
        bytes: ged(
          '0 @O1@ OBJE',
          '1 FILE photos/portrait.jpg',
          '0 @O2@ OBJE',
          '1 FILE photos/copy.jpg',
          '0 @O3@ OBJE',
          '1 FILE photos/same.jpg',
        ),
      },
      store,
      { mediaDir: source },
    );
    expect(report.media.linked).toBe(3);
    const paths = store.db
      .prepare('SELECT external_id, local_path FROM media ORDER BY external_id')
      .all();
    expect(paths).toEqual([
      { external_id: '@O1@', local_path: 'photos/portrait-2.jpg' },
      { external_id: '@O2@', local_path: 'photos/portrait-2.jpg' },
      { external_id: '@O3@', local_path: 'photos/same.jpg' },
    ]);
    expect(readFileSync(join(dir, 'media', 'photos', 'portrait.jpg'), 'utf8')).toBe('someone else');
    expect(readdirSync(join(dir, 'media', 'photos')).sort()).toEqual([
      'portrait-2.jpg',
      'portrait.jpg',
      'same.jpg',
    ]);
    store.close();
  });
});
