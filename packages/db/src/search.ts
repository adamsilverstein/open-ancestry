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
   * Phonetic keys (e.g. `phoneticKeys` from packages/core) for a query word.
   * A word whose keys match a person's `surname_key` counts as matched, in the
   * lowest tier. An array applies to the last word only.
   */
  phoneticKeys?: string[] | ((word: string) => string[]);
}

export type SearchMatch = 'exact' | 'prefix' | 'phonetic';

export interface SearchResult {
  person: PersonSummary;
  /** How the weakest word matched: exact words beat prefixes beat sounds-alike. */
  match: SearchMatch;
  /** Higher is better; every exact result outscores every prefix result, and so on. */
  score: number;
}

const quote = (token: string) => `"${token.replaceAll('"', '""')}"`;
const TIERS: readonly SearchMatch[] = ['exact', 'prefix', 'phonetic'];
/** Distinct query words searched; the rest are ignored. */
export const MAX_SEARCH_WORDS = 8;
/** A year in the query also matches events this many years either side (prefix tier and below). */
export const YEAR_SLACK = 2;

/** FTS5 expression for one query word in one tier, or null if the word cannot match in it. */
function wordMatch(word: string, tier: SearchMatch, keys: string[]): string {
  if (/^\d{4}$/.test(word)) {
    const year = Number(word);
    const years =
      tier === 'exact'
        ? [year]
        : Array.from({ length: 2 * YEAR_SLACK + 1 }, (_, i) => year - YEAR_SLACK + i);
    return `years : (${years.map((y) => quote(String(y))).join(' OR ')})`;
  }
  const text = `{names places years} : ${quote(word)}${tier === 'exact' ? '' : '*'}`;
  return tier === 'phonetic' && keys.length > 0
    ? `(${text} OR phonetic : (${keys.map(quote).join(' OR ')}))`
    : `(${text})`;
}

/**
 * Ranked person search. Every query word must match a name (any variant), a
 * place or an event year; FTS5 syntax in the query is ignored. Results come
 * in tiers: all words exact, then prefixes (years within two), then with
 * surnames matched by sound. Within a tier, BM25 ranks names 10, phonetic
 * keys 5, places and years 1.
 */
export function searchPeople(
  store: TreeStore,
  query: string,
  { limit = 20, phoneticKeys = [] }: SearchOptions = {},
): SearchResult[] {
  // NFC so decomposed input (pasted from PDFs, macOS) tokenizes like typed text;
  // distinct and capped so a long repetitive query cannot stall the server.
  const words = [
    ...new Set((query.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.toLowerCase())),
  ].slice(0, MAX_SEARCH_WORDS);
  if (words.length === 0 || limit < 1) return [];
  const keysFor = (word: string, index: number): string[] => {
    const keys =
      typeof phoneticKeys === 'function'
        ? /\p{L}{2}/u.test(word)
          ? phoneticKeys(word)
          : []
        : index === words.length - 1
          ? phoneticKeys
          : [];
    return keys.filter((k) => /[\p{L}\p{N}]/u.test(k));
  };
  const keys = words.map(keysFor);
  const hasPhonetic = keys.some((k) => k.length > 0);

  const seen = new Set<string>();
  const hits: { id: string; match: SearchMatch; score: number }[] = [];
  const statement = store.stmt(
    `SELECT d.person_id AS id, -bm25(person_search, 10.0, 5.0, 1.0, 1.0) AS score
     FROM person_search JOIN search_doc d ON d.doc_id = person_search.rowid
     WHERE person_search MATCH ? ORDER BY score DESC, d.person_id LIMIT ?`,
  );
  TIERS.forEach((tier, rank) => {
    if (hits.length >= limit || (tier === 'phonetic' && !hasPhonetic)) return;
    const match = words.map((w, i) => wordMatch(w, tier, keys[i]!)).join(' AND ');
    // Ask for enough rows to fill the limit after skipping earlier tiers' hits.
    for (const row of statement.all(match, limit + seen.size) as { id: string; score: number }[]) {
      if (hits.length >= limit) break;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      // BM25 scores are small positive numbers; the tier offset keeps tiers apart.
      hits.push({ id: row.id, match: tier, score: (TIERS.length - rank) * 1e6 + row.score });
    }
  });

  const summaries = new Map(
    getPersonSummaries(
      store,
      hits.map((h) => h.id),
    ).map((s) => [s.id, s]),
  );
  return hits.map((h) => ({
    person: summaries.get(h.id) as PersonSummary,
    match: h.match,
    score: h.score,
  }));
}
