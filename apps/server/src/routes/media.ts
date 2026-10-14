import { createReadStream, realpathSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { treePaths } from '@open-ancestry/db';
import type { FastifyReply } from 'fastify';
import type { Api, Deps } from '../context';
import { errorBody, notFound } from '../errors';
import { TreeIdParams } from '../schemas';

/*
 * Media comes from untrusted GEDCOM/GEDZIP files, so neither media.mime nor
 * the file extension is trusted. The type is sniffed from the file's first
 * bytes against a fixed allowlist of inert formats; anything else (HTML, SVG,
 * text, unknown) is served as an application/octet-stream attachment.
 */

/** Media is never allowed to run script, even when opened directly. */
export const MEDIA_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
export const OPAQUE_TYPE = 'application/octet-stream';
export const SNIFF_BYTES = 16;

const ascii = (bytes: Buffer, at: number, text: string) =>
  bytes.subarray(at, at + text.length).toString('latin1') === text;

/** Content type from magic bytes, limited to formats a browser renders without script. */
export function sniffMediaType(bytes: Buffer): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(bytes, 0, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'image/gif';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) return 'audio/wav';
  if (ascii(bytes, 0, '%PDF-')) return 'application/pdf';
  if (ascii(bytes, 0, 'OggS')) return 'audio/ogg';
  if (ascii(bytes, 0, 'fLaC')) return 'audio/flac';
  if (ascii(bytes, 0, 'ID3') || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))
    return 'audio/mpeg';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return 'video/webm';
  if (ascii(bytes, 4, 'ftyp')) {
    const brand = bytes.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'M4A ') return 'audio/mp4';
    if (/^(isom|iso2|mp41|mp42|avc1|M4V |dash)$/.test(brand)) return 'video/mp4';
  }
  return null;
}

async function readHead(file: string): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Resolves a media.local_path inside the tree's media folder, following symlinks; null if it escapes. */
/** `resolveMediaPath` for synchronous callers (the profile-photo check inside a transaction). */
export function resolveMediaPathSync(mediaRoot: string, localPath: string): string | null {
  const root = resolve(mediaRoot);
  const candidate = resolve(root, localPath);
  if (!candidate.startsWith(root + sep)) return null;
  try {
    const realRoot = realpathSync(root);
    const realFile = realpathSync(candidate);
    return realFile.startsWith(realRoot + sep) ? realFile : null;
  } catch {
    return null;
  }
}

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
      const sniffed = await readHead(file).then(sniffMediaType);
      reply
        .header('content-security-policy', MEDIA_CSP)
        .header('x-content-type-options', 'nosniff')
        .header('accept-ranges', 'bytes')
        .header('etag', etag)
        .header('last-modified', info.mtime.toUTCString())
        .header('cache-control', 'private, no-cache')
        .header('content-disposition', sniffed ? 'inline' : 'attachment')
        .type(sniffed ?? OPAQUE_TYPE);
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
}
