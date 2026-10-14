import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library } from './library';
import { parseRange, resolveMediaPath } from './routes/media';
import { createTestTree, testApi, type TestApi } from './test/helpers';

let api: TestApi;
let base: string;
let library: Library;
const BYTES = Buffer.from('0123456789abcdef');

function addMedia(fields: { local_path?: string | null; mime?: string | null }) {
  const store = library.open('Test');
  return store.transact('media', (tx) => tx.insert('media', { kind: 'photo', ...fields })).result
    .id;
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'oa-lib-'));
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
    expect(res.headers['content-security-policy']).toContain('sandbox');
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

  it('guesses the type from the extension when mime is missing or malformed', async () => {
    const plain = addMedia({ local_path: 'photos/portrait.jpg' });
    expect((await api.get(`${base}/media/${plain}`)).headers['content-type']).toBe('image/jpeg');
    const bad = addMedia({ local_path: 'photos/portrait.jpg', mime: 'text/html\r\nx: y' });
    expect((await api.get(`${base}/media/${bad}`)).headers['content-type']).toBe('image/jpeg');
  });

  it('serves HTML-like media as an attachment', async () => {
    const id = addMedia({ local_path: 'photos/portrait.jpg', mime: 'text/html' });
    const res = await api.get(`${base}/media/${id}`);
    expect(res.headers['content-disposition']).toBe('attachment');
  });

  it('supports byte ranges', async () => {
    const id = addMedia({ local_path: 'photos/portrait.jpg' });
    const first = await api.get(`${base}/media/${id}`, { range: 'bytes=0-3' });
    expect(first.statusCode).toBe(206);
    expect(first.headers['content-range']).toBe('bytes 0-3/16');
    expect(first.body).toBe('0123');
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
    const outside = join(await mkdtemp(join(tmpdir(), 'oa-secret-')), 'secret.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, join(library.root, 'Test.oatree', 'media', 'link.txt'));
    const id = addMedia({ local_path: 'link.txt' });
    const res = await api.get(`${base}/media/${id}`);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('secret');
  });

  it('has no thumbnails yet', async () => {
    const id = addMedia({ local_path: 'photos/portrait.jpg' });
    const res = await api.get(`${base}/media/${id}/thumb/200`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});

describe('resolveMediaPath', () => {
  it('keeps paths inside the media folder', async () => {
    const media = join(library.root, 'Test.oatree', 'media');
    expect(await resolveMediaPath(media, 'photos/portrait.jpg')).toMatch(/photos\/portrait\.jpg$/);
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
