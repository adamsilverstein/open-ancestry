import { foldForSearch } from '@open-ancestry/core';
import { getPersonSummaries, type PersonSummary } from './queries';
import { DOC_COLUMNS, rebuildSearchDocs } from './search-docs';
import { rebuildSortKeys, refreshSortKeys } from './sort-keys';
import type { TreeStore } from './store';

/*
 * Full-text search over people. `search_doc` maps each person to an FTS rowid;
 * `person_search` holds one document per person with every name variant, the
 * caller-supplied surname phonetic keys, the places and the years of events
 * where they are the principal. Both are derived data: rebuilt from scratch
 * after bulk imports and refreshed per person by the unit of work.
 */

const IDS = 'SELECT value FROM json_each(?)';

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
  // The people list's sort keys come from the same rows (names, vital events).
  refreshSortKeys(store, personIds);
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
    rebuildSearchDocs(store.db);
    rebuildSortKeys(store.db);
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
  /** Matches in a tier above which near-ties go by id, not name (default TIEBREAK_MAX_MATCHES). */
  tiebreakMaxMatches?: number;
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
/** Characters of the query used; the rest is ignored. */
export const MAX_SEARCH_LENGTH = 100;
/** Shortest word matched as a prefix. */
export const MIN_PREFIX_LENGTH = 2;
/** Distinct query words searched; the rest are ignored. */
export const MAX_SEARCH_WORDS = 8;
/** A year in the query also matches events this many years either side (prefix tier and below). */
export const YEAR_SLACK = 2;
/** Most rows read by score before near-ties are put in name order; past it, ties go by id. */
export const TIEBREAK_CAP = 2000;
/**
 * Above this many matches in a tier (a broad prefix such as "19" or "we") the
 * name tiebreak is skipped: scoring and keeping every match costs more than the
 * order is worth, so those go by score, then id, as before #305.
 */
export const TIEBREAK_MAX_MATCHES = 20_000;

/** Han, kana and Hangul: scripts written without spaces between the parts of a name. */
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

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
  // One-character prefixes are not in the FTS prefix index (2 and 3) and match
  // most of a big tree, so a lone letter only matches exactly (an initial). A
  // CJK name is one token with no spaces, so one character may start it (小 for 小明).
  const prefix = tier !== 'exact' && ([...word].length >= MIN_PREFIX_LENGTH || CJK.test(word));
  const text = `{names places years} : ${quote(word)}${prefix ? '*' : ''}`;
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
/** Query words and their phonetic keys, or null when nothing can match. */
function parseQuery(
  query: string,
  phoneticKeys: SearchOptions['phoneticKeys'] = [],
  asTypedToo = false,
) {
  // Folded like the index (NFC, ı, ß, vowel marks, apostrophes); distinct and
  // capped so a long repetitive query cannot stall the server.
  const toWords = (text: string) =>
    [...new Set((text.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.toLowerCase()))].slice(
      0,
      MAX_SEARCH_WORDS,
    );
  const typed = query.slice(0, MAX_SEARCH_LENGTH);
  const words = toWords(foldForSearch(typed));
  // While a deferred rebuild runs, some documents predate the fold and hold names
  // only as typed: also match the query unfolded, as searches did before (#199).
  const asTyped = asTypedToo ? toWords(typed.normalize('NFC')) : [];
  const alsoAsTyped = asTyped.length > 0 && asTyped.join(' ') !== words.join(' ');
  if (words.length === 0) return null;
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
  const match = (tier: SearchMatch) => {
    const folded = words.map((w, i) => wordMatch(w, tier, keys[i]!)).join(' AND ');
    return alsoAsTyped
      ? `(${folded}) OR (${asTyped.map((w) => wordMatch(w, tier, [])).join(' AND ')})`
      : folded;
  };
  return { match, hasPhonetic };
}

/**
 * How many people match `query` at all: the loosest tier, which every
 * stricter one is inside. The palette says "Show all N" with it.
 */
export function countPeople(
  store: TreeStore,
  query: string,
  { phoneticKeys = [] }: Omit<SearchOptions, 'limit'> = {},
): number {
  // Same matching as searchPeople, folded and (mid-rebuild) as typed, so the total agrees.
  const parsed = parseQuery(query, phoneticKeys, store.searchRebuildPending);
  if (!parsed) return 0;
  return store
    .stmt('SELECT count(*) FROM person_search WHERE person_search MATCH ?')
    .pluck()
    .get(parsed.match(parsed.hasPhonetic ? 'phonetic' : 'prefix')) as number;
}

export function searchPeople(
  store: TreeStore,
  query: string,
  { limit = 20, phoneticKeys = [], tiebreakMaxMatches = TIEBREAK_MAX_MATCHES }: SearchOptions = {},
): SearchResult[] {
  const parsed = parseQuery(query, phoneticKeys, store.searchRebuildPending);
  if (!parsed || limit < 1) return [];
  const { hasPhonetic } = parsed;

  const seen = new Set<string>();
  const hits: { id: string; match: SearchMatch; score: number }[] = [];
  // Scores within a tenth of each other are the same match to a reader (a longer
  // document scores a little lower), so those go by name: predictable, not by
  // when each person was added (#280). Score every match once (FTS alone), find
  // the rounded score of the last row wanted, and name-sort every row from that
  // bucket up, so a tie that straddles the cut is settled by name (#305). Past
  // TIEBREAK_CAP rows the bucket is cut in search-document order first.
  const statement = store.stmt(
    `WITH s AS MATERIALIZED (
       SELECT rowid AS doc, -bm25(person_search, 10.0, 5.0, 1.0, 1.0) AS score
       FROM person_search WHERE person_search MATCH @match
     ),
     cut AS (SELECT round(score, 1) AS bucket FROM s ORDER BY score DESC, doc LIMIT 1 OFFSET @last),
     b AS (
       SELECT doc, score FROM s
       WHERE round(score, 1) >= coalesce((SELECT bucket FROM cut), -1e300)
       ORDER BY score DESC, doc LIMIT @cap
     )
     SELECT d.person_id AS id, b.score FROM b
     JOIN search_doc d ON d.doc_id = b.doc
     LEFT JOIN person_sort ps ON ps.person_id = d.person_id
     ORDER BY round(b.score, 1) DESC, ps.surname COLLATE NOCASE, ps.given COLLATE NOCASE, d.person_id
     LIMIT @limit`,
  );
  const count = store
    .stmt('SELECT count(*) FROM person_search WHERE person_search MATCH ?')
    .pluck();
  const byScore = store.stmt(
    `SELECT d.person_id AS id, -bm25(person_search, 10.0, 5.0, 1.0, 1.0) AS score
     FROM person_search JOIN search_doc d ON d.doc_id = person_search.rowid
     WHERE person_search MATCH @match ORDER BY score DESC, d.person_id LIMIT @limit`,
  );
  TIERS.forEach((tier, rank) => {
    if (hits.length >= limit || (tier === 'phonetic' && !hasPhonetic)) return;
    const match = parsed.match(tier);
    // Ask for enough rows to fill the limit after skipping earlier tiers' hits.
    const wanted = limit + seen.size;
    const broad = (count.get(match) as number) > tiebreakMaxMatches;
    const rows = (
      broad
        ? byScore.all({ match, limit: wanted })
        : statement.all({ match, cap: TIEBREAK_CAP, last: wanted - 1, limit: wanted })
    ) as {
      id: string;
      score: number;
    }[];
    for (const row of rows) {
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
