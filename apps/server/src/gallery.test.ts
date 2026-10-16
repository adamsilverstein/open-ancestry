import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeStore } from '@open-ancestry/db';
import { Library } from './library';
import { THUMB_SIZES, ThumbnailQueue } from './thumbnails';
import { MUTATION_HEADERS, seed, testApi, type Seeded, type TestApi } from './test/helpers';
import { makeTempDir } from '../../../fixtures/temp-dir';

let api: TestApi;
let library: Library;
let root: string;
let s: Seeded;
let png: Buffer;
/** Ada's birth event. */
let birth: string;

const treeDir = () => join(root, 'Test.oatree');

function addMedia(fields: Record<string, unknown>, owner?: { type: string; id: string }) {
  const store = library.open('Test');
  return store.transact('media', (tx) => {
    const id = tx.insert('media', { kind: 'photo', ...fields }).id;
    if (owner)
      tx.insert('media_link', {
        media_id: id,
        owner_type: owner.type as 'person' | 'event',
        owner_id: owner.id,
      });
    return id;
  }).result;
}

/** A multipart/form-data body with text fields and one file. */
function multipart(fields: Record<string, string>, file?: { name: string; bytes: Buffer }) {
  const boundary = '----oa-test-boundary';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${file.name}"\r\ncontent-type: application/octet-stream\r\n\r\n`,
      ),
      file.bytes,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { ...MUTATION_HEADERS, 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function attach(
  fields: Record<string, string>,
  file?: { name: string; bytes: Buffer },
  headers?: object,
) {
  const body = multipart(fields, file);
  return api.inject({
    method: 'POST',
    url: `${s.base}/media`,
    payload: body.payload,
    headers: { ...body.headers, ...headers },
  });
}

beforeEach(async () => {
  root = makeTempDir('oa-gallery-');
  library = new Library(root);
  api = await testApi({ library });
  s = await seed(api);
  birth = (await api.get(`${s.base}/people/${s.ada}`)).json().events[0].event.id;
  png = await sharp({
    create: { width: 400, height: 300, channels: 3, background: '#b0402c' },
  })
    .png()
    .toBuffer();
  await mkdir(join(treeDir(), 'media', 'photos'), { recursive: true });
  await writeFile(join(treeDir(), 'media', 'photos', 'big.png'), png);
  await writeFile(join(treeDir(), 'media', 'photos', 'letter.pdf'), '%PDF-1.4 synthetic');
  await writeFile(
    join(treeDir(), 'media', 'photos', 'broken.jpg'),
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('not really a jpeg')]),
  );
});
afterEach(() => api.close());

