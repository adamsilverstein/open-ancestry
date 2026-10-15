import { link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Library } from './library';
import { MEDIA_CSP, parseRange, resolveMediaPath, sniffMediaType } from './routes/media';
import { createTestTree, testApi, type TestApi } from './test/helpers';
import { makeTempDir } from '../../../fixtures/temp-dir';

let api: TestApi;
let base: string;
let library: Library;
// A JPEG signature followed by filler, so the type is sniffed as image/jpeg.
const BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('456789abcdef')]);

function addMedia(fields: { local_path?: string | null; mime?: string | null }) {
  const store = library.open('Test');
  return store.transact('media', (tx) => tx.insert('media', { kind: 'photo', ...fields })).result
    .id;
}

describe('with a tree', () => {
  beforeEach(async () => {
    const root = makeTempDir('oa-lib-');
    library = new Library(root);
    api = await testApi({ library });
    base = await createTestTree(api);
    await mkdir(join(root, 'Test.oatree', 'media', 'photos'), { recursive: true });
    await writeFile(join(root, 'Test.oatree', 'media', 'photos', 'portrait.jpg'), BYTES);
  });
  afterEach(() => api.close());

  describe('GET media', () => {
    it('serves the original with its content type and a sandboxing CSP', async () => {
      const id = addMedia({ local_path: 'photos/portrait.jpg', mime: 'image/jpeg' });
      const res = await api.get(`${base}/media/${id}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['content-length']).toBe('16');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-security-policy']).toBe(MEDIA_CSP);
      expect(res.headers['content-disposition']).toBe('inline');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.rawPayload.equals(BYTES)).toBe(true);
      const head = await api.inject({
        method: 'HEAD',
        url: `${base}/media/${id}`,
        headers: { host: '127.0.0.1' },
      });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
    });

    it('ignores the stored mime type and the extension', async () => {
      const lying = addMedia({ local_path: 'photos/portrait.jpg', mime: 'text/html' });
      expect((await api.get(`${base}/media/${lying}`)).headers['content-type']).toBe('image/jpeg');
      const injected = addMedia({
        local_path: 'photos/portrait.jpg',
        mime: 'image/jpeg; x=1\r\nx-evil: 1',
      });
      const res = await api.get(`${base}/media/${injected}`);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['x-evil']).toBeUndefined();
    });

    it.each([
      ['page.html', '<!doctype html><script>alert(1)</script>', 'text/html'],
      [
        'logo.svg',
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        'image/svg+xml',
      ],
      ['photo.jpg', '<html><script>alert(1)</script></html>', 'image/jpeg'],
      ['notes.txt', 'plain text', 'text/plain'],
      ['empty.png', '', 'image/png'],
    ])(
      'serves %s (not an allowlisted format) as an opaque attachment',
      async (name, content, mime) => {
        await writeFile(join(library.root, 'Test.oatree', 'media', name), content);
        const id = addMedia({ local_path: name, mime });
        const res = await api.get(`${base}/media/${id}`);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('application/octet-stream');
        expect(res.headers['content-disposition']).toBe('attachment');
        expect(res.headers['content-security-policy']).toBe(MEDIA_CSP);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
      },
    );

    it('supports byte ranges', async () => {
      const id = addMedia({ local_path: 'photos/portrait.jpg' });
      const first = await api.get(`${base}/media/${id}`, { range: 'bytes=0-3' });
      expect(first.statusCode).toBe(206);
      expect(first.headers['content-range']).toBe('bytes 0-3/16');
      expect(first.rawPayload.equals(BYTES.subarray(0, 4))).toBe(true);
      const suffix = await api.get(`${base}/media/${id}`, { range: 'bytes=-4' });
      expect(suffix.body).toBe('cdef');
      const open = await api.get(`${base}/media/${id}`, { range: 'bytes=10-' });
      expect(open.body).toBe('abcdef');
      const bad = await api.get(`${base}/media/${id}`, { range: 'bytes=99-' });
      expect(bad.statusCode).toBe(416);
      expect(bad.headers['content-range']).toBe('bytes */16');
      expect(bad.json().error.code).toBe('range_not_satisfiable');
    });

    it('answers 304 for a matching ETag', async () => {
      const id = addMedia({ local_path: 'photos/portrait.jpg' });
      const { etag } = (await api.get(`${base}/media/${id}`)).headers;
      expect(
        (await api.get(`${base}/media/${id}`, { 'if-none-match': String(etag) })).statusCode,
      ).toBe(304);
    });

    it('404s unknown media, media without a file, and missing files', async () => {
      expect((await api.get(`${base}/media/01NOPE`)).statusCode).toBe(404);
      const remote = addMedia({ local_path: null });
      expect((await api.get(`${base}/media/${remote}`)).statusCode).toBe(404);
      const missing = addMedia({ local_path: 'photos/gone.jpg' });
      expect((await api.get(`${base}/media/${missing}`)).statusCode).toBe(404);
      const dir = addMedia({ local_path: 'photos' });
      expect((await api.get(`${base}/media/${dir}`)).statusCode).toBe(404);
    });

    it('refuses symlinks that escape the media folder', async () => {
      const outside = join(makeTempDir('oa-secret-'), 'secret.txt');
      await writeFile(outside, 'secret');
      await symlink(outside, join(library.root, 'Test.oatree', 'media', 'link.txt'));
      const id = addMedia({ local_path: 'link.txt' });
      const res = await api.get(`${base}/media/${id}`);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('secret');
    });

    it('refuses a hard-linked file and logs why, once per file (#207)', async () => {
      const outside = join(makeTempDir('oa-secret-'), 'secret.jpg');
      await writeFile(outside, BYTES);
      // A name with an escape character: the log line must not pass it to the terminal.
      const name = 'hard\u001b[31m.jpg';
      await link(outside, join(library.root, 'Test.oatree', 'media', name));
      const id = addMedia({ local_path: name });
      // The shipped CLI runs with logger: false, so the refusal goes to stderr itself.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        for (let i = 0; i < 2; i++) {
          const res = await api.get(`${base}/media/${id}`);
          expect(res.statusCode).toBe(404);
          expect(res.rawPayload.equals(BYTES)).toBe(false);
        }
        const logged = warn.mock.calls
          .map((call) => call.join(' '))
          .filter((l) => l.includes('hard link'));
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain('hard\\x1b[31m.jpg');
        expect(logged[0]).not.toContain('\u001b');
      } finally {
        warn.mockRestore();
      }
    });

    it('accepts only the named thumbnail sizes', async () => {
      const id = addMedia({ local_path: 'photos/portrait.jpg' });
      const res = await api.get(`${base}/media/${id}/thumb/200`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    });
  });

  describe('resolveMediaPath', () => {
    it('keeps paths inside the media folder', async () => {
      const media = join(library.root, 'Test.oatree', 'media');
      expect(await resolveMediaPath(media, 'photos/portrait.jpg')).toMatch(
        /photos\/portrait\.jpg$/,
      );
      for (const bad of [
        '../tree.sqlite',
        '../../etc/passwd',
        '/etc/passwd',
        'photos/../../tree.sqlite',
        '',
        '.',
      ]) {
        expect(await resolveMediaPath(media, bad), bad).toBeNull();
      }
    });
  });
});

describe('parseRange', () => {
  it.each([
    [undefined, undefined],
    ['bytes=0-0', { start: 0, end: 0 }],
    ['bytes=5-100', { start: 5, end: 9 }],
    ['bytes=-3', { start: 7, end: 9 }],
    ['bytes=-30', { start: 0, end: 9 }],
    ['bytes=0-1,4-5', undefined],
    ['bytes=-0', null],
    ['bytes=-', null],
    ['bytes=10-', null],
    ['bytes=5-2', null],
    ['items=0-1', null],
  ])('%j', (header, expected) => {
    expect(parseRange(header, 10)).toEqual(expected);
  });
});

describe('sniffMediaType', () => {
  const b = (...parts: (number[] | string)[]) =>
    Buffer.concat(
      parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))),
    );
  it.each([
    [b([0xff, 0xd8, 0xff, 0xdb]), 'image/jpeg'],
    [b([0x89], 'PNG\r\n\x1a\n'), 'image/png'],
    [b('GIF89a'), 'image/gif'],
    [b('GIF87a'), 'image/gif'],
    [b('RIFF\0\0\0\0WEBPVP8 '), 'image/webp'],
    [b('RIFF\0\0\0\0WAVEfmt '), 'audio/wav'],
    [b('\0\0\0\x1cftypavif'), 'image/avif'],
    [b('\0\0\0\x1cftypisom'), 'video/mp4'],
    [b('\0\0\0\x1cftypM4A '), 'audio/mp4'],
    [b('\0\0\0\x1cftypqt  '), null],
    [b([0x1a, 0x45, 0xdf, 0xa3]), 'video/webm'],
    [b('ID3\x04'), 'audio/mpeg'],
    [b([0xff, 0xfb, 0x90]), 'audio/mpeg'],
    [b('OggS'), 'audio/ogg'],
    [b('fLaC'), 'audio/flac'],
    [b('%PDF-1.7'), 'application/pdf'],
    [b('<svg xmlns='), null],
    [b('<!doctype html>'), null],
    [b('BM'), null],
    [b(''), null],
  ])('%#', (bytes, expected) => {
    expect(sniffMediaType(bytes)).toBe(expected);
  });
});
