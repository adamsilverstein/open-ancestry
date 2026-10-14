import type {
  BatchState,
  ChangeOp,
  ChildRelationship,
  CitationOwner,
  EventRole,
  ImportStatus,
  LivingStatus,
  MediaKind,
  MediaOwner,
  NameType,
  NoteOwner,
  Privacy,
  RelationshipType,
  Sex,
  TagOwner,
} from './enums';

/*
 * Row types mirror the SQLite tables column for column (snake_case), and are
 * also the row shape of the JSON interchange format. Booleans are 0 | 1.
 * See docs/data-model.md for the meaning of every column.
 */

type Bit = 0 | 1;

interface Timestamps {
  created_at: string;
  updated_at: string;
}

interface Imported {
  external_id: string | null;
  import_batch_id: string | null;
}

export interface MetaRow {
  key: string;
  value: string;
}

export interface ImportBatchRow {
  id: string;
  file_name: string | null;
  file_sha256: string | null;
  format: string | null;
  source_software: string | null;
  source_version: string | null;
  status: ImportStatus;
  counts_json: string;
  warnings_json: string;
  started_at: string;
  finished_at: string | null;
}

export interface PersonRow extends Timestamps, Imported {
  id: string;
  sex: Sex;
  living: LivingStatus;
  privacy: Privacy;
  primary_media_id: string | null;
}

export interface PersonNameRow {
  id: string;
  person_id: string;
  type: NameType;
  given: string | null;
  surname: string | null;
  surname_prefix: string | null;
  prefix: string | null;
  suffix: string | null;
  nickname: string | null;
  full_text: string | null;
  surname_key: string | null;
  is_primary: Bit;
  sort_order: number;
}