describe('thumbnails', () => {
  it('makes a WebP thumbnail for each size and caches it in thumbs/', async () => {
    const id = addMedia({ local_path: 'photos/big.png' });
    for (const [size, edge] of Object.entries(THUMB_SIZES)) {
      const res = await api.get(`${s.base}/media/${id}/thumb/${size}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      const meta = await sharp(res.rawPayload).metadata();
      expect(meta.format).toBe('webp');
      expect(Math.max(meta.width!, meta.height!)).toBe(Math.min(edge, 400));
      expect(existsSync(join(treeDir(), 'thumbs', `${id}-${size}.webp`))).toBe(true);
      // Private whatever the process umask (#85).
      if (process.platform !== 'win32') {
        expect(statSync(join(treeDir(), 'thumbs', `${id}-${size}.webp`)).mode & 0o777).toBe(0o600);
      }
    }
    const cached = join(treeDir(), 'thumbs', `${id}-sm.webp`);
    const before = statSync(cached).mtimeMs;
    expect((await api.get(`${s.base}/media/${id}/thumb/sm`)).statusCode).toBe(200);
    expect(statSync(cached).mtimeMs).toBe(before);
  });

  it('refuses unknown sizes, non-images, unreadable images and missing files', async () => {
    const photo = addMedia({ local_path: 'photos/big.png' });
    expect((await api.get(`${s.base}/media/${photo}/thumb/huge`)).statusCode).toBe(400);
    const pdf = addMedia({ local_path: 'photos/letter.pdf', kind: 'document' });
    expect((await api.get(`${s.base}/media/${pdf}/thumb/sm`)).statusCode).toBe(404);
    const broken = addMedia({ local_path: 'photos/broken.jpg' });
    const res = await api.get(`${s.base}/media/${broken}/thumb/sm`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    const remote = addMedia({ remote_url: 'https://example.com/a.jpg' });
    expect((await api.get(`${s.base}/media/${remote}/thumb/sm`)).statusCode).toBe(404);
    expect((await api.get(`${s.base}/media/01NOPE0000000000000000000/thumb/sm`)).statusCode).toBe(
      404,
    );
  });

  it('generates thumbnails for a whole tree in the background', async () => {
    const ids = [
      addMedia({ local_path: 'photos/big.png' }),
      addMedia({ local_path: 'photos/letter.pdf' }),
    ];
    const queue = new ThumbnailQueue();
    const store: TreeStore = library.open('Test');
    queue.enqueueTree(store, treeDir());
    await queue.idle();
    const files = await readdir(join(treeDir(), 'thumbs'));
    expect(files.sort()).toEqual(
      Object.keys(THUMB_SIZES)
        .map((size) => `${ids[0]}-${size}.webp`)
        .sort(),
    );
  });

  it('runs after an import job completes', async () => {
    const lib = new Library(makeTempDir('oa-gallery-import-'));
    const imported = await testApi({
      library: lib,
      importer: async (_path, store) => {
        await mkdir(join(store.dir!, 'media'), { recursive: true });
        await writeFile(join(store.dir!, 'media', 'a.png'), png);
        store.transact('media', (tx) => tx.insert('media', { kind: 'photo', local_path: 'a.png' }));
        return { ok: true };
      },
    });
    try {
      await imported.post('/api/trees', { name: 'Imp' });
      const body = multipart({}, { name: 'x.ged', bytes: Buffer.from('0 HEAD\n0 TRLR\n') });
      const started = await imported.inject({
        method: 'POST',
        url: '/api/trees/Imp/import',
        payload: body.payload,
        headers: body.headers,
      });
      expect(started.statusCode).toBe(202);
      const store = lib.open('Imp');
      let found = false;
      for (let i = 0; i < 200 && !found; i++) {
        await new Promise((r) => setTimeout(r, 25));
        const id = store.db.prepare('SELECT id FROM media').pluck().get() as string | undefined;
        found = !!id && existsSync(join(store.dir!, 'thumbs', `${id}-sm.webp`));
      }
      expect(found).toBe(true);
    } finally {
      await imported.close();
    }
  });
});

describe('thumbnail queue', () => {
  async function images(count: number) {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const bytes = await sharp({
        create: {
          width: 1600,
          height: 1200,
          channels: 3,
          background: `#${(i * 40 + 16).toString(16).padStart(2, '0')}4060`,
        },
      })
        .png()
        .toBuffer();
      await writeFile(join(treeDir(), 'media', 'photos', `p${i}.png`), bytes);
      ids.push(addMedia({ local_path: `photos/p${i}.png` }));
    }
    return ids;
  }

  it('bounds concurrent renders and renders each image once for many requests', async () => {
    const ids = await images(6);
    const queue = new ThumbnailQueue({ concurrency: 2 });
    let peak = 0;
    const sampler = setInterval(() => (peak = Math.max(peak, queue.running)), 1);
    const requests = ids.flatMap((id) =>
      (['sm', 'md', 'lg', 'sm'] as const).map((size) =>
        queue.ensure(treeDir(), id, `photos/p${ids.indexOf(id)}.png`, size),
      ),
    );
    const paths = await Promise.all(requests);
    clearInterval(sampler);
    expect(paths.every(Boolean)).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
    expect(queue.renders).toBe(6);
  });

  it('serves requests ahead of background work', async () => {
    const ids = await images(6);
    const queue = new ThumbnailQueue({ concurrency: 1 });
    ids.forEach((id, i) => queue.enqueue(treeDir(), id, `photos/p${i}.png`));
    const last = ids.length - 1;
    await queue.ensure(treeDir(), ids[last]!, `photos/p${last}.png`, 'sm');
    const done = ids.filter((id) => existsSync(join(treeDir(), 'thumbs', `${id}-lg.webp`)));
    expect(done).toContain(ids[last]);
    expect(done.length).toBeLessThan(ids.length);
    await queue.idle();
    expect(queue.renders).toBe(6);
  });
});

