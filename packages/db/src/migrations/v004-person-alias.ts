// Schema version 4. Frozen once released (see history/schema-v4.sql).
//
// person_alias: one row per person merged into another (#57, #70). The merge
// deletes the merged person, and Ancestry renumbers xrefs between exports, so
// re-import (#72) needs an explicit record of what the kept person absorbed:
// the merged person's id, GEDCOM xref, import batch and Ancestry record ids.
// merged_person_id has no foreign key, because that person no longer exists.
export default /* sql */ `
CREATE TABLE person_alias (
  id TEXT PRIMARY KEY NOT NULL,
  person_id TEXT NOT NULL REFERENCES person (id) DEFERRABLE INITIALLY DEFERRED,
  merged_person_id TEXT NOT NULL,
  merged_xref TEXT,
  import_batch_id TEXT REFERENCES import_batch (id) DEFERRABLE INITIALLY DEFERRED,
  apids_json TEXT NOT NULL DEFAULT '[]',
  merged_at TEXT NOT NULL
) STRICT;
CREATE INDEX person_alias_person_idx ON person_alias (person_id);
CREATE INDEX person_alias_xref_idx ON person_alias (import_batch_id, merged_xref);
CREATE INDEX person_alias_merged_idx ON person_alias (merged_person_id);
`;
