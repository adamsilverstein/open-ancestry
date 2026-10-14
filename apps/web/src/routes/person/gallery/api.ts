import { queryOptions } from '@tanstack/react-query';
import type { EventRow, MediaRow } from '@open-ancestry/db';
import { apiGet, apiSend, seg } from '../../../api/client';

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

export type ThumbSize = 'sm' | 'md' | 'lg';

export const personMediaQuery = (tree: string, personId: string) =>
  queryOptions({
    queryKey: ['person-media', tree, personId],
    queryFn: ({ signal }) =>
      apiGet<{ items: GalleryItem[] }>(
        `/trees/${seg(tree)}/people/${seg(personId)}/media`,
        signal,
      ).then((r) => r.items),
  });

export const thumbUrl = (tree: string, mediaId: string, size: ThumbSize) =>
  `/api/trees/${seg(tree)}/media/${seg(mediaId)}/thumb/${size}`;

export const originalUrl = (tree: string, mediaId: string) =>
  `/api/trees/${seg(tree)}/media/${seg(mediaId)}`;

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

export type MediaFilter = 'all' | 'photos' | 'documents' | 'av' | 'online';

/** Which filter group a media belongs to. */
export function mediaGroup(media: MediaRow): Exclude<MediaFilter, 'all'> {
  if (!media.local_path) return 'online';
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