describe('attaching media', () => {
  it('copies an upload into the tree, links it and records its type, size and hash', async () => {
    const res = await attach(
      { owner_type: 'person', owner_id: s.ada },
      { name: 'Ada at 20.png', bytes: png },
    );
    expect(res.statusCode).toBe(201);
    const { media, batchId } = res.json();
    expect(batchId).toBeTruthy();
    expect(media).toMatchObject({
      kind: 'photo',
      mime: 'image/png',
      title: 'Ada at 20',
      byte_size: png.length,
      width: 400,
      height: 300,
    });
    expect(media.local_path).toMatch(/^attached\/[0-9a-f]{12}-Ada at 20\.png$/);
    expect(existsSync(join(treeDir(), 'media', ...media.local_path.split('/')))).toBe(true);
    if (process.platform !== 'win32') {
      const stored = join(treeDir(), 'media', ...media.local_path.split('/'));
      expect(statSync(stored).mode & 0o777).toBe(0o600);
    }
    const listed = (await api.get(`${s.base}/people/${s.ada}/media`)).json();
    expect(listed.items.map((i: { media: { id: string } }) => i.media.id)).toContain(media.id);
  });

  it('checks the owner before reading the file (issue #98)', async () => {
    const small = await testApi({ library, mediaUploadLimit: 1024 });
    const big = { name: 'big.jpg', bytes: Buffer.alloc(4096, 1) };
    const send = (fields: Record<string, string>, file = big) => {
      const body = multipart(fields, file);
      return small.inject({ method: 'POST', url: `${s.base}/media`, ...body });
    };
    // Over the size limit too: 404/400 (not 413) shows the file was never streamed.
    const unknown = await send({ owner_type: 'person', owner_id: '01NOPE' });
    expect(unknown.statusCode).toBe(404);
    const badType = await send({ owner_type: 'tag', owner_id: s.ada });
    expect(badType.statusCode).toBe(400);
    // The file before its fields: refused without reading it.
    const fileFirst = await send({});
    expect(fileFirst.statusCode).toBe(400);
    expect(fileFirst.json().error.message).toMatch(/owner_type and owner_id before the file/);
    await small.app.close();
  });

  it('refuses a photo attach past the concurrent limit, before reading it (L5, #267)', async () => {
    const capped = await testApi({ library, maxConcurrentAttaches: 1 });
    try {
      // The first upload sends its fields and part of the file, then waits.
      const body = multipart(
        { owner_type: 'person', owner_id: s.ada },
        { name: 'a.png', bytes: png },
      );
      const stream = new PassThrough();
      stream.write(body.payload.subarray(0, body.payload.length - 200));
      const slow = capped.inject({
        method: 'POST',
        url: `${s.base}/media`,
        payload: stream,
        headers: body.headers,
      });
      await new Promise((r) => setTimeout(r, 100));
      const second = multipart(
        { owner_type: 'person', owner_id: s.ada },
        { name: 'b.png', bytes: png },
      );
      const refused = await capped.inject({ method: 'POST', url: `${s.base}/media`, ...second });
      expect(refused.statusCode, refused.body).toBe(429);
      stream.end(body.payload.subarray(body.payload.length - 200));
      expect((await slow).statusCode).toBe(201);
      // With the first done, there is room again.
      const after = await capped.inject({ method: 'POST', url: `${s.base}/media`, ...second });
      expect(after.statusCode).toBe(201);
    } finally {
      await capped.app.close();
    }
  });

  it('holds the tree busy while it writes the attached file (#289)', async () => {
    // A delete in the gap before the copy would leave media/attached in a
    // database-less folder under the tree's name: it must be refused instead.
    const exists = library.exists.bind(library);
    let refused: unknown;
    const spy = vi.spyOn(library, 'exists').mockImplementation((id: string) => {
      if (id === 'Test' && refused === undefined) {
        try {
          library.delete('Test');
          refused = null;
        } catch (error) {
          refused = error;
        }
      }
      return exists(id);
    });
    try {
      const res = await attach(
        { owner_type: 'person', owner_id: s.ada },
        { name: 'a.png', bytes: png },
      );
      expect(res.statusCode).toBe(201);
      expect(refused).toMatchObject({ statusCode: 409 });
    } finally {
      spy.mockRestore();
    }
    expect(library.list().map((t) => t.id)).toContain('Test');
  });

  it('deduplicates by sha256 and can attach to an event', async () => {
    const first = (
      await attach({ owner_type: 'person', owner_id: s.ada }, { name: 'a.png', bytes: png })
    ).json();
    const second = await attach(
      { owner_type: 'event', owner_id: birth },
      { name: 'copy.png', bytes: png },
    );
    expect(second.statusCode).toBe(201);
    expect(second.json().media.id).toBe(first.media.id);
    expect(await readdir(join(treeDir(), 'media', 'attached'))).toHaveLength(1);
    const items = (await api.get(`${s.base}/people/${s.ada}/media`)).json().items as {
      media: { id: string };
      owners: { type: string; id: string; event?: { type: string; date_text: string | null } }[];
    }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.owners).toEqual([
      { type: 'person', id: s.ada },
      expect.objectContaining({
        type: 'event',
        id: birth,
        event: expect.objectContaining({ type: 'BIRT', date_text: '5 SEP 1941' }),
      }),
    ]);
  });

  it('keeps unknown file types inert and confines odd names to the attached folder', async () => {
    const res = await attach(
      { owner_type: 'person', owner_id: s.ada },
      { name: '../../evil.html', bytes: Buffer.from('<script>alert(1)</script>') },
    );
    expect(res.statusCode).toBe(201);
    const { media } = res.json();
    expect(media).toMatchObject({ kind: 'other', mime: null });
    expect(media.local_path).toMatch(/^attached\/[0-9a-f]{12}-evil\.html$/);
    const served = await api.get(`${s.base}/media/${media.id}`);
    expect(served.headers['content-type']).toBe('application/octet-stream');
    expect(served.headers['content-disposition']).toBe('attachment');
  });

  it('treats TIFF scans as photos with thumbnails, served as attachments', async () => {
    const tiff = await sharp({
      create: { width: 300, height: 400, channels: 3, background: '#888888' },
    })
      .tiff()
      .toBuffer();
    const res = await attach(
      { owner_type: 'person', owner_id: s.ada },
      { name: 'scan.tif', bytes: tiff },
    );
    const { media } = res.json();
    expect(media).toMatchObject({ kind: 'photo', mime: 'image/tiff', width: 300, height: 400 });
    expect((await api.get(`${s.base}/media/${media.id}/thumb/sm`)).statusCode).toBe(200);
    expect((await api.get(`${s.base}/media/${media.id}`)).headers['content-disposition']).toBe(
      'attachment',
    );
  });

  it('stores simultaneous uploads of the same bytes once', async () => {
    const results = await Promise.all(
      ['one.png', 'two.png', 'three.png'].map((name) =>
        attach({ owner_type: 'person', owner_id: s.ada }, { name, bytes: png }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.json().media.id)).size).toBe(1);
    const store = library.open('Test');
    expect(
      store.db.prepare('SELECT count(*) FROM media WHERE sha256 IS NOT NULL').pluck().get(),
    ).toBe(1);
    expect(await readdir(join(treeDir(), 'media', 'attached'))).toHaveLength(1);
  });

  it('validates the owner, the fields and the token', async () => {
    const file = { name: 'a.png', bytes: png };
    expect(
      (await attach({ owner_type: 'person', owner_id: '01NOPE0000000000000000000' }, file))
        .statusCode,
    ).toBe(404);
    expect((await attach({ owner_type: 'family', owner_id: s.ada }, file)).statusCode).toBe(400);
    expect((await attach({ owner_type: 'person', owner_id: s.ada })).statusCode).toBe(400);
    expect(
      (await attach({ owner_type: 'person', owner_id: s.ada }, file, { 'x-oa-token': 'wrong' }))
        .statusCode,
    ).toBe(403);
    expect(existsSync(join(treeDir(), 'media', 'attached'))).toBe(false);
  });
});

