import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/*
 * Media paths come from untrusted GEDCOM, and since #151 a library may be
 * shared with other accounts that can write into a tree folder. A media file
 * is served or exported only when:
 * - its path stays inside the root (no `..`, no absolute path);
 * - the root itself is a real folder, not a symlink (a symlinked media/ would
 *   make everything it points at count as inside the tree);
 * - after following symlinks, the file is still inside the root;
 * - it has a single hard link. A second link could be any file of yours,
 *   linked into the tree by someone who can write there. The file's owner
 *   is not checked: that linked file is owned by you, so a uid check would
 *   pass it, and refusing every second link is the only rule that holds.
 * Both resolvers apply the same rules (the server's media-resolve.test.ts), and report
 * why they refuse through `onRefuse` so a refusal is never silent.
 */

export type MediaRefusal =
  | 'outside the media folder'
  | 'missing'
  | 'symlinked media folder'
  | 'hard link'
  /** The file at the checked path changed between the check and the open (a swapped folder). */
  | 'changed';

type OnRefuse = ((reason: MediaRefusal) => void) | undefined;

function inside(root: string, localPath: string): string | null {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, localPath);
  return candidate.startsWith(resolvedRoot + sep) ? candidate : null;
}

/** The final check shared by both resolvers. */
function accept(
  rootIsLink: boolean,
  realRoot: string,
  realFile: string,
  links: bigint,
  onRefuse: OnRefuse,
): string | null {
  const reason: MediaRefusal | null = rootIsLink
    ? 'symlinked media folder'
    : !realFile.startsWith(realRoot + sep)
      ? 'outside the media folder'
      : links > 1n
        ? 'hard link'
        : null;
  if (reason) onRefuse?.(reason);
  return reason ? null : realFile;
}

/** `resolveMediaPath` for synchronous callers (the profile-photo check inside a transaction). */
export function resolveMediaPathSync(
  mediaRoot: string,
  localPath: string,
  onRefuse?: (reason: MediaRefusal) => void,
): string | null {
  return checkMediaPathSync(mediaRoot, localPath, onRefuse)?.path ?? null;
}

/** `resolveMediaPathSync`, also returning the stat of the file it checked. */
export function checkMediaPathSync(
  mediaRoot: string,
  localPath: string,
  onRefuse?: (reason: MediaRefusal) => void,
): { path: string; info: BigIntStats } | null {
  const candidate = inside(mediaRoot, localPath);
  if (!candidate) {
    onRefuse?.('outside the media folder');
    return null;
  }
  let checked: [boolean, string, string, BigIntStats];
  try {
    const root = resolve(mediaRoot);
    // .native: the same realpath(3) the async version uses, so both agree on case.
    const realFile = realpathSync.native(candidate);
    checked = [
      lstatSync(root).isSymbolicLink(),
      realpathSync.native(root),
      realFile,
      statSync(realFile, { bigint: true }),
    ];
  } catch {
    onRefuse?.('missing');
    return null;
  }
  const [rootIsLink, realRoot, realFile, info] = checked;
  const path = accept(rootIsLink, realRoot, realFile, info.nlink, onRefuse);
  return path ? { path, info } : null;
}

/** `resolveMediaPath`, also returning the stat of the file it checked. */
async function resolveChecked(
  mediaRoot: string,
  localPath: string,
  onRefuse: OnRefuse,
): Promise<{ path: string; info: BigIntStats } | null> {
  const candidate = inside(mediaRoot, localPath);
  if (!candidate) {
    onRefuse?.('outside the media folder');
    return null;
  }
  let checked: [BigIntStats, string, string, BigIntStats];
  try {
    const root = resolve(mediaRoot);
    const [rootStat, realRoot, realFile] = await Promise.all([
      lstat(root, { bigint: true }),
      realpath(root),
      realpath(candidate),
    ]);
    checked = [rootStat, realRoot, realFile, await stat(realFile, { bigint: true })];
  } catch {
    onRefuse?.('missing');
    return null;
  }
  const [rootStat, realRoot, realFile, info] = checked;
  const path = accept(rootStat.isSymbolicLink(), realRoot, realFile, info.nlink, onRefuse);
  return path ? { path, info } : null;
}

/** Resolves a media.local_path inside the tree's media folder (see the rules above); null if refused. */
export async function resolveMediaPath(
  mediaRoot: string,
  localPath: string,
  onRefuse?: (reason: MediaRefusal) => void,
): Promise<string | null> {
  return (await resolveChecked(mediaRoot, localPath, onRefuse))?.path ?? null;
}

/**
 * Opens a media file for serving: resolves it (see the rules above), then
 * opens that path without following a symlink and checks through the open
 * descriptor that it is still the same single-link regular file. Reading
 * from the descriptor means a file swapped after the check is never served.
 */
export async function openMediaFile(
  mediaRoot: string,
  localPath: string,
  onRefuse?: (reason: MediaRefusal) => void,
  /** Test seams: between the check and the open, and just after the open. */
  hooks: { afterResolve?: () => Promise<void>; afterOpen?: (handle: FileHandle) => void } = {},
): Promise<{ handle: FileHandle; info: BigIntStats } | null> {
  const checked = await resolveChecked(mediaRoot, localPath, onRefuse);
  if (!checked) return null;
  await hooks.afterResolve?.();
  let handle: FileHandle | undefined;
  try {
    handle = await open(checked.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    hooks.afterOpen?.(handle);
    const info = await handle.stat({ bigint: true });
    const refusal = openedRefusal(checked.info, info);
    if (!refusal) return { handle, info };
    onRefuse?.(refusal);
  } catch {
    onRefuse?.('changed');
  }
  // A failed close must not hide the refusal.
  await handle?.close().catch(() => {});
  return null;
}

/** `openMediaFile` for synchronous callers: an open file descriptor the caller closes. */
export function openMediaFileSync(
  mediaRoot: string,
  localPath: string,
  onRefuse?: (reason: MediaRefusal) => void,
): { fd: number; info: BigIntStats } | null {
  const checked = checkMediaPathSync(mediaRoot, localPath, onRefuse);
  if (!checked) return null;
  let fd: number | undefined;
  try {
    fd = openSync(checked.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd, { bigint: true });
    const refusal = openedRefusal(checked.info, info);
    if (!refusal) return { fd, info };
    onRefuse?.(refusal);
  } catch {
    onRefuse?.('changed');
  }
  if (fd !== undefined) {
    try {
      closeSync(fd);
    } catch {
      // A failed close must not hide the refusal.
    }
  }
  return null;
}

/**
 * Why an opened file is not the one the checks passed, if it is not. The
 * open descriptor is compared with the checked inode, not a second look up
 * of the path: an intermediate folder swapped for a symlink since the check
 * yields another file.
 */
function openedRefusal(checked: BigIntStats, opened: BigIntStats): MediaRefusal | null {
  const same = opened.isFile() && opened.dev === checked.dev && opened.ino === checked.ino;
  return !same ? 'changed' : opened.nlink > 1n ? 'hard link' : null;
}
