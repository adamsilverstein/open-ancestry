import { seg } from '../api/client';

/*
 * Media URLs shared by the person page, the gallery and the tree views. Only
 * media with a local file are ever requested: Ancestry-only and missing files
 * have nothing on this server to fetch.
 */

export type ThumbSize = 'sm' | 'md' | 'lg';

/** A WebP thumbnail: `sm` 160px (avatars, tiles), `md` 480px, `lg` 1280px (lightbox). */
export const thumbUrl = (tree: string, mediaId: string, size: ThumbSize) =>
  `/api/trees/${seg(tree)}/media/${seg(mediaId)}/thumb/${size}`;

/** A person's avatar: a thumbnail of their primary photo when it has a local file, else undefined. */
export function avatarUrl(
  tree: string,
  person: { primaryMediaId: string | null; primaryPhotoLocal?: boolean },
  size: ThumbSize = 'sm',
): string | undefined {
  return person.primaryMediaId && person.primaryPhotoLocal
    ? thumbUrl(tree, person.primaryMediaId, size)
    : undefined;
}