export interface PlaceRow extends Timestamps {
  id: string;
  name: string;
  full_name: string;
  parent_id: string | null;
  type: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface EventRow extends Timestamps {
  id: string;
  type: string;
  custom_type: string | null;
  date_text: string | null;
  date_qualifier: string | null;
  date_sort: number | null;
  date_sort_end: number | null;
  calendar: string | null;
  place_id: string | null;
  value: string | null;
  description: string | null;
  age: string | null;
  cause: string | null;
  privacy: Privacy;
  import_batch_id: string | null;
}

export interface EventRoleRow {
  id: string;
  event_id: string;
  person_id: string | null;
  family_id: string | null;
  role: EventRole;
  is_preferred: Bit;
  sort_order: number;
}

export interface FamilyRow extends Timestamps, Imported {
  id: string;
  partner1_id: string | null;
  partner2_id: string | null;
  relationship_type: RelationshipType;
  partner1_order: number;
  partner2_order: number;
  privacy: Privacy;
}

export interface FamilyChildRow {
  id: string;
  family_id: string;
  child_id: string;
  partner1_rel: ChildRelationship;
  partner2_rel: ChildRelationship;
  sort_order: number;
  child_order: number;
  is_preferred: Bit;
}

export interface RepositoryRow extends Timestamps, Imported {
  id: string;
  name: string;
  address: string | null;
  url: string | null;
  email: string | null;
  phone: string | null;
}

export interface SourceRow extends Timestamps, Imported {
  id: string;
  title: string;
  author: string | null;
  publication: string | null;
  abbreviation: string | null;
  text: string | null;
  repository_id: string | null;
  call_number: string | null;
  apid: string | null;
}

export interface CitationRow extends Timestamps {
  id: string;
  source_id: string;
  page: string | null;
  quality: number | null;
  date_text: string | null;
  text: string | null;
  apid: string | null;
  url: string | null;
}

export interface CitationLinkRow {
  id: string;
  citation_id: string;
  owner_type: CitationOwner;
  owner_id: string;
  sort_order: number;
}

export interface MediaRow extends Timestamps, Imported {
  id: string;
  kind: MediaKind;
  mime: string | null;
  local_path: string | null;
  remote_url: string | null;
  ancestry_oid: string | null;
  title: string | null;
  date_text: string | null;
  description: string | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  byte_size: number | null;
}

export interface MediaLinkRow {
  id: string;
  media_id: string;
  owner_type: MediaOwner;
  owner_id: string;
  sort_order: number;
  crop_json: string | null;
}

export interface NoteRow extends Timestamps, Imported {
  id: string;
  text: string;
}

export interface NoteLinkRow {
  id: string;
  note_id: string;
  owner_type: NoteOwner;
  owner_id: string;
  sort_order: number;
}

export interface TagRow extends Timestamps, Imported {
  id: string;
  name: string;
  category: string;
  color: string | null;
}

export interface TagLinkRow {
  id: string;
  tag_id: string;
  owner_type: TagOwner;
  owner_id: string;
}

export interface RawRecordRow {
  id: string;
  import_batch_id: string;
  seq: number;
  owner_type: string | null;
  owner_id: string | null;
  gedcom_tag: string;
  xref: string | null;
  raw_text: string;
}

export interface UnmappedLineRow {
  id: string;
  import_batch_id: string;
  owner_type: string | null;
  owner_id: string | null;
  path: string;
  line_no: number;
  line: string;
}

export interface ChangeBatchRow {
  id: string;
  label: string;
  state: BatchState;
  created_at: string;
  state_changed_at: string | null;
  /** Commit order, 1, 2, 3, ...; undo, redo and history sort by it. */
  seq: number;
}

export interface ChangeLogRow {
  seq: number;
  batch_id: string;
  ts: string;
  entity: string;
  entity_id: string;
  op: ChangeOp;
  before_json: string | null;
  after_json: string | null;
  /** Schema version the images were written under. */
  schema_version: number;
}

/** Tables written through the unit of work (and exported to JSON), by name. */
export interface TableRows {
  meta: MetaRow;
  import_batch: ImportBatchRow;
  person: PersonRow;
  person_name: PersonNameRow;
  place: PlaceRow;
  event: EventRow;
  event_role: EventRoleRow;
  family: FamilyRow;
  family_child: FamilyChildRow;
  repository: RepositoryRow;
  source: SourceRow;
  citation: CitationRow;
  citation_link: CitationLinkRow;
  media: MediaRow;
  media_link: MediaLinkRow;
  note: NoteRow;
  note_link: NoteLinkRow;
  tag: TagRow;
  tag_link: TagLinkRow;
  raw_record: RawRecordRow;
  unmapped_line: UnmappedLineRow;
}

export type TableName = keyof TableRows;

/** Columns that must be supplied on insert; everything else has a default. */
export interface RequiredOnInsert {
  meta: 'key' | 'value';
  import_batch: never;
  person: never;
  person_name: 'person_id';
  place: 'name' | 'full_name';
  event: 'type';
  event_role: 'event_id';
  family: never;
  family_child: 'family_id' | 'child_id';
  repository: 'name';
  source: 'title';
  citation: 'source_id';
  citation_link: 'citation_id' | 'owner_type' | 'owner_id';
  media: never;
  media_link: 'media_id' | 'owner_type' | 'owner_id';
  note: 'text';
  note_link: 'note_id' | 'owner_type' | 'owner_id';
  tag: 'name';
  tag_link: 'tag_id' | 'owner_type' | 'owner_id';
  raw_record: 'import_batch_id' | 'seq' | 'gedcom_tag' | 'raw_text';
  unmapped_line: 'import_batch_id' | 'path' | 'line_no' | 'line';
}

/** Insert input for a table: required columns plus any optional ones. */
export type InsertRow<T extends TableName> = Pick<
  TableRows[T],
  Extract<RequiredOnInsert[T], keyof TableRows[T]>
> &
  Partial<TableRows[T]>;

/** Update input: any column except the key and created_at. */
export type PatchRow<T extends TableName> = Partial<
  Omit<TableRows[T], 'id' | 'key' | 'created_at'>
>;
