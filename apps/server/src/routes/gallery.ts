import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  PRIVATE_FILE_MODE,
  restrictMode,
  treePaths,
  type EventRow,
  type MediaKind,
  type MediaRow,
  type TreeStore,
} from '@open-ancestry/db';
import type { Api, Deps } from '../context';
import { edit, requireRow } from '../edits';
import { ApiError, badRequest, notFound } from '../errors';
import { MediaThumbParams, TreeIdParams, TreeParams } from '../schemas';
import { THUMB_SIZES, insideTree, isThumbSize, loadSharp, readHead } from '../thumbnails';
import { MEDIA_CSP, resolveMediaPath, sniffMediaType } from './media';

/*
 * The person gallery: thumbnails, media from disk, and the media a person
 * appears in (their own and their events').
 */

export const ATTACHED_DIR = 'attached';
const OWNER_TYPES = ['person', 'event'] as const;

/** A file name safe as one path segment on every platform. */
export function safeFileName(name: string): string {
  const base = name.replaceAll('\\', '/').split('/').pop() ?? '';
  const clean = base
    // eslint-disable-next-line no-control-regex
    .replace(/[:*?"<>|%\u0000-\u001f\u007f]+/g, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(-80);
  return clean || 'file';
}

function kindOf(mime: string | null): MediaKind {
  if (!mime) return 'other';
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

export type MediaOwnerRef =
  | { type: 'person'; id: string }
  | {
      type: 'event';
      id: string;
      event: Pick<EventRow, 'type' | 'custom_type' | 'date_text' | 'date_sort'>;
    };

export interface PersonMediaItem {
  media: MediaRow;
  /** Where the media is attached for this person: the person and/or some of their events. */
  owners: MediaOwnerRef[];
}

/**
 * Media linked to a person and to the events they take part in. Each media
 * appears once: the person's own first (in their order), then by event date.
 */
export function personMedia(store: TreeStore, personId: string): PersonMediaItem[] {
  const own = store
    .stmt(
      `SELECT media_id FROM media_link WHERE owner_type = 'person' AND owner_id = ?
       ORDER BY sort_order, id`,
    )
    .all(personId) as { media_id: string }[];
  const onEvents = store
    .stmt(
      `SELECT l.media_id, e.id, e.type, e.custom_type, e.date_text, e.date_sort
       FROM media_link l
       JOIN event_role r ON r.event_id = l.owner_id AND r.person_id = ?
       JOIN event e ON e.id = l.owner_id
       WHERE l.owner_type = 'event'
       ORDER BY e.date_sort IS NULL, e.date_sort, l.sort_order, l.id`,
    )
    .all(personId) as ({ media_id: string; id: string } & MediaOwnerRef & {
      type: string;
      custom_type: string | null;
      date_text: string | null;
      date_sort: number | null;
    })[];
  const items = new Map<string, PersonMediaItem>();
  const mediaRow = store.stmt('SELECT * FROM media WHERE id = ?');
  const item = (mediaId: string) => {
    let found = items.get(mediaId);
    if (!found) {
      found = { media: mediaRow.get(mediaId) as MediaRow, owners: [] };
      items.set(mediaId, found);
    }
    return found;
  };
  for (const { media_id } of own) {
    const found = item(media_id);
    if (!found.owners.some((o) => o.type === 'person'))
      found.owners.push({ type: 'person', id: personId });
  }
  for (const row of onEvents) {
    const found = item(row.media_id);
    if (found.owners.some((o) => o.id === row.id)) continue;
    found.owners.push({
      type: 'event',
      id: row.id,
      event: {
        type: row.type,
        custom_type: row.custom_type,
        date_text: row.date_text,
        date_sort: row.date_sort,
      },
    });
  }
  return [...items.values()];
}

/** Streams a request part to a temp file while hashing it. */
async function receive(stream: NodeJS.ReadableStream & { truncated?: boolean }, path: string) {
  const hash = createHash('sha256');
  let size = 0;
  await pipeline(
    stream,
    new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        size += chunk.length;
        done(null, chunk);
      },
    }),
    createWriteStream(path, { flags: 'wx' }),
  );
  return { sha256: hash.digest('hex'), size };
}

