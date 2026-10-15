import { parseDate } from '@open-ancestry/core';
import { foldForIndex } from '@open-ancestry/core';
import { rebuildSearchIndex, refreshSearch } from './search';
import { SEARCH_DOC_VERSION } from './search-docs';
import type { TreeStore } from './store';

/*
 * Derived columns: values computed from other columns by packages/core, such
 * as event.date_sort from date_text. When core's computation changes (a date
 * parser fix, #142), stored rows keep the old values. Each step records a
 * fingerprint of the computation in derived_state; when a tree is opened with
 * a different fingerprint, or a JSON backup is imported, the step recomputes
 * its rows. Recomputing is idempotent and writes no change_log rows: derived
 * values are not user edits, and undo re-derives them (see undo.ts).
 */

/** Calendars whose sort keys go through calendar conversion in packages/core. */
export const CONVERTED_CALENDARS: readonly string[] = ['julian', 'hebrew', 'french_r'];

/** Sample dates whose sort keys change whenever the conversion does. */
const DATE_PROBES = [
  '@#DHEBREW@ 1 TSH 5780',
  '@#DHEBREW@ ADR 5784',
  '@#DHEBREW@ 5700',
  '@#DHEBREW@ BET 1 NSN 5700 AND 29 ELL 5701',
  '@#DFRENCH R@ 1 VEND 1',
  '@#DFRENCH R@ 5 COMP 11',
  '@#DFRENCH R@ BET 1 VEND 3 AND 5 FLOR 7',
  '@#DJULIAN@ 1 JAN 1700',
  '@#DJULIAN@ 11 FEB 1731/32',
  'ABT @#DJULIAN@ 1066',
];

/** event.date_sort and date_sort_end for a date as written, as the importer computes them. */
export function deriveDateSort(dateText: string): {
  date_sort: number | null;
  date_sort_end: number | null;
} {
  const parsed = parseDate(dateText);
  return parsed.valid
    ? { date_sort: parsed.sortKey, date_sort_end: parsed.sortKeyEnd ?? null }
    : { date_sort: null, date_sort_end: null };
}

/** Whether an event row's sort keys are derived through calendar conversion. */
export function hasConvertedDate(row: Record<string, unknown>): row is Record<string, unknown> & {
  date_text: string;
} {
  return (
    typeof row.date_text === 'string' &&
    typeof row.calendar === 'string' &&
    CONVERTED_CALENDARS.includes(row.calendar)
  );
}

interface DerivedStep {
  name: string;
  /** Why it reran, for the log line. */
  reason: string;
  fingerprint(): string;
  /** Recomputes stale rows; returns how many changed. */
  recompute(store: TreeStore): number;
}

const eventDateSort: DerivedStep = {
  name: 'event_date_sort',
  reason: 'date parser changed',
  fingerprint: () =>
    JSON.stringify(
      DATE_PROBES.map((text) => {
        const { date_sort, date_sort_end } = deriveDateSort(text);
        return [date_sort, date_sort_end];
      }),
    ),
  recompute(store) {
    const rows = store.db
      .prepare(
        // Matches the partial index event_converted_calendar_idx exactly.
        `SELECT id, date_text, calendar, date_sort, date_sort_end FROM event
         WHERE calendar IN (${CONVERTED_CALENDARS.map((c) => `'${c}'`).join(', ')})
           AND date_text IS NOT NULL`,
      )
      .all() as {
      id: string;
      date_text: string;
      date_sort: number | null;
      date_sort_end: number | null;
    }[];
    const update = store.db.prepare(
      'UPDATE event SET date_sort = ?, date_sort_end = ? WHERE id = ?',
    );
    const changed: string[] = [];
    for (const row of rows) {
      const next = deriveDateSort(row.date_text);
      if (next.date_sort === row.date_sort && next.date_sort_end === row.date_sort_end) continue;
      update.run(next.date_sort, next.date_sort_end, row.id);
      changed.push(row.id);
    }
    if (changed.length > 0) {
      // Search documents index event years, which come from date_sort.
      const people = store.db
        .prepare(
          `SELECT DISTINCT person_id FROM event_role
           WHERE event_id IN (SELECT value FROM json_each(?)) AND person_id IS NOT NULL`,
        )
        .all(JSON.stringify(changed)) as { person_id: string }[];
      refreshSearch(
        store,
        people.map((p) => p.person_id),
      );
    }
    return changed.length;
  },
};

