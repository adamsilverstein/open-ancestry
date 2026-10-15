// Schema version 5. Frozen once released (see history/schema-v5.sql).
//
// person_sort: the people list's sort keys per person (primary surname and
// given name, earliest birth and death date) and its filters (sex, living), so the first page of an order
// on a 100k tree reads an index instead of joining every event and sorting
// the whole tree (#114). Each key has an ascending index and one whose id
// runs the other way, so a descending order scanned backwards still breaks
// ties by ascending id. Derived like search_doc: refreshed with the search
// documents, never exported or change-logged; filled here from the tables.
export default /* sql */ `
CREATE TABLE person_sort (
  person_id TEXT PRIMARY KEY NOT NULL,
  surname TEXT,
  given TEXT,
  birth_key INTEGER,
  death_key INTEGER,
  sex TEXT NOT NULL,
  living TEXT NOT NULL
) STRICT;
CREATE INDEX person_sort_surname_idx ON person_sort (surname COLLATE NOCASE, given COLLATE NOCASE, person_id);
CREATE INDEX person_sort_surname_desc_idx ON person_sort (surname COLLATE NOCASE, given COLLATE NOCASE, person_id DESC);
CREATE INDEX person_sort_given_idx ON person_sort (given COLLATE NOCASE, surname COLLATE NOCASE, person_id);
CREATE INDEX person_sort_given_desc_idx ON person_sort (given COLLATE NOCASE, surname COLLATE NOCASE, person_id DESC);
CREATE INDEX person_sort_birth_idx ON person_sort (birth_key, person_id);
CREATE INDEX person_sort_birth_desc_idx ON person_sort (birth_key, person_id DESC);
CREATE INDEX person_sort_death_idx ON person_sort (death_key, person_id);
CREATE INDEX person_sort_death_desc_idx ON person_sort (death_key, person_id DESC);
`;
