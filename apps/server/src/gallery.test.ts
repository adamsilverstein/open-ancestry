import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TreeStore } from '@open-ancestry/db';
import { Library } from './library';
import { THUMB_SIZES, ThumbnailQueue } from './thumbnails';
import { MUTATION_HEADERS, seed, testApi, type Seeded, type TestApi } from './test/helpers';

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
    const id = tx.insert('media', { kind: 'photo', ...fields });
    if (owner)
      tx.insert('media_link', { media_id: id, owner_type: owner.type, owner_id: owner.id });
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
  root = await mkdtemp(join(tmpdir(), 'oa-gallery-'));
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
    const lib = new Library(await mkdtemp(join(tmpdir(), 'oa-gallery-import-')));
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
    const listed = (await api.get(`${s.base}/people/${s.ada}/media`)).json();
    expect(listed.items.map((i: { media: { id: string } }) => i.media.id)).toContain(media.id);
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
      owner: { type: string; id: string; event?: { type: string; date_text: string | null } };
    }[];
    expect(items.map((i) => i.owner.type).sort()).toEqual(['event', 'person']);
    expect(items.find((i) => i.owner.type === 'event')!.owner).toMatchObject({
      id: birth,
      event: { type: 'BIRT', date_text: '5 SEP 1941' },
    });
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
    const items = res.json().items as { media: { id: string }; owner: { type: string } }[];
    expect(items.map((i) => [i.media.id, i.owner.type])).toEqual([
      [shared, 'person'],
      [remote, 'event'],
    ]);
    expect((await api.get(`${s.base}/people/01NOPE0000000000000000000/media`)).statusCode).toBe(
      404,
    );
  });
});
