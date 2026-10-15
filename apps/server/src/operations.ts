import { closeSync, openSync, readSync } from 'node:fs';
import {
  familyChildren,
  names,
  persons,
  tagLinks,
  tags,
  treePaths,
  type MediaRow,
  type TreeStore,
  type Tx,
} from '@open-ancestry/db';
import { nameRow, refreshLiving, requireRow } from './edits';
import { conflict, notFound } from './errors';
import { resolveMediaPathSync, sniffMediaType } from './routes/media';
import type { BatchOperation, NameBody } from './schemas';
import type { Static } from 'typebox';
import type { FamilyChildPatch, PersonPatch, TagBody } from './schemas';

/** Image types whose signature we can check; others (TIFF, HEIC) are taken on trust. */
const SNIFFABLE = /^image\/(jpeg|png|gif|webp)$|\.(jpe?g|png|gif|webp)$/i;

/**
 * Why a media cannot be a profile photo, or null if it can: it needs a file in
 * the tree (not only an Ancestry URL, not missing), and a file that claims to
 * be a common image type must really be one, or every avatar of it breaks.
 */
function profilePhotoProblem(store: TreeStore, media: MediaRow): string | null {
  if (!media.local_path)
    return 'This media has no file in this tree, so it cannot be the profile photo';
  // In-memory trees (tests) have no media folder to check.
  if (store.dir === null) return null;
  // Confined like every media read: a symlink out of the media folder is no file here.
  const path = resolveMediaPathSync(treePaths(store.dir).media, media.local_path);
  if (!path) return 'This media has no file in this tree, so it cannot be the profile photo';
  let head: Buffer;
  try {
    const fd = openSync(path, 'r');
    try {
      head = Buffer.alloc(16);
      head = head.subarray(0, readSync(fd, head, 0, 16, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return 'This media has no file in this tree, so it cannot be the profile photo';
  }
  const claimsImage = SNIFFABLE.test(media.mime ?? '') || SNIFFABLE.test(media.local_path);
  if (claimsImage && !sniffMediaType(head)?.startsWith('image/')) {
    return 'This file is not a readable image, so it cannot be the profile photo';
  }
  return null;
}

/*
 * Edits shared by their single routes and POST /batch. Each runs inside the
 * caller's transaction and throws an ApiError to abort the whole batch.
 */

export function updatePerson(tx: Tx, id: string, patch: Static<typeof PersonPatch>) {
  requireRow(tx.store, 'person', id);
  if (patch.primary_media_id) {
    const media = tx.store.getRow('media', patch.primary_media_id);
    if (!media) throw notFound(`media ${patch.primary_media_id} not found`);
    const problem = profilePhotoProblem(tx.store, media);
    if (problem) throw conflict(problem);
  }
  const person = persons.update(tx, id, patch);
  // `unknown` asks for the inferred status again.
  if (patch.living !== undefined) refreshLiving(tx, [id], { relatives: false });
  return person;
}

export function addName(tx: Tx, personId: string, body: NameBody) {
  requireRow(tx.store, 'person', personId);
  return names.add(tx, personId, nameRow(body));
}

export function updateName(tx: Tx, id: string, body: NameBody) {
  const existing = requireRow(tx.store, 'person_name', id);
  return names.update(tx, id, nameRow(body, existing));
}

export function deleteName(tx: Tx, id: string) {
  const name = requireRow(tx.store, 'person_name', id);
  const { n } = tx.store
    .stmt('SELECT count(*) AS n FROM person_name WHERE person_id = ?')
    .get(name.person_id) as { n: number };
  if (n === 1) throw conflict('Cannot delete the only name of a person');
  names.delete(tx, id);
}

export function updateFamilyChild(tx: Tx, id: string, patch: Static<typeof FamilyChildPatch>) {
  requireRow(tx.store, 'family_child', id);
  const { is_preferred, ...rest } = patch;
  if (is_preferred) familyChildren.setPreferred(tx, id);
  return familyChildren.update(tx, id, rest);
}

export function createTag(tx: Tx, body: Static<typeof TagBody>, attachTo?: string) {
  const tag = tags.create(tx, { ...body, category: body.category ?? '' });
  if (attachTo) tagPerson(tx, attachTo, tag.id);
  return tag;
}

/** Tags a person; tagging them again changes nothing (so a retried request is harmless). */
export function tagPerson(tx: Tx, personId: string, tagId: string) {
  requireRow(tx.store, 'person', personId);
  requireRow(tx.store, 'tag', tagId);
  const existing = tagLinks.listFor(tx.store, 'person', personId).find((l) => l.tag_id === tagId);
  return (
    existing ?? tagLinks.create(tx, { tag_id: tagId, owner_type: 'person', owner_id: personId })
  );
}

/** Untags a person; a tag they do not have is already gone, so that changes nothing. */
export function untagPerson(tx: Tx, personId: string, tagId: string) {
  requireRow(tx.store, 'person', personId);
  const link = tagLinks.listFor(tx.store, 'person', personId).find((l) => l.tag_id === tagId);
  if (link) tagLinks.delete(tx, link.id);
}

/** Runs one batch operation; the result is what the single route would return. */
export function runOperation(tx: Tx, operation: BatchOperation): unknown {
  switch (operation.op) {
    case 'person.update':
      return updatePerson(tx, operation.id, operation.patch);
    case 'name.add':
      return addName(tx, operation.personId, operation.name);
    case 'name.update':
      return updateName(tx, operation.id, operation.name);
    case 'name.delete':
      return deleteName(tx, operation.id) ?? null;
    case 'familyChild.update':
      return updateFamilyChild(tx, operation.id, operation.patch);
    case 'tag.create':
      return createTag(tx, operation.tag, operation.attachTo);
    case 'person.tag':
      return tagPerson(tx, operation.personId, operation.tagId);
    case 'person.untag':
      return untagPerson(tx, operation.personId, operation.tagId) ?? null;
  }
}