/** Tables that point at a row by owner_type + owner_id. */
const OWNER_TABLES = [
  'citation_link',
  'media_link',
  'note_link',
  'tag_link',
  'raw_record',
  'unmapped_line',
] as const;

/**
 * Notes, media and citations that earlier person and family deletes left with
 * nothing linking to them (#226). Deletes now take them along; this removes
 * the ones already there, once per tree. Imported NOTE and OBJE records
 * (with an xref) may stand alone and are kept, as are sources, which are
 * shared reference data. Not change-logged: the user already deleted them.
 */
const orphanCleanup: DerivedStep = {
  name: 'orphan_cleanup',
  reason: 'records orphaned by earlier deletes',
  fingerprint: () => '1',
  recompute(store) {
    const queries: [table: string, sql: string][] = [
      [
        'citation',
        'SELECT id FROM citation c WHERE NOT EXISTS (SELECT 1 FROM citation_link l WHERE l.citation_id = c.id)',
      ],
      [
        'note',
        `SELECT id FROM note n WHERE NOT EXISTS (SELECT 1 FROM note_link l WHERE l.note_id = n.id)
           AND ${wasLinked('note')}`,
      ],
      [
        'media',
        `SELECT id FROM media m WHERE NOT EXISTS (SELECT 1 FROM media_link l WHERE l.media_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM person p WHERE p.primary_media_id = m.id)
           AND ${wasLinked('media')}`,
      ],
    ];
    let removed = 0;
    // A deleted citation can orphan its notes and media in turn.
    for (let more = true; more;) {
      more = false;
      for (const [table, sql] of queries) {
        for (const id of store.db.prepare(sql).pluck().all() as string[]) {
          for (const owned of OWNER_TABLES) {
            store.db
              .prepare(`DELETE FROM ${owned} WHERE owner_type = ? AND owner_id = ?`)
              .run(table, id);
          }
          store.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
          removed++;
          more = true;
        }
      }
    }
    // Import reports stored before they dropped quoted text (example lines and warning
    // messages name files and people that may since have been deleted).
    const batches = store.db
      .prepare('SELECT id, counts_json, warnings_json FROM import_batch')
      .all() as { id: string; counts_json: string; warnings_json: string }[];
    for (const batch of batches) {
      const scrubbed = scrubReport(batch.counts_json, batch.warnings_json);
      if (!scrubbed) continue;
      store.db
        .prepare('UPDATE import_batch SET counts_json = ?, warnings_json = ? WHERE id = ?')
        .run(scrubbed.counts, scrubbed.warnings, batch.id);
      removed++;
    }
    return removed;
  },
};

/**
 * SQL true for a note (`n`) or media row (`m`) that was someone's and is now
 * no one's: an inline one, or an imported record whose link a delete removed.
 * A pointer in any imported record's text counts as a use (an ASSO NOTE or a
 * custom subtree is kept as text, not as a link), so such a record is kept.
 */
function wasLinked(table: 'note' | 'media'): string {
  const row = table === 'note' ? 'n' : 'm';
  return `(${row}.external_id IS NULL
    OR (EXISTS (SELECT 1 FROM change_log c WHERE c.entity = '${table}_link' AND c.op = 'delete'
                  AND json_extract(c.before_json, '$.${table}_id') = ${row}.id)
        AND NOT EXISTS (SELECT 1 FROM raw_record r WHERE r.xref IS NOT ${row}.external_id
                          AND instr(r.raw_text, ' ' || ${row}.external_id) > 0)))`;
}

/** An import report without quoted lines, or null when it has none. */
function scrubReport(
  countsJson: string,
  warningsJson: string,
): { counts: string; warnings: string } | null {
  try {
    const counts = JSON.parse(countsJson) as { unmapped?: Record<string, unknown>[] };
    const warnings = JSON.parse(warningsJson) as Record<string, unknown>[];
    const quoted =
      counts.unmapped?.some((u) => 'example' in u) ||
      (Array.isArray(warnings) && warnings.some((w) => 'message' in w));
    if (!quoted) return null;
    if (counts.unmapped) {
      counts.unmapped = counts.unmapped.map(({ path, tag, count }) => ({ path, tag, count }));
    }
    return {
      counts: JSON.stringify(counts),
      warnings: JSON.stringify(
        Array.isArray(warnings) ? warnings.map(({ code, line }) => ({ code, line })) : [],
      ),
    };
  } catch {
    return null;
  }
}

