import type { Database } from 'better-sqlite3';

/** The search document columns (names, phonetic, places, years) for `search_doc d`. */
export const DOC_COLUMNS = `
  (SELECT group_concat(concat_ws(' ', n.prefix, n.given, n.nickname, n.surname_prefix, n.surname, n.suffix), ' ' ORDER BY n.sort_order, n.id)
     FROM person_name n WHERE n.person_id = d.person_id),
  (SELECT group_concat(n.surname_key, ' ' ORDER BY n.sort_order, n.id)
     FROM person_name n WHERE n.person_id = d.person_id),
  (SELECT group_concat(full_name, ' ; ' ORDER BY full_name) FROM (
     SELECT DISTINCT pl.full_name FROM event_role r
     JOIN event e ON e.id = r.event_id JOIN place pl ON pl.id = e.place_id
     WHERE r.person_id = d.person_id AND r.role = 'principal')),
  (SELECT group_concat(year, ' ' ORDER BY year) FROM (
     SELECT DISTINCT e.date_sort / 10000 AS year FROM event_role r JOIN event e ON e.id = r.event_id
     WHERE r.person_id = d.person_id AND r.role = 'principal' AND e.date_sort IS NOT NULL))`;

/*
 * The same documents as DOC_COLUMNS, built set-wise for a full rebuild: one
 * pass per source table grouped by person, instead of four correlated lookups
 * per person. About 15% less CPU on a 100k-person tree (#117); the documents
 * are byte-identical (search.test.ts compares them with per-person refreshes).
 */
const REBUILD_DOCS = `
  CREATE TEMP TABLE rebuild_names (person_id TEXT PRIMARY KEY, names, phonetic) WITHOUT ROWID;
  INSERT INTO temp.rebuild_names
    SELECT person_id,
      group_concat(concat_ws(' ', prefix, given, nickname, surname_prefix, surname, suffix), ' ' ORDER BY sort_order, id),
      group_concat(surname_key, ' ' ORDER BY sort_order, id)
    FROM person_name GROUP BY person_id;
  CREATE TEMP TABLE rebuild_places (person_id TEXT PRIMARY KEY, places) WITHOUT ROWID;
  INSERT INTO temp.rebuild_places
    SELECT person_id, group_concat(full_name, ' ; ' ORDER BY full_name) FROM (
      SELECT DISTINCT r.person_id, pl.full_name FROM event_role r
      JOIN event e ON e.id = r.event_id JOIN place pl ON pl.id = e.place_id
      WHERE r.role = 'principal' AND r.person_id IS NOT NULL)
    GROUP BY person_id;
  CREATE TEMP TABLE rebuild_years (person_id TEXT PRIMARY KEY, years) WITHOUT ROWID;
  INSERT INTO temp.rebuild_years
    SELECT person_id, group_concat(year, ' ' ORDER BY year) FROM (
      SELECT DISTINCT r.person_id, e.date_sort / 10000 AS year FROM event_role r
      JOIN event e ON e.id = r.event_id
      WHERE r.role = 'principal' AND r.person_id IS NOT NULL AND e.date_sort IS NOT NULL)
    GROUP BY person_id;
  INSERT INTO person_search (rowid, names, phonetic, places, years)
    SELECT d.doc_id, n.names, n.phonetic, p.places, y.years FROM search_doc d
    LEFT JOIN temp.rebuild_names n ON n.person_id = d.person_id
    LEFT JOIN temp.rebuild_places p ON p.person_id = d.person_id
    LEFT JOIN temp.rebuild_years y ON y.person_id = d.person_id;
  DROP TABLE temp.rebuild_names;
  DROP TABLE temp.rebuild_places;
  DROP TABLE temp.rebuild_years;`;

/** Rebuilds every search document. Callers own the transaction (migrations run inside one). */
export function rebuildSearchDocs(db: Database): void {
  db.exec('DELETE FROM person_search; DELETE FROM search_doc;');
  db.exec('INSERT INTO search_doc (person_id) SELECT id FROM person ORDER BY id');
  db.exec(REBUILD_DOCS);
}
