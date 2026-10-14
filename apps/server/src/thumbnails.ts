import { mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { treePaths, type TreeStore } from '@open-ancestry/db';
import sharp from 'sharp';
import { resolveMediaPath } from './routes/media';

/*
 * WebP thumbnails, cached in the tree's thumbs/ folder as `<mediaId>-<size>.webp`.
 * They are derived data: safe to delete, rebuilt on demand. Imports and
 * attachments queue them in the background; a request for a missing one
 * makes it right away.
 */

/** Longest edge in pixels for each named size. */
export const THUMB_SIZES = { sm: 160, md: 480, lg: 1280 } as const;
export type ThumbSize = keyof typeof THUMB_SIZES;

export const isThumbSize = (size: string): size is ThumbSize => Object.hasOwn(THUMB_SIZES, size);

/** Untrusted images: refuse anything that would decode to more than this many pixels. */
const MAX_INPUT_PIXELS = 100_000_000;

/** Raster formats sharp can read, by magic bytes (TIFF is common for document scans). */
function isImage(head: Buffer): boolean {
  const ascii = (at: number, text: string) =>
    head.subarray(at, at + text.length).toString('latin1') === text;
  return (
    (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
    ascii(0, '\x89PNG') ||
    ascii(0, 'GIF8') ||
    (ascii(0, 'RIFF') && ascii(8, 'WEBP')) ||
    (ascii(4, 'ftyp') &&
      /^(avif|avis|heic|heix|mif1)$/.test(head.subarray(8, 12).toString('latin1'))) ||
    ascii(0, 'II*\0') ||
    ascii(0, 'MM\0*')
  );
}

async function readHead(file: string): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, 16, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export const thumbFile = (treeDir: string, mediaId: string, size: ThumbSize) =>
  join(treePaths(treeDir).thumbs, `${mediaId}-${size}.webp`);

/** The source file for a media row, or null when it has none, it is missing or it is not an image. */
async function imageSource(treeDir: string, localPath: string | null): Promise<string | null> {
  if (!localPath) return null;
  const file = await resolveMediaPath(treePaths(treeDir).media, localPath);
  if (!file) return null;
  try {
    return (await stat(file)).isFile() && isImage(await readHead(file)) ? file : null;
  } catch {
    return null;
  }
}

/** Writes all sizes for one image; false when the file cannot be decoded. */
/** True when `dir` (after following symlinks) is inside the tree folder. */
export async function insideTree(treeDir: string, dir: string): Promise<boolean> {
  try {
    const [root, real] = await Promise.all([realpath(treeDir), realpath(dir)]);
    return real.startsWith(root + sep);
  } catch {
    return false;
  }
}

async function render(source: string, treeDir: string, mediaId: string): Promise<boolean> {
  const thumbs = treePaths(treeDir).thumbs;
  await mkdir(thumbs, { recursive: true });
  // A thumbs/ symlinked elsewhere must not carry writes out of the tree.
  if (!(await insideTree(treeDir, thumbs))) return false;
  try {
    const image = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
    for (const [size, edge] of Object.entries(THUMB_SIZES) as [ThumbSize, number][]) {
      const out = thumbFile(treeDir, mediaId, size);
      const tmp = `${out}.${process.pid}.tmp`;
      await image
        .clone()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(tmp);
      await rename(tmp, out);
    }
    return true;
  } catch {
    for (const size of Object.keys(THUMB_SIZES) as ThumbSize[]) {
      await rm(`${thumbFile(treeDir, mediaId, size)}.${process.pid}.tmp`, { force: true });
    }
    return false;
  }
}

interface Task {
  treeDir: string;
  mediaId: string;
  localPath: string | null;
}

/**
 * Makes thumbnails one image at a time (sharp already uses several threads
 * per image), so a large import never starves request handling.
 */
export class ThumbnailQueue {
  private readonly pending: Task[] = [];
  /** Work in flight or done, by `treeDir|mediaId`, so each image renders once. */
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private running = false;
  private idleWaiters: (() => void)[] = [];

  /** Queues every local image of a tree that has no thumbnails yet. */
  enqueueTree(store: TreeStore, treeDir: string): void {
    const rows = store.db
      .prepare('SELECT id, local_path FROM media WHERE local_path IS NOT NULL ORDER BY id')
      .all() as { id: string; local_path: string }[];
    for (const row of rows) this.enqueue(treeDir, row.id, row.local_path);
  }

  enqueue(treeDir: string, mediaId: string, localPath: string | null): void {
    this.pending.push({ treeDir, mediaId, localPath });
    void this.pump();
  }

  /**
   * The path of a thumbnail, rendering it now if needed; null when the media
   * has no decodable local image.
   */
  async ensure(
    treeDir: string,
    mediaId: string,
    localPath: string | null,
    size: ThumbSize,
  ): Promise<string | null> {
    const serve = async () => {
      const out = await resolveMediaPath(treeDir, `thumbs/${mediaId}-${size}.webp`);
      return out && (await exists(out)) ? out : null;
    };
    return (await serve()) ?? ((await this.run({ treeDir, mediaId, localPath })) ? serve() : null);
  }

  /** Resolves once the background queue is empty. */
  idle(): Promise<void> {
    if (!this.running && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private run(task: Task): Promise<boolean> {
    const key = `${task.treeDir}|${task.mediaId}`;
    let work = this.inFlight.get(key);
    if (!work) {
      work = (async () => {
        if (await exists(thumbFile(task.treeDir, task.mediaId, 'lg'))) return true;
        const source = await imageSource(task.treeDir, task.localPath);
        return source ? render(source, task.treeDir, task.mediaId) : false;
      })().finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, work);
    }
    return work;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let task = this.pending.shift(); task; task = this.pending.shift()) {
        await this.run(task).catch(() => false);
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
