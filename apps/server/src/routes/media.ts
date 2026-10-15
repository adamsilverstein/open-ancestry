import type { FileHandle } from 'node:fs/promises';
import { escapeControls } from '@open-ancestry/core';
import { openMediaFile, treePaths, type MediaRefusal } from '@open-ancestry/db';
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

async function readHead(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.alloc(SNIFF_BYTES);
  const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
  return buffer.subarray(0, bytesRead);
}

/** The media path rules live in @open-ancestry/db, shared with the GEDZIP export. */
export {
  openMediaFile,
  resolveMediaPath,
  resolveMediaPathSync,
  type MediaRefusal,
} from '@open-ancestry/db';

/** Refusals worth a log line (a missing file is ordinary); each logged once per file. */
const LOGGED_REASONS = new Set<MediaRefusal>([
  'symlinked media folder',
  'hard link',
  'outside the media folder',
  'changed',
]);
const logged = new Set<string>();

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
      const opened = await openMediaFile(
        treePaths(library.dirOf(tree)).media,
        media.local_path,
        (reason) => {
          const key = `${tree}\0${id}\0${reason}`;
          if (!LOGGED_REASONS.has(reason) || logged.has(key)) return;
          if (logged.size > 10_000) logged.clear();
          logged.add(key);
          // console.warn, not app.log: the shipped CLI runs with logger: false. Values come
          // from the tree, so control characters are escaped before reaching a terminal.
          console.warn(
            `open-ancestry: media file not served (${reason}): ${escapeControls(tree)} / ${escapeControls(media.local_path!)}`,
          );
        },
      );
      if (!opened) throw notFound(`Media ${id} file is missing`);
      const { handle, info } = opened;
      let streaming = false;
      try {
        const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
        const sniffed = sniffMediaType(await readHead(handle));
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
          streaming = true;
          return reply.send(handle.createReadStream({ ...range, autoClose: true }));
        }
        reply.header('content-length', info.size);
        streaming = true;
        return reply.send(handle.createReadStream({ autoClose: true }));
      } finally {
        // The stream closes the handle when it ends; every other way out closes it here.
        if (!streaming) await handle.close();
      }
    },
  );
}
