import { mkdir, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
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
export function isImage(head: Buffer): boolean {
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

export async function readHead(file: string): Promise<Buffer> {
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
  const sizes = (Object.entries(THUMB_SIZES) as [ThumbSize, number][]).sort((x, y) => y[1] - x[1]);
  const tmp = (size: ThumbSize) => `${thumbFile(treeDir, mediaId, size)}.${process.pid}.tmp`;
  try {
    // Decode the source once, for the largest size; the smaller ones come from that.
    let previous: Buffer | undefined;
    for (const [size, edge] of sizes) {
      const input = previous ?? source;
      const image = previous
        ? sharp(input)
        : sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
      const webp = await image
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      await writeFile(tmp(size), webp);
      previous = webp;
    }
    // The largest is renamed last: its presence means the set is complete.
    for (const [size] of [...sizes].reverse())
      await rename(tmp(size), thumbFile(treeDir, mediaId, size));
    return true;
  } catch {
    for (const [size] of sizes) await rm(tmp(size), { force: true });
    return false;
  }
}

interface Task {
  treeDir: string;
  mediaId: string;
  localPath: string | null;
}

type Priority = 'now' | 'background';

/**
 * Makes thumbnails with at most `concurrency` images decoding at once (sharp
 * already uses several threads per image), for both background work and
 * requests, so a gallery of large scans cannot exhaust memory or starve file
 * reads. Requests jump ahead of background work; each image renders once.
 */
export class ThumbnailQueue {
  private readonly concurrency: number;
  private active = 0;
  private readonly waiting: { key: string; priority: Priority; start: () => void }[] = [];
  /** Work in flight, by `treeDir|mediaId`, so each image renders once. */
  private readonly inFlight = new Map<string, Promise<boolean>>();
  /** In-flight work someone is waiting on now (it may not have reached the queue yet). */
  private readonly urgent = new Set<string>();
  private background = 0;
  private idleWaiters: (() => void)[] = [];

  constructor({ concurrency = 2 }: { concurrency?: number } = {}) {
    this.concurrency = concurrency;
  }

  /** Queues every local image of a tree that has no thumbnails yet. */
  enqueueTree(store: TreeStore, treeDir: string): void {
    const rows = store.db
      .prepare('SELECT id, local_path FROM media WHERE local_path IS NOT NULL ORDER BY id')
      .all() as { id: string; local_path: string }[];
    for (const row of rows) this.enqueue(treeDir, row.id, row.local_path);
  }

  enqueue(treeDir: string, mediaId: string, localPath: string | null): void {
    this.background++;
    void this.run({ treeDir, mediaId, localPath }, 'background')
      .catch(() => false)
      .finally(() => {
        this.background--;
        if (this.background === 0) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const resolve of waiters) resolve();
        }
      });
  }

  /**
   * The path of a thumbnail, rendering it now (ahead of background work) if
   * needed; null when the media has no decodable local image.
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
    return (
      (await serve()) ?? ((await this.run({ treeDir, mediaId, localPath }, 'now')) ? serve() : null)
    );
  }

  /** Resolves once all background work is done. */
  idle(): Promise<void> {
    if (this.background === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Renders currently decoding, and renders done so far (for tests and diagnostics). */
  get running(): number {
    return this.active;
  }
  renders = 0;

  private run(task: Task, priority: Priority): Promise<boolean> {
    const key = `${task.treeDir}|${task.mediaId}`;
    const existing = this.inFlight.get(key);
    if (priority === 'now') this.urgent.add(key);
    if (existing) {
      if (priority === 'now') this.promote(key);
      return existing;
    }
    const work = (async () => {
      if (await exists(thumbFile(task.treeDir, task.mediaId, 'lg'))) return true;
      const source = await imageSource(task.treeDir, task.localPath);
      if (!source) return false;
      await this.acquire(key, this.urgent.has(key) ? 'now' : 'background');
      try {
        this.renders++;
        return await render(source, task.treeDir, task.mediaId);
      } finally {
        this.release();
      }
    })().finally(() => {
      this.inFlight.delete(key);
      this.urgent.delete(key);
    });
    this.inFlight.set(key, work);
    return work;
  }

  private acquire(key: string, priority: Priority): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiter = { key, priority, start: resolve };
      if (priority === 'now') {
        const firstBackground = this.waiting.findIndex((w) => w.priority === 'background');
        this.waiting.splice(firstBackground < 0 ? this.waiting.length : firstBackground, 0, waiter);
      } else {
        this.waiting.push(waiter);
      }
    });
  }

  /** A request for an image already queued in the background moves it ahead. */
  private promote(key: string): void {
    const index = this.waiting.findIndex((w) => w.key === key && w.priority === 'background');
    if (index < 0) return;
    const [waiter] = this.waiting.splice(index, 1);
    waiter!.priority = 'now';
    const firstBackground = this.waiting.findIndex((w) => w.priority === 'background');
    this.waiting.splice(firstBackground < 0 ? this.waiting.length : firstBackground, 0, waiter!);
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next.start();
    else this.active--;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
