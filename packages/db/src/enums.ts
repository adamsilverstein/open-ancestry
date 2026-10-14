/**
 * Enumerated column values. Each list matches a CHECK constraint in the
 * migrations (schema.test.ts verifies this) and is documented in
 * docs/data-model.md.
 */

export const SEXES = ['M', 'F', 'X', 'U'] as const;
export type Sex = (typeof SEXES)[number];

/**
 * `living` and `dead` are explicit user choices and are never overwritten by
 * inference; `inferred_*` come from the living-status rules; `unknown` means
 * inference has not run.
 */
export const LIVING_STATUSES = [
  'living',
  'dead',
  'inferred_living',
  'inferred_dead',
  'unknown',
] as const;
export type LivingStatus = (typeof LIVING_STATUSES)[number];

/** Whether privacy features should treat the person as living (unknown counts as living). */
export function isLiving(status: LivingStatus): boolean {
  return status !== 'dead' && status !== 'inferred_dead';
}

export const PRIVACY_LEVELS = ['public', 'private', 'confidential', 'locked'] as const;
export type Privacy = (typeof PRIVACY_LEVELS)[number];

export const NAME_TYPES = [
  'birth',
  'married',
  'maiden',
  'aka',
  'immigrant',
  'professional',
  'religious',
  'other',
] as const;
export type NameType = (typeof NAME_TYPES)[number];

export const EVENT_ROLES = [
  'principal',
  'witness',
  'godparent',
  'officiator',
  'clergy',
  'informant',
  'parent',
  'father',
  'mother',
  'child',
  'spouse',
  'husband',
  'wife',
  'friend',
  'neighbor',
  'multiple',
  'other',
] as const;
export type EventRole = (typeof EVENT_ROLES)[number];

export const RELATIONSHIP_TYPES = ['married', 'civil_union', 'partners', 'unknown'] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/** Relationship of a child to one partner of the family (Ancestry `_FREL`/`_MREL`, GEDCOM `PEDI`). */
export const CHILD_RELATIONSHIPS = [
  'biological',
  'adopted',
  'step',
  'foster',
  'related',
  'guardian',
  'private',
  'unknown',
] as const;
export type ChildRelationship = (typeof CHILD_RELATIONSHIPS)[number];

export const MEDIA_KINDS = ['photo', 'document', 'audio', 'video', 'other'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const CITATION_OWNERS = [
  'person',
  'person_name',
  'event',
  'family',
  'family_child',
  'media',
  'note',
] as const;
export type CitationOwner = (typeof CITATION_OWNERS)[number];

export const MEDIA_OWNERS = ['person', 'event', 'family', 'source', 'citation', 'place'] as const;
export type MediaOwner = (typeof MEDIA_OWNERS)[number];

export const NOTE_OWNERS = [
  'person',
  'person_name',
  'event',
  'family',
  'family_child',
  'source',
  'citation',
  'media',
  'place',
  'repository',
] as const;
export type NoteOwner = (typeof NOTE_OWNERS)[number];

export const TAG_OWNERS = ['person', 'family', 'event', 'media', 'source'] as const;
export type TagOwner = (typeof TAG_OWNERS)[number];

export const IMPORT_STATUSES = ['running', 'completed', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const BATCH_STATES = ['applied', 'undone', 'superseded'] as const;
export type BatchState = (typeof BATCH_STATES)[number];

export const CHANGE_OPS = ['insert', 'update', 'delete'] as const;
export type ChangeOp = (typeof CHANGE_OPS)[number];

/** `table.column` -> allowed values, for every CHECK-constrained enum column. */
export const ENUM_COLUMNS = {
  'person.sex': SEXES,
  'person.living': LIVING_STATUSES,
  'person.privacy': PRIVACY_LEVELS,
  'person_name.type': NAME_TYPES,
  'event.privacy': PRIVACY_LEVELS,
  'event_role.role': EVENT_ROLES,
  'family.relationship_type': RELATIONSHIP_TYPES,
  'family.privacy': PRIVACY_LEVELS,
  'family_child.partner1_rel': CHILD_RELATIONSHIPS,
  'family_child.partner2_rel': CHILD_RELATIONSHIPS,
  'media.kind': MEDIA_KINDS,
  'citation_link.owner_type': CITATION_OWNERS,
  'media_link.owner_type': MEDIA_OWNERS,
  'note_link.owner_type': NOTE_OWNERS,
  'tag_link.owner_type': TAG_OWNERS,
  'import_batch.status': IMPORT_STATUSES,
  'change_batch.state': BATCH_STATES,
  'change_log.op': CHANGE_OPS,
} as const satisfies Record<string, readonly string[]>;
