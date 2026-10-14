import { getPersonSummaries, type PersonSummary } from './queries';
import type { TreeStore } from './store';

/*
 * Full-text search over people. `search_doc` maps each person to an FTS rowid;
 * `person_search` holds one document per person with every name variant, the
 * caller-supplied surname phonetic keys, the places and the years of events
 * where they are the principal. Both are derived data: rebuilt from scratch
 * after bulk imports and refreshed per person by the unit of work.
 */

const IDS = 'SELECT value FROM json_each(?)';

const DOC_COLUMNS = `
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

/** Records which people's search documents a row change affects. */
export function markSearchDirty(
  store: TreeStore,
  dirty: Set<string>,
  table: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): void {
  const row = (after ?? before) as Record<string, unknown>;
  const add = (id: unknown) => {
    if (typeof id === 'string') dirty.add(id);
  };
  switch (table) {
    case 'person':
      add(row.id);
      break;
    case 'person_name':
    case 'event_role':
      add(before?.person_id);
      add(after?.person_id);
      break;
    case 'event':
      for (const r of store
        .stmt('SELECT person_id FROM event_role WHERE event_id = ? AND person_id IS NOT NULL')
        .all(row.id) as { person_id: string }[])
        dirty.add(r.person_id);
      break;
    case 'place':
      for (const r of store
        .stmt(
          `SELECT DISTINCT r.person_id FROM event e JOIN event_role r ON r.event_id = e.id
           WHERE e.place_id = ? AND r.person_id IS NOT NULL`,
        )
        .all(row.id) as { person_id: string }[])
        dirty.add(r.person_id);
      break;
  }
}

/** Rewrites the search documents of the given people (removing those that no longer exist). */
export function refreshSearch(store: TreeStore, personIds: string[]): void {
  if (personIds.length === 0) return;
  const ids = JSON.stringify(personIds);
  store
    .stmt(
      `DELETE FROM person_search WHERE rowid IN (SELECT doc_id FROM search_doc WHERE person_id IN (${IDS}))`,
    )
    .run(ids);
  store.stmt(`DELETE FROM search_doc WHERE person_id IN (${IDS})`).run(ids);
  store
    .stmt(`INSERT INTO search_doc (person_id) SELECT id FROM person WHERE id IN (${IDS})`)
    .run(ids);
  store
    .stmt(
      `INSERT INTO person_search (rowid, names, phonetic, places, years)
       SELECT d.doc_id, ${DOC_COLUMNS} FROM search_doc d WHERE d.person_id IN (${IDS})`,
    )
    .run(ids);
}

/** Drops and rebuilds the whole search index. */
export function rebuildSearchIndex(store: TreeStore): void {
  store.db.transaction(() => {
    store.db.exec('DELETE FROM person_search; DELETE FROM search_doc;');
    store.db.exec('INSERT INTO search_doc (person_id) SELECT id FROM person ORDER BY id');
    store.db.exec(
      `INSERT INTO person_search (rowid, names, phonetic, places, years) SELECT d.doc_id, ${DOC_COLUMNS} FROM search_doc d`,
    );
  })();
}

export interface SearchOptions {
  limit?: number;
  /**
   * Phonetic keys (e.g. Double Metaphone from packages/core) for the query's
   * surname; people whose `surname_key` matches any of them are also returned.
   */
  phoneticKeys?: string[];
}

export interface SearchResult {
  person: PersonSummary;
  /** Higher is better. */
  score: number;
}

const quote = (token: string) => `"${token.replaceAll('"', '""')}"`;

/** Ranked person search: every query word must prefix-match a name, place or year. */
export function searchPeople(
  store: TreeStore,
  query: string,
  { limit = 20, phoneticKeys = [] }: SearchOptions = {},
): SearchResult[] {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return [];
  let match = `{names places years} : (${tokens.map((t) => `${quote(t)}*`).join(' AND ')})`;
  const keys = phoneticKeys.filter((k) => /[\p{L}\p{N}]/u.test(k));
  if (keys.length > 0) match = `(${match}) OR phonetic : (${keys.map(quote).join(' OR ')})`;
  const hits = store
    .stmt(
      `SELECT d.person_id AS id, -bm25(person_search, 10.0, 5.0, 1.0, 1.0) AS score
       FROM person_search JOIN search_doc d ON d.doc_id = person_search.rowid
       WHERE person_search MATCH ? ORDER BY score DESC, d.person_id LIMIT ?`,
    )
    .all(match, limit) as { id: string; score: number }[];
  const summaries = new Map(
    getPersonSummaries(
      store,
      hits.map((h) => h.id),
    ).map((s) => [s.id, s]),
  );
  return hits.map((h) => ({ person: summaries.get(h.id) as PersonSummary, score: h.score }));
}