async function dimensions(file: string): Promise<{ width: number | null; height: number | null }> {
  try {
    const sharp = await loadSharp();
    const meta = await sharp(file, { limitInputPixels: 100_000_000 }).metadata();
    return { width: meta.width ?? null, height: meta.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

const fileExists = (path: string | null) =>
  path
    ? stat(path).then(
        (s) => s.isFile(),
        () => false,
      )
    : Promise.resolve(false);

/** Runs work for one key at a time (attachments per tree). */
class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

const isTiff = (head: Buffer) =>
  head.subarray(0, 4).toString('latin1') === 'II*\0' ||
  head.subarray(0, 4).toString('latin1') === 'MM\0*';

/** sha256 of a file, streamed. */
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function galleryRoutes(app: Api, { library, thumbnails, uploadLimit }: Deps): void {
  const attachLocks = new KeyedLock();
  app.get(
    '/api/trees/:tree/people/:id/media',
    { schema: { params: TreeIdParams } },
    async (request) => {
      const store = library.open(request.params.tree);
      requireRow(store, 'person', request.params.id);
      return { items: personMedia(store, request.params.id) };
    },
  );

  app.get(
    '/api/trees/:tree/media/:id/thumb/:size',
    { schema: { params: MediaThumbParams } },
    async (request, reply) => {
      const { tree, id, size } = request.params;
      if (!isThumbSize(size)) {
        throw badRequest(`Thumbnail size must be one of ${Object.keys(THUMB_SIZES).join(', ')}`);
      }
      const store = library.open(tree);
      const media = store.getRow('media', id);
      if (!media) throw notFound(`Media ${id} not found`);
      const file = await thumbnails.ensure(library.dirOf(tree), id, media.local_path, size);
      if (!file) throw notFound(`Media ${id} has no image to make a thumbnail from`);
      const info = await stat(file);
      const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      reply
        .header('content-security-policy', MEDIA_CSP)
        .header('x-content-type-options', 'nosniff')
        .header('etag', etag)
        .header('cache-control', 'private, no-cache')
        .type('image/webp');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      reply.header('content-length', info.size);
      return reply.send(createReadStream(file));
    },
  );

  app.post('/api/trees/:tree/media', { schema: { params: TreeParams } }, async (request, reply) => {
    const { tree } = request.params;
    const store = library.open(tree);
    if (!request.isMultipart()) {
      throw new ApiError(415, 'unsupported_media_type', 'Upload the file as multipart/form-data');
    }
    const temp = await mkdtemp(join(tmpdir(), 'oa-attach-'));
    try {
      const fields: Record<string, string> = {};
      let upload: { path: string; name: string; sha256: string; size: number } | undefined;
      const parts = request.parts({
        limits: { fileSize: uploadLimit, files: 1, fields: 4, fieldSize: 256 },
      });
      for await (const part of parts) {
        if (part.type === 'field') {
          fields[part.fieldname] = String(part.value);
        } else if (part.fieldname !== 'file' || upload) {
          part.file.resume();
        } else {
          const path = join(temp, 'upload');
          const received = await receive(part.file, path);
          if (part.file.truncated) {
            throw new ApiError(
              413,
              'payload_too_large',
              `Uploads are limited to ${uploadLimit} bytes`,
            );
          }
          upload = { path, name: part.filename, ...received };
        }
      }

      const ownerType = fields.owner_type as (typeof OWNER_TYPES)[number];
      if (!OWNER_TYPES.includes(ownerType)) throw badRequest('owner_type must be person or event');
      const ownerId = fields.owner_id ?? '';
      requireRow(store, ownerType, ownerId);
      if (!upload) throw badRequest('Attach a file');

      // One attach per tree at a time, so two uploads of the same bytes cannot
      // both miss the sha256 lookup and store the file twice.
      const mediaId = await attachLocks.run(tree, async () => {
        const mediaRoot = treePaths(library.dirOf(tree)).media;
        // Same bytes already in the tree: link the existing media instead of a second copy.
        let existing = store
          .stmt('SELECT * FROM media WHERE sha256 = ? AND local_path IS NOT NULL ORDER BY id')
          .all(upload.sha256) as MediaRow[];
        const present = await Promise.all(
          existing.map(async (m) => fileExists(await resolveMediaPath(mediaRoot, m.local_path!))),
        );
        existing = existing.filter((_, i) => present[i]);

        let fresh: Omit<MediaRow, 'id' | 'created_at' | 'updated_at'> | undefined;
        if (!existing[0]) {
          const name = safeFileName(upload.name);
          const localPath = `${ATTACHED_DIR}/${upload.sha256.slice(0, 12)}-${name}`;
          const target = join(mediaRoot, ATTACHED_DIR, `${upload.sha256.slice(0, 12)}-${name}`);
          await mkdir(join(mediaRoot, ATTACHED_DIR), { recursive: true });
          // A symlinked attached/ (or media/) folder must not carry the copy out of the tree.
          if (!(await insideTree(library.dirOf(tree), join(mediaRoot, ATTACHED_DIR)))) {
            throw new ApiError(409, 'conflict', 'The media folder leads outside the tree');
          }
          try {
            await copyFile(upload.path, target, constants.COPYFILE_EXCL);
            // A copy may carry the upload's mode: make it private, as media is.
            restrictMode(target, PRIVATE_FILE_MODE);
          } catch (error) {
            // Same name and hash prefix: keep the file that is there if it is these bytes
            // (and a real file, not a symlink to somewhere else).
            const there = await lstat(target).catch(() => null);
            const same =
              (error as NodeJS.ErrnoException).code === 'EEXIST' &&
              there?.isFile() === true &&
              (await hashFile(target)) === upload.sha256;
            if (!same) throw error;
          }
          // The first bytes decide the type; the upload is never read into memory whole.
          const head = await readHead(upload.path);
          const tiff = isTiff(head);
          const mime = sniffMediaType(head) ?? (tiff ? 'image/tiff' : null);
          fresh = {
            kind: kindOf(mime),
            mime,
            local_path: localPath,
            remote_url: null,
            ancestry_oid: null,
            title: name.replace(/\.[^.]*$/, '') || name,
            date_text: null,
            description: null,
            sha256: upload.sha256,
            byte_size: upload.size,
            ...(mime?.startsWith('image/')
              ? await dimensions(target)
              : { width: null, height: null }),
            external_id: null,
            import_batch_id: null,
          };
        }

        const { batchId, result: mediaId } = edit(store, 'Attach media', (tx) => {
          const id = existing[0]?.id ?? tx.insert('media', fresh!).id;
          const linked = store
            .stmt('SELECT 1 FROM media_link WHERE media_id = ? AND owner_type = ? AND owner_id = ?')
            .get(id, ownerType, ownerId);
          if (!linked) {
            const { n } = store
              .stmt(
                'SELECT coalesce(max(sort_order) + 1, 0) AS n FROM media_link WHERE owner_type = ? AND owner_id = ?',
              )
              .get(ownerType, ownerId) as { n: number };
            tx.insert('media_link', {
              media_id: id,
              owner_type: ownerType,
              owner_id: ownerId,
              sort_order: n,
            });
          }
          return id;
        });
        return { batchId, mediaId };
      });
      const media = store.getRow('media', mediaId.mediaId)!;
      thumbnails.enqueue(library.dirOf(tree), media.id, media.local_path);
      return reply.code(201).send({ media, batchId: mediaId.batchId });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
}
