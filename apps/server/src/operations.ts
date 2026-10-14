import { familyChildren, names, persons, tagLinks, tags, type Tx } from '@open-ancestry/db';
import { nameRow, refreshLiving, requireRow } from './edits';
import { conflict, notFound } from './errors';
import type { BatchOperation, NameBody } from './schemas';
import type { Static } from 'typebox';
import type { FamilyChildPatch, PersonPatch, TagBody } from './schemas';

/*
 * Edits shared by their single routes and POST /batch. Each runs inside the
 * caller's transaction and throws an ApiError to abort the whole batch.
 */

export function updatePerson(tx: Tx, id: string, patch: Static<typeof PersonPatch>) {
  requireRow(tx.store, 'person', id);
  if (patch.primary_media_id && !tx.store.getRow('media', patch.primary_media_id)) {
    throw notFound(`media ${patch.primary_media_id} not found`);
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

export function tagPerson(tx: Tx, personId: string, tagId: string) {
  requireRow(tx.store, 'person', personId);
  requireRow(tx.store, 'tag', tagId);
  return tagLinks.create(tx, { tag_id: tagId, owner_type: 'person', owner_id: personId });
}

export function untagPerson(tx: Tx, personId: string, tagId: string) {
  const link = tagLinks.listFor(tx.store, 'person', personId).find((l) => l.tag_id === tagId);
  if (!link) throw notFound(`Person ${personId} does not have tag ${tagId}`);
  tagLinks.delete(tx, link.id);
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
