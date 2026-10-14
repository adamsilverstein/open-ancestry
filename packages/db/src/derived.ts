import { parseDate } from '@open-ancestry/core';
import { refreshSearch } from './search';
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
  fingerprint(): string;
  /** Recomputes stale rows; returns how many changed. */
  recompute(store: TreeStore): number;
}

const eventDateSort: DerivedStep = {
  name: 'event_date_sort',
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

export const DERIVED_STEPS: readonly DerivedStep[] = [eventDateSort];

export interface RefreshOptions {
  /** Recompute even if the fingerprint matches (JSON import does). */
  force?: boolean;
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
  {
    force = false,
    reason = force ? 'refresh requested' : 'date parser changed',
  }: RefreshOptions = {},
): Record<string, number> {
  const results: Record<string, number> = {};
  store.db.transaction(() => {
    for (const step of DERIVED_STEPS) {
      const fingerprint = step.fingerprint();
      const stored = store.db
        .prepare('SELECT fingerprint FROM derived_state WHERE name = ?')
        .get(step.name) as { fingerprint: string } | undefined;
      if (!force && stored?.fingerprint === fingerprint) continue;
      const changed = step.recompute(store);
      store.db
        .prepare(
          'INSERT INTO derived_state (name, fingerprint) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET fingerprint = excluded.fingerprint',
        )
        .run(step.name, fingerprint);
      results[step.name] = changed;
      if (changed > 0) store.log(`Recomputed ${step.name} for ${changed} rows (${reason})`);
    }
  })();
  return results;
}
