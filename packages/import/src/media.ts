import { toNFC, type MediaKind } from '@open-ancestry/db';
import { safeEntryPath } from '@open-ancestry/gedcom';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/** What a GEDCOM `FILE` value points at. */
export type FileRef =
  | { type: 'remote'; url: string }
  | { type: 'local'; path: string }
  /** Absolute path from the exporting computer; only its file name can be matched. */
  | { type: 'absolute'; name: string }
  /** Traversal (`..`) or otherwise unsafe; never resolved. */
  | { type: 'unsafe' };

export function classifyFile(value: string): FileRef {
  const text = value.trim();
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(text) && !/^file:/i.test(text)) {
    return { type: 'remote', url: text };
  }
  const path = text.replace(/^file:\/\//i, '');
  const name = path.split(/[\\/]/).pop() ?? '';
  if (/^([\\/]|[A-Za-z]:)/.test(path)) {
    return name && name !== '..' && name !== '.' ? { type: 'absolute', name } : { type: 'unsafe' };
  }
  const safe = safeEntryPath(path);
  return safe ? { type: 'local', path: safe } : { type: 'unsafe' };
}

const TYPES: Record<string, [string, MediaKind]> = {
  jpg: ['image/jpeg', 'photo'],
  jpeg: ['image/jpeg', 'photo'],
  png: ['image/png', 'photo'],
  gif: ['image/gif', 'photo'],
  bmp: ['image/bmp', 'photo'],
  webp: ['image/webp', 'photo'],
  heic: ['image/heic', 'photo'],
  tif: ['image/tiff', 'photo'],
  tiff: ['image/tiff', 'photo'],
  svg: ['image/svg+xml', 'photo'],
  pdf: ['application/pdf', 'document'],
  txt: ['text/plain', 'document'],
  rtf: ['application/rtf', 'document'],
  doc: ['application/msword', 'document'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document'],
  mp3: ['audio/mpeg', 'audio'],
  wav: ['audio/wav', 'audio'],
  m4a: ['audio/mp4', 'audio'],
  ogg: ['audio/ogg', 'audio'],
  mp4: ['video/mp4', 'video'],
  mov: ['video/quicktime', 'video'],
  avi: ['video/x-msvideo', 'video'],
  webm: ['video/webm', 'video'],
};

/** MIME type and kind from a `FORM` value (`jpg`, `image/jpeg`) or a file name. */
export function mediaType(
  formOrPath: string | undefined,
): { mime: string; kind: MediaKind } | undefined {
  const text = (formOrPath ?? '').trim().toLowerCase();
  if (!text) return undefined;
  if (text.includes('/') && !text.includes('.')) {
    const entry = Object.values(TYPES).find(([mime]) => mime === text);
    return entry ? { mime: entry[0], kind: entry[1] } : undefined;
  }
  const ext = text.split('?')[0]!.split('.').pop()!;
  const entry = TYPES[ext];
  return entry ? { mime: entry[0], kind: entry[1] } : undefined;
}

/** Media kind from a `FORM.TYPE` / `_TYPE` value (`photo`, `certificate`, `audio`, ...). */
export function kindFromType(value: string | undefined): MediaKind | undefined {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return undefined;
  if (/audio/.test(v)) return 'audio';
  if (/video|film/.test(v)) return 'video';
  if (/photo|image|portrait|tombstone|picture/.test(v)) return 'photo';
  return 'document';
}

interface SourceFile {
  path: string;
  size: number;
  read: () => Uint8Array;
}

const MAX_FILES = 200_000;
const MAX_DEPTH = 32;

/**
 * The media files available to an import: a GEDZIP's entries or a folder on
 * disk. Folders are walked without following symlinks, so a link cannot pull
 * in files from elsewhere. Lookups try the exact relative path, then a
 * case-insensitive match, then a unique file name, all in Unicode NFC so a
 * decomposed name (as macOS writes them) matches its composed spelling.
 */
export class MediaSource {
  private readonly byPath = new Map<string, SourceFile>();
  private readonly byLowerPath = new Map<string, SourceFile>();
  private readonly byName = new Map<string, SourceFile[]>();
  readonly available: boolean;
  /** Whether the files' bytes are held in memory (a GEDZIP's entries). */
  readonly inMemory: boolean;
  private readonly files: SourceFile[];

  private constructor(files: SourceFile[], available: boolean, inMemory = false) {
    this.available = available;
    this.inMemory = inMemory;
    this.files = files;
    for (const file of files) {
      const path = toNFC(file.path);
      this.byPath.set(path, file);
      this.byLowerPath.set(path.toLowerCase(), file);
      const name = path.split('/').pop()!.toLowerCase();
      const list = this.byName.get(name);
      if (list) list.push(file);
      else this.byName.set(name, [file]);
    }
  }

  static none(): MediaSource {
    return new MediaSource([], false);
  }

  static fromEntries(entries: Map<string, Uint8Array>): MediaSource {
    return new MediaSource(
      [...entries].map(([path, bytes]) => ({ path, size: bytes.length, read: () => bytes })),
      true,
      true,
    );
  }

  /**
   * Writes in-memory files to `dir` and returns a source that reads them from
   * there, so a long-lived holder (a re-import review) keeps no bytes in
   * memory. Paths that aren't safe relative paths are dropped.
   */
  spill(dir: string): MediaSource {
    const files: SourceFile[] = [];
    for (const file of this.files) {
      const rel = safeEntryPath(file.path);
      if (!rel) continue;
      const full = join(dir, ...rel.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, file.read());
      const size = file.size;
      files.push({ path: file.path, size, read: () => readFileSync(full) });
    }
    return new MediaSource(files, this.available);
  }

  static fromDir(root: string): MediaSource {
    const files: SourceFile[] = [];
    const walk = (dir: string, prefix: string, depth: number) => {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) return;
        const full = join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(full, rel, depth + 1);
        // A name with a backslash would not survive as a forward-slash relative path.
        else if (entry.isFile() && safeEntryPath(rel) === rel) {
          files.push({
            path: rel,
            get size() {
              try {
                return statSync(full).size;
              } catch {
                return 0;
              }
            },
            read: () => readFileSync(full),
          });
        }
      }
    };
    walk(root, '', 0);
    return new MediaSource(files, true);
  }

  find(ref: FileRef): SourceFile | undefined {
    if (ref.type === 'local') {
      const path = toNFC(ref.path);
      const exact = this.byPath.get(path) ?? this.byLowerPath.get(path.toLowerCase());
      if (exact) return exact;
    }
    const name =
      ref.type === 'local'
        ? ref.path.split('/').pop()
        : ref.type === 'absolute'
          ? ref.name
          : undefined;
    const matches = name ? this.byName.get(toNFC(name).toLowerCase()) : undefined;
    return matches?.length === 1 ? matches[0] : undefined;
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** `photos/a.jpg` -> `photos/a-2.jpg`. */
export function suffixedPath(relPath: string, n: number): string {
  const slash = relPath.lastIndexOf('/');
  const dot = relPath.lastIndexOf('.');
  const cut = dot > slash + 1 ? dot : relPath.length;
  return `${relPath.slice(0, cut)}-${n}${relPath.slice(cut)}`;
}

export interface StoredMedia {
  /** Path relative to the media folder where the bytes now live. */
  path: string;
  /** True when this call wrote the file (false when identical bytes were already there). */
  written: boolean;
  /** First folder created for it, if any. */
  folder: string | undefined;
}

/**
 * Stores a media file under the tree's media folder without ever overwriting
 * one: identical bytes already at the path are reused, different bytes get a
 * `-2`, `-3`, ... suffix. Refuses anything that would land outside the folder.
 */
export function storeMediaFile(
  mediaRoot: string,
  relPath: string,
  bytes: Uint8Array,
  sha256: (bytes: Uint8Array) => string,
): StoredMedia {
  const root = resolve(mediaRoot);
  const hash = sha256(bytes);
  for (let n = 1; n <= 1000; n++) {
    const candidate = n === 1 ? relPath : suffixedPath(relPath, n);
    const target = resolve(root, ...candidate.split('/'));
    if (!target.startsWith(root + sep)) throw new Error(`unsafe media path ${relPath}`);
    const existing = lstatOrNull(target);
    if (existing) {
      // A symlink is never followed or reused: it could point anywhere.
      if (existing.isFile() && sha256(readFileSync(target)) === hash) {
        return { path: candidate, written: false, folder: undefined };
      }
      continue;
    }
    const folder = mkdirSync(dirname(target), { recursive: true });
    // A symlinked folder inside media/ must not carry the write elsewhere.
    const realRoot = realpathSync(root);
    const realDir = realpathSync(dirname(target));
    if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
      throw new Error(`media folder for ${relPath} leads outside the tree`);
    }
    // `wx` fails rather than replace a file that appeared since the check.
    // 0600: private to the owner whatever the process umask.
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    return { path: candidate, written: true, folder };
  }
  throw new Error(`no free name for ${relPath}`);
}