/** Spellings the search fold changes, so its fingerprint moves with it. */
const FOLD_PROBES = ['Yılmaz', 'Straße', 'כֹּהֵן', 'عَلِيّ', "O'Brien", 'Ro\u200bwan'];

/** The search index: rebuilt when the spelling fold or what is indexed changes (#199). */
const searchIndex: DerivedStep = {
  name: 'search_index',
  reason: 'search fold changed',
  fingerprint: () => JSON.stringify([SEARCH_DOC_VERSION, FOLD_PROBES.map(foldForIndex)]),
  recompute(store) {
    rebuildSearchIndex(store);
    return store.db.prepare('SELECT COUNT(*) FROM search_doc').pluck().get() as number;
  },
};

export const DERIVED_STEPS: readonly DerivedStep[] = [eventDateSort, orphanCleanup, searchIndex];

const storedFingerprint = (store: TreeStore, name: string) =>
  (
    store.db.prepare('SELECT fingerprint FROM derived_state WHERE name = ?').get(name) as
      { fingerprint: string } | undefined
  )?.fingerprint;

const saveFingerprint = (store: TreeStore, name: string, fingerprint: string) =>
  store.db
    .prepare(
      'INSERT INTO derived_state (name, fingerprint) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET fingerprint = excluded.fingerprint',
    )
    .run(name, fingerprint);

/** Whether the search index was built with another fold or document shape. */
export function searchIndexStale(store: TreeStore): boolean {
  return storedFingerprint(store, searchIndex.name) !== searchIndex.fingerprint();
}

/**
 * Rebuilds a stale search index a chunk of people at a time, in id order,
 * yielding how many are done after each chunk (each its own transaction), so
 * a server can run it between requests. Old documents answer searches until
 * their chunk is replaced. The fingerprint is saved after the last chunk.
 */
export function* rebuildSearchIndexInChunks(store: TreeStore, size = 2000): Generator<number> {
  const ids = store.db.prepare('SELECT id FROM person ORDER BY id').pluck().all() as string[];
  const fingerprint = searchIndex.fingerprint();
  for (let start = 0; start < ids.length; start += size) {
    store.db.transaction(() => refreshSearch(store, ids.slice(start, start + size)))();
    yield Math.min(start + size, ids.length);
  }
  saveFingerprint(store, searchIndex.name, fingerprint);
  if (ids.length > 0) {
    store.log(`Recomputed ${searchIndex.name} for ${ids.length} rows (${searchIndex.reason})`);
  }
}

export interface RefreshOptions {
  /** Recompute even if the fingerprint matches (JSON import does). */
  force?: boolean;
  /**
   * Leave a stale search index for `rebuildSearchIndexInChunks` (the server
   * does, so opening a big tree is not held up by a full rebuild).
   */
  deferSearch?: boolean;
  /** Why, for the log line. */
  reason?: string;
}

/**
 * Recomputes derived columns whose computation changed since they were
 * stored. Runs when a tree opens and after a JSON import. Returns the number
 * of rows changed per step that ran.
 */
export function refreshDerivedColumns(
  store: TreeStore,
  { force = false, reason, deferSearch = false }: RefreshOptions = {},
): Record<string, number> {
  const results: Record<string, number> = {};
  store.db.transaction(() => {
    for (const step of DERIVED_STEPS) {
      if (deferSearch && step === searchIndex) continue;
      const fingerprint = step.fingerprint();
      if (!force && storedFingerprint(store, step.name) === fingerprint) continue;
      const changed = step.recompute(store);
      saveFingerprint(store, step.name, fingerprint);
      results[step.name] = changed;
      const why = reason ?? (force ? 'refresh requested' : step.reason);
      if (changed > 0) store.log(`Recomputed ${step.name} for ${changed} rows (${why})`);
    }
  })();
  return results;
}
