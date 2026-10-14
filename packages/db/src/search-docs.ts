import type { Database } from 'better-sqlite3';

/**
 * Invisible format characters the tokenizer would split a word at, the same
 * ones the query drops (core's \p{Cf} strip covers them): zero-width space,
 * non-joiner and joiner, direction marks, word joiner, BOM, soft hyphen,
 * embeddings, overrides and isolates. So "Ro\u200bwan" is indexed as "Rowan" (#190).
 */
const INVISIBLE = [
  0xad, 0x61c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
];

const visible = (expr: string) =>
  INVISIBLE.reduce((sql, code) => `replace(${sql}, char(${code}), '')`, expr);

/** The search document columns (names, phonetic, places, years) for `search_doc d`. */
export const DOC_COLUMNS = `
  (SELECT ${visible(
    "group_concat(concat_ws(' ', n.prefix, n.given, n.nickname, n.surname_prefix, n.surname, n.suffix), ' ' ORDER BY n.sort_order, n.id)",
  )}
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

/** Rebuilds every search document. Callers own the transaction (migrations run inside one). */
export function rebuildSearchDocs(db: Database): void {
  db.exec('DELETE FROM person_search; DELETE FROM search_doc;');
  db.exec('INSERT INTO search_doc (person_id) SELECT id FROM person ORDER BY id');
  db.exec(
    `INSERT INTO person_search (rowid, names, phonetic, places, years) SELECT d.doc_id, ${DOC_COLUMNS} FROM search_doc d`,
  );
}
