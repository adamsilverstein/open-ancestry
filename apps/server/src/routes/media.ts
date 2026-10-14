import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { treePaths } from '@open-ancestry/db';
import type { FastifyReply } from 'fastify';
import type { Api, Deps } from '../context';
import { ApiError, errorBody, notFound } from '../errors';
import { MediaThumbParams, TreeIdParams } from '../schemas';

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

/** Media files can be anything a GEDZIP contained; never let one run script. */
const MEDIA_CSP =
  "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";

function contentType(mime: string | null, path: string): string {
  if (mime && /^[a-z]+\/[a-z0-9.+-]+$/i.test(mime)) return mime.toLowerCase();
  return TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Resolves a media.local_path inside the tree's media folder, following symlinks; null if it escapes. */
export async function resolveMediaPath(
  mediaRoot: string,
  localPath: string,
): Promise<string | null> {
  const root = resolve(mediaRoot);
  const candidate = resolve(root, localPath);
  if (!candidate.startsWith(root + sep)) return null;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(candidate)]);
    return realFile.startsWith(realRoot + sep) ? realFile : null;
  } catch {
    return null;
  }
}

/** Parses a single `bytes=` range; undefined for none or multi-range, null if unsatisfiable. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return header.includes(',') ? undefined : null;
  const [, a, b] = match;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return null;
  return { start, end };
}

function rangeNotSatisfiable(reply: FastifyReply, size: number) {
  return reply
    .code(416)
    .type('application/json; charset=utf-8')
    .header('content-range', `bytes */${size}`)
    .send(errorBody('range_not_satisfiable', 'Requested range is not satisfiable'));
}

export function mediaRoutes(app: Api, { library }: Deps): void {
  app.get(
    '/api/trees/:tree/media/:id',
    { schema: { params: TreeIdParams } },
    async (request, reply) => {
      const { tree, id } = request.params;
      const store = library.open(tree);
      const media = store.getRow('media', id);
      if (!media) throw notFound(`Media ${id} not found`);
      if (!media.local_path) throw notFound(`Media ${id} has no local file`);
      const file = await resolveMediaPath(treePaths(library.dirOf(tree)).media, media.local_path);
      const info = file ? await stat(file).catch(() => null) : null;
      if (!file || !info?.isFile()) throw notFound(`Media ${id} file is missing`);

      const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      const type = contentType(media.mime, file);
      reply
        .header('content-security-policy', MEDIA_CSP)
        .header('accept-ranges', 'bytes')
        .header('etag', etag)
        .header('last-modified', info.mtime.toUTCString())
        .header('cache-control', 'private, no-cache')
        .header(
          'content-disposition',
          /html|xml/.test(type) && !type.includes('svg') ? 'attachment' : 'inline',
        )
        .type(type);
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();

      const range = parseRange(request.headers.range, info.size);
      if (range === null) return rangeNotSatisfiable(reply, info.size);
      if (range) {
        reply
          .code(206)
          .header('content-range', `bytes ${range.start}-${range.end}/${info.size}`)
          .header('content-length', range.end - range.start + 1);
        return reply.send(createReadStream(file, range));
      }
      reply.header('content-length', info.size);
      return reply.send(createReadStream(file));
    },
  );

  app.get(
    '/api/trees/:tree/media/:id/thumb/:size',
    { schema: { params: MediaThumbParams } },
    async () => {
      throw new ApiError(404, 'not_found', 'Thumbnails are not available yet');
    },
  );
}