describe('containment', () => {
  it('never writes thumbnails or attachments through a symlinked folder', async () => {
    const outside = makeTempDir('oa-outside-');
    await rm(join(treeDir(), 'thumbs'), { recursive: true, force: true });
    await symlink(outside, join(treeDir(), 'thumbs'));
    const id = addMedia({ local_path: 'photos/big.png' });
    expect((await api.get(`${s.base}/media/${id}/thumb/sm`)).statusCode).toBe(404);

    await symlink(outside, join(treeDir(), 'media', 'attached'));
    const res = await attach(
      { owner_type: 'person', owner_id: s.ada },
      { name: 'a.png', bytes: png },
    );
    expect(res.statusCode).toBe(409);
    expect(await readdir(outside)).toEqual([]);
  });

  it('creates no folder through a symlinked media folder when attaching (#314)', async () => {
    // Before, mkdir -p made attached/ wherever media/ pointed, then refused the copy.
    const outside = makeTempDir('oa-outside-');
    await rm(join(treeDir(), 'media'), { recursive: true, force: true });
    await symlink(outside, join(treeDir(), 'media'));
    const res = await attach(
      { owner_type: 'person', owner_id: s.ada },
      { name: 'a.png', bytes: png },
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.message).toMatch(/outside the tree/);
    expect(await readdir(outside)).toEqual([]);
  });

  it('does not serve a thumbnail that is a symlink out of the tree', async () => {
    const outside = makeTempDir('oa-outside-');
    await writeFile(join(outside, 'secret.webp'), 'secret');
    const id = addMedia({ local_path: 'photos/letter.pdf', kind: 'document' });
    await mkdir(join(treeDir(), 'thumbs'), { recursive: true });
    await symlink(join(outside, 'secret.webp'), join(treeDir(), 'thumbs', `${id}-sm.webp`));
    const res = await api.get(`${s.base}/media/${id}/thumb/sm`);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('secret');
  });
});

describe('person media', () => {
  it('lists media on the person and on their events, without duplicates', async () => {
    const shared = addMedia(
      { local_path: 'photos/big.png', title: 'Wedding' },
      { type: 'person', id: s.ada },
    );
    const store = library.open('Test');
    store.transact('link', (tx) =>
      tx.insert('media_link', { media_id: shared, owner_type: 'event', owner_id: birth }),
    );
    const remote = addMedia(
      { remote_url: 'https://example.com/r.jpg', ancestry_oid: 'oid-1', title: 'Census page' },
      { type: 'event', id: birth },
    );
    const res = await api.get(`${s.base}/people/${s.ada}/media`);
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { media: { id: string }; owners: { type: string }[] }[];
    expect(items.map((i) => [i.media.id, i.owners.map((o) => o.type)])).toEqual([
      [shared, ['person', 'event']],
      [remote, ['event']],
    ]);
    expect((await api.get(`${s.base}/people/01NOPE0000000000000000000/media`)).statusCode).toBe(
      404,
    );
  });
});
