CREATE TABLE change_batch (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'applied' CHECK (state IN ('applied', 'undone', 'superseded')),
  created_at TEXT NOT NULL,
  state_changed_at TEXT
) STRICT;

CREATE TABLE change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES change_batch (id) DEFERRABLE INITIALLY DEFERRED,
  ts TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  before_json TEXT,
  after_json TEXT,
  CHECK ((op = 'insert') = (before_json IS NULL) AND (op = 'delete') = (after_json IS NULL))
) STRICT;

CREATE TABLE citation (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES source (id) DEFERRABLE INITIALLY DEFERRED,
  page TEXT,
  quality INTEGER CHECK (quality BETWEEN 0 AND 3),
  date_text TEXT,
  text TEXT,
  apid TEXT,
  url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE citation_link (
  id TEXT PRIMARY KEY NOT NULL,
  citation_id TEXT NOT NULL REFERENCES citation (id) DEFERRABLE INITIALLY DEFERRED,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('person', 'person_name', 'event', 'family', 'family_child', 'media', 'note')),
  owner_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (citation_id, owner_type, owner_id)
) STRICT;

CREATE TABLE event (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  custom_type TEXT,
  date_text TEXT,
  date_qualifier TEXT,
  date_sort INTEGER,
  date_sort_end INTEGER,
  calendar TEXT,
  place_id TEXT REFERENCES place (id) DEFERRABLE INITIALLY DEFERRED,
  value TEXT,
  description TEXT,
  age TEXT,
  cause TEXT,
  privacy TEXT NOT NULL DEFAULT 'public' CHECK (privacy IN ('public', 'private', 'confidential', 'locked')),
  import_batch_id TEXT REFERENCES import_batch (id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE event_role (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES event (id) DEFERRABLE INITIALLY DEFERRED,
  person_id TEXT REFERENCES person (id) DEFERRABLE INITIALLY DEFERRED,
  family_id TEXT REFERENCES family (id) DEFERRABLE INITIALLY DEFERRED,
  role TEXT NOT NULL DEFAULT 'principal' CHECK (role IN ('principal', 'witness', 'godparent', 'officiator', 'clergy', 'informant', 'parent', 'father', 'mother', 'child', 'spouse', 'husband', 'wife', 'friend', 'neighbor', 'multiple', 'other')),
  is_preferred INTEGER NOT NULL DEFAULT 1 CHECK (is_preferred IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK ((person_id IS NULL) <> (family_id IS NULL))
) STRICT;

CREATE TABLE family (
  id TEXT PRIMARY KEY NOT NULL,
  partner1_id TEXT REFERENCES person (id) DEFERRABLE INITIALLY DEFERRED,
  partner2_id TEXT REFERENCES person (id) DEFERRABLE INITIALLY DEFERRED,
  relationship_type TEXT NOT NULL DEFAULT 'unknown' CHECK (relationship_type IN ('married', 'civil_union', 'partners', 'unknown')),
  partner1_order INTEGER NOT NULL DEFAULT 0,
  partner2_order INTEGER NOT NULL DEFAULT 0,
  privacy TEXT NOT NULL DEFAULT 'public' CHECK (privacy IN ('public', 'private', 'confidential', 'locked')),
  external_id TEXT,
  import_batch_id TEXT REFERENCES import_batch (id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (partner1_id IS NULL OR partner2_id IS NULL OR partner1_id <> partner2_id)
) STRICT;

CREATE TABLE family_child (
  id TEXT PRIMARY KEY NOT NULL,
  family_id TEXT NOT NULL REFERENCES family (id) DEFERRABLE INITIALLY DEFERRED,
  child_id TEXT NOT NULL REFERENCES person (id) DEFERRABLE INITIALLY DEFERRED,
  partner1_rel TEXT NOT NULL DEFAULT 'biological' CHECK (partner1_rel IN ('biological', 'adopted', 'step', 'foster', 'related', 'guardian', 'private', 'unknown')),
  partner2_rel TEXT NOT NULL DEFAULT 'biological' CHECK (partner2_rel IN ('biological', 'adopted', 'step', 'foster', 'related', 'guardian', 'private', 'unknown')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  child_order INTEGER NOT NULL DEFAULT 0,
  is_preferred INTEGER NOT NULL DEFAULT 0 CHECK (is_preferred IN (0, 1)),
  UNIQUE (family_id, child_id)
) STRICT;

CREATE TABLE import_batch (
  id TEXT PRIMARY KEY NOT NULL,
  file_name TEXT,
  file_sha256 TEXT,
  format TEXT,
  source_software TEXT,
  source_version TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  counts_json TEXT NOT NULL DEFAULT '{}',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;

CREATE TABLE media (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo', 'document', 'audio', 'video', 'other')),
  mime TEXT,
  local_path TEXT CHECK (local_path IS NULL OR (local_path <> '' AND substr(local_path, 1, 1) <> '/' AND instr(local_path, char(92)) = 0 AND local_path NOT GLOB '[A-Za-z]:*' AND local_path <> '..' AND local_path NOT LIKE '../%' AND local_path NOT LIKE '%/../%' AND local_path NOT LIKE '%/..')),
  remote_url TEXT,
  ancestry_oid TEXT,
  title TEXT,
  date_text TEXT,
  description TEXT,
  sha256 TEXT,
  width INTEGER,
  height INTEGER,
  byte_size INTEGER,
  external_id TEXT,
  import_batch_id TEXT REFERENCES import_batch (id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE media_link (
  id TEXT PRIMARY KEY NOT NULL,
  media_id TEXT NOT NULL REFERENCES media (id) DEFERRABLE INITIALLY DEFERRED,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('person', 'event', 'family', 'source', 'citation', 'place')),
  owner_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  crop_json TEXT,
  UNIQUE (media_id, owner_type, owner_id)
) STRICT;

CREATE TABLE meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE note (
  id TEXT PRIMARY KEY NOT NULL,
  text TEXT NOT NULL,
  external_id TEXT,
  import_batch_id TEXT REFERENCES import_batch (id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE note_link (
  id TEXT PRIMARY KEY NOT NULL,
  note_id TEXT NOT NULL REFERENCES note (id) DEFERRABLE INITIALLY DEFERRED,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('person', 'person_name', 'event', 'family', 'family_child', 'source', 'citation', 'media', 'place', 'repository')),
  owner_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (note_id, owner_type, owner_id)
) STRICT;

CREATE TABLE person (
  id TEXT PRIMARY KEY NOT NULL,
  sex TEXT NOT NULL DEFAULT 'U' CHECK (sex IN ('M', 'F', 'X', 'U')),
  living TEXT NOT NULL DEFAULT 'unknown' CHECK (living IN ('living', 'dead', 'inferred_living', 'inferred_dead', 'unknown')),
  privacy TEXT NOT NULL DEFAULT 'public' CHECK (privacy IN ('public', 'private', 'confidential', 'locked')),
  primary_media_id TEXT REFERENCES media (id) DEFERRABLE INITIALLY DEFERRED,
  external_id TEXT,
  import_batch_id TEXT REFERENCES import_batch (id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE person_name (
  id TEXT PRIMARY KEY NOT NULL,
  person_id TEXT NOT NULL REFERENCES person (id) DEFERRABLE INITIALLY DEFERRED,
  type TEXT NOT NULL DEFAULT 'birth' CHECK (type IN ('birth', 'married', 'maiden', 'aka', 'immigrant', 'professional', 'religious', 'other')),
  given TEXT,
  surname TEXT,
  surname_prefix TEXT,
  prefix TEXT,
  suffix TEXT,
  nickname TEXT,
  full_text TEXT,
  surname_key TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE VIRTUAL TABLE person_search USING fts5 (
  names,
  phonetic,
  places,
  years,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

CREATE TABLE place (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  parent_id TEXT REFERENCES place (id) DEFERRABLE INITIALLY DEFERRED,
  type TEXT,
  latitude REAL CHECK (latitude BETWEEN -90 AND 90),
  longitude REAL CHECK (longitude BETWEEN -180 AND 180),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE raw_record (
  id TEXT PRIMARY KEY NOT NULL,
  import_batch_id TEXT NOT NULL REFERENCES import_batch (id) DEFERRABLE INITIALLY DEFERRED,
  seq INTEGER NOT NULL,
  owner_type TEXT,
  owner_id TEXT,
  gedcom_tag TEXT NOT NULL,
  xref TEXT,
  raw_text TEXT NOT NULL
) STRICT;

CREATE TABLE repository (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  url TEXT,
  email TEXT,
  phone TEXT,
  external_id TEXT,
  import_batch_id TEXT REFERENCES import_batch (id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE search_doc (
  doc_id INTEGER PRIMARY KEY,
  person_id TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE source (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  publication TEXT,
  abbreviation TEXT,
  text TEXT,
  repository_id TEXT REFERENCES repository (id) DEFERRABLE INITIALLY DEFERRED,
  call_number TEXT,
  apid TEXT,
  external_id TEXT,
  import_batch_id TEXT REFERENCES import_batch (id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE tag (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  color TEXT,
  external_id TEXT,
  import_batch_id TEXT REFERENCES import_batch (id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (category, name)
) STRICT;

CREATE TABLE tag_link (
  id TEXT PRIMARY KEY NOT NULL,
  tag_id TEXT NOT NULL REFERENCES tag (id) DEFERRABLE INITIALLY DEFERRED,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('person', 'family', 'event', 'media', 'source')),
  owner_id TEXT NOT NULL,
  UNIQUE (tag_id, owner_type, owner_id)
) STRICT;

CREATE TABLE unmapped_line (
  id TEXT PRIMARY KEY NOT NULL,
  import_batch_id TEXT NOT NULL REFERENCES import_batch (id) DEFERRABLE INITIALLY DEFERRED,
  owner_type TEXT,
  owner_id TEXT,
  path TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  line TEXT NOT NULL
) STRICT;

CREATE INDEX change_batch_state_idx ON change_batch (state, id);

CREATE INDEX change_log_batch_idx ON change_log (batch_id, seq);

CREATE INDEX change_log_entity_idx ON change_log (entity, entity_id);

CREATE INDEX citation_link_owner_idx ON citation_link (owner_type, owner_id);

CREATE INDEX citation_source_idx ON citation (source_id);

CREATE INDEX event_date_sort_idx ON event (date_sort);

CREATE INDEX event_place_idx ON event (place_id);

CREATE INDEX event_role_event_idx ON event_role (event_id);

CREATE INDEX event_role_family_idx ON event_role (family_id);

CREATE INDEX event_role_person_idx ON event_role (person_id, role);

CREATE INDEX family_child_child_idx ON family_child (child_id, child_order);

CREATE UNIQUE INDEX family_child_preferred_uq ON family_child (child_id) WHERE is_preferred = 1;

CREATE INDEX family_import_idx ON family (import_batch_id, external_id);

CREATE INDEX family_partner1_idx ON family (partner1_id);

CREATE INDEX family_partner2_idx ON family (partner2_id);

CREATE INDEX media_link_owner_idx ON media_link (owner_type, owner_id);

CREATE INDEX media_sha256_idx ON media (sha256);

CREATE INDEX note_link_owner_idx ON note_link (owner_type, owner_id);

CREATE INDEX person_import_idx ON person (import_batch_id, external_id);

CREATE INDEX person_name_given_idx ON person_name (given COLLATE NOCASE);

CREATE INDEX person_name_person_idx ON person_name (person_id, sort_order);

CREATE UNIQUE INDEX person_name_primary_uq ON person_name (person_id) WHERE is_primary = 1;

CREATE INDEX person_name_surname_idx ON person_name (surname COLLATE NOCASE, given COLLATE NOCASE);

CREATE INDEX person_primary_media_idx ON person (primary_media_id);

CREATE INDEX place_full_name_idx ON place (full_name COLLATE NOCASE);

CREATE INDEX place_parent_idx ON place (parent_id);

CREATE INDEX raw_record_batch_idx ON raw_record (import_batch_id, seq);

CREATE INDEX raw_record_owner_idx ON raw_record (owner_type, owner_id);

CREATE INDEX source_repository_idx ON source (repository_id);

CREATE INDEX tag_link_owner_idx ON tag_link (owner_type, owner_id);

CREATE INDEX unmapped_line_batch_idx ON unmapped_line (import_batch_id, line_no);

CREATE INDEX unmapped_line_owner_idx ON unmapped_line (owner_type, owner_id);
