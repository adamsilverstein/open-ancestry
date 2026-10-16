import { queryOptions } from '@tanstack/react-query';
import type { EventRow, MediaRow } from '@open-ancestry/db';
import { apiGet, apiSend, seg } from '../../../api/client';
import { thumbUrl, versioned } from '../../../lib/media';

export type MediaOwner =
  | { type: 'person'; id: string }
  | {
      type: 'event';
      id: string;
      event: Pick<EventRow, 'type' | 'custom_type' | 'date_text' | 'date_sort'>;
    };

/** One media of a person (GET /people/:id/media): on the person, their events, or both. */
export interface GalleryItem {
  media: MediaRow;
  owners: MediaOwner[];
}

export const personMediaQuery = (tree: string, personId: string) =>
  queryOptions({
    queryKey: ['person-media', tree, personId],
    queryFn: ({ signal }) =>
      apiGet<{ items: GalleryItem[] }>(
        `/trees/${seg(tree)}/people/${seg(personId)}/media`,
        signal,
      ).then((r) => r.items),
  });

export { mediaVersion, thumbUrl, type ThumbSize } from '../../../lib/media';

export const originalUrl = (tree: string, mediaId: string, version?: string | null) =>
  versioned(`/api/trees/${seg(tree)}/media/${seg(mediaId)}`, version);

/** Copies a file into the tree and attaches it to a person or event. */
export function attachMedia(
  tree: string,
  owner: { type: 'person' | 'event'; id: string },
  file: File,
): Promise<{ media: MediaRow }> {
  const form = new FormData();
  // Fields before the file: the server reads them while the upload streams.
  form.append('owner_type', owner.type);
  form.append('owner_id', owner.id);
  form.append('file', file, file.name);
  return apiSend('POST', `/trees/${seg(tree)}/media`, form);
}

export const setProfilePhoto = (tree: string, personId: string, mediaId: string | null) =>
  apiSend('PATCH', `/trees/${seg(tree)}/people/${seg(personId)}`, {
    primary_media_id: mediaId,
  });

export type MediaFilter = 'all' | 'photos' | 'documents' | 'av' | 'online' | 'missing';

/**
 * Where a media's file is: in the tree, on Ancestry, at some other URL (never
 * loaded or linked), or nowhere (a FILE that was missing or refused at import).
 */
export type MediaSourceKind = 'local' | 'ancestry' | 'remote' | 'missing';

export function mediaSource(media: MediaRow): MediaSourceKind {
  if (media.local_path) return 'local';
  if (ancestryLink(media.remote_url)) return 'ancestry';
  return media.remote_url ? 'remote' : 'missing';
}

/** Which filter group a media belongs to. */
export function mediaGroup(media: MediaRow): Exclude<MediaFilter, 'all'> {
  const source = mediaSource(media);
  if (source === 'missing') return 'missing';
  if (source !== 'local') return 'online';
  if (media.kind === 'photo') return 'photos';
  if (media.kind === 'audio' || media.kind === 'video') return 'av';
  return 'documents';
}

/** True when the server can make a thumbnail (a local photo). */
export const hasThumbnail = (media: MediaRow) => !!media.local_path && media.kind === 'photo';

/** Ancestry's own sites and its media CDN; imported links to anything else are not shown. */
const ANCESTRY_HOST =
  /(^|\.)(ancestry\.(com|ca|de|fr|it|se|ie|mx|nl|no|dk|fi|be|at|ch|pl|es|pt|co\.uk|com\.au|co\.nz|com\.mx)|ancestrycdn\.com|ancestrylibrary\.com)$/i;

/**
 * The imported media URL when it is an https link to Ancestry, else null.
 * GEDCOM is untrusted, so `javascript:`, `data:`, `file:` and other sites are
 * never rendered as links.
 */
export function ancestryLink(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      ANCESTRY_HOST.test(parsed.hostname)
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/** Longest edge of the `sm` and `md` thumbnails; they are never upscaled. */
const EDGES = { sm: 160, md: 480 } as const;
/** CSS width of a gallery tile's preview. */
export const TILE_WIDTH = 190;

/** Width of a thumbnail made from an original of `size`. */
const thumbWidth = (size: { width: number; height: number }, edge: number) =>
  Math.max(1, Math.round(size.width * Math.min(1, edge / Math.max(size.width, size.height))));

/**
 * `src`, `srcSet` and `sizes` for a tile image. With the original's size known,
 * the descriptors are the thumbnails' real widths, so the browser draws each
 * at its true size; an original no bigger than `sm` gets a plain `src`.
 * Unknown sizes assume full-size thumbnails until the image says otherwise.
 */
export function tileImage(
  tree: string,
  mediaId: string,
  size: { width: number; height: number } | null,
  version?: string | null,
): { src: string; srcSet?: string; sizes?: string } {
  const src = thumbUrl(tree, mediaId, 'sm', version);
  if (size && Math.max(size.width, size.height) <= EDGES.sm) return { src };
  const [sm, md] = size
    ? [thumbWidth(size, EDGES.sm), thumbWidth(size, EDGES.md)]
    : [EDGES.sm, EDGES.md];
  return {
    src,
    srcSet: `${src} ${sm}w, ${thumbUrl(tree, mediaId, 'md', version)} ${md}w`,
    sizes: `${TILE_WIDTH}px`,
  };
}

/**
 * The original's size as far as a loaded tile image shows it: when the
 * thumbnail it got is smaller than that thumbnail's full edge, the original
 * was that small too. Null when the image does not tell (a big original).
 */
export function learnedSize(img: {
  currentSrc: string;
  naturalWidth: number;
  naturalHeight: number;
}): { width: number; height: number } | null {
  const isMd = img.currentSrc.includes('/thumb/md');
  const edge = isMd ? EDGES.md : EDGES.sm;
  // naturalWidth is CSS pixels: the file's pixels divided by the srcset density.
  const density = edge / TILE_WIDTH;
  const width = Math.round(img.naturalWidth * density);
  const height = Math.round(img.naturalHeight * density);
  if (width <= 0 || height <= 0 || Math.max(width, height) >= edge - 1) return null;
  return { width, height };
}
