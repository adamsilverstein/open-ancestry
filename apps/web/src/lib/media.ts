import { seg } from '../api/client';

/*
 * Media URLs shared by the person page, the gallery and the tree views. Only
 * media with a local file are ever requested: Ancestry-only and missing files
 * have nothing on this server to fetch.
 */

export type ThumbSize = 'sm' | 'md' | 'lg';

/**
 * Ties a media URL to the file's bytes: a replaced file (#75) gets a new URL,
 * so a page that already drew the old image does not reuse it from its cache.
 */
export const versioned = (url: string, version?: string | null) =>
  version ? `${url}?v=${encodeURIComponent(version)}` : url;

/** A WebP thumbnail: `sm` 160px (avatars, tiles), `md` 480px, `lg` 1280px (lightbox). */
export const thumbUrl = (tree: string, mediaId: string, size: ThumbSize, version?: string | null) =>
  versioned(`/api/trees/${seg(tree)}/media/${seg(mediaId)}/thumb/${size}`, version);

/** The version `thumbUrl` takes for a media row: its sha256, shortened as the server does. */
export const mediaVersion = (media: { sha256: string | null }) =>
  media.sha256?.slice(0, 16) ?? null;

/** A person's avatar: a thumbnail of their primary photo when it has a local file, else undefined. */
export function avatarUrl(
  tree: string,
  person: {
    primaryMediaId: string | null;
    primaryPhotoLocal?: boolean;
    primaryPhotoVersion?: string | null;
  },
  size: ThumbSize = 'sm',
): string | undefined {
  return person.primaryMediaId && person.primaryPhotoLocal
    ? thumbUrl(tree, person.primaryMediaId, size, person.primaryPhotoVersion)
    : undefined;
}
