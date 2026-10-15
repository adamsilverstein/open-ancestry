import type { Database } from 'better-sqlite3';
import { BIRTH_TYPES, DEATH_TYPES } from './queries';
import type { TreeStore } from './store';

/*
 * person_sort: each person's people-list sort keys and filters (#114), kept beside the
 * search documents and refreshed with them (search.ts), so the first page of
 * any order is an index scan instead of a grouped join and a sort of the
 * whole tree. Derived: not exported, not change-logged, rebuilt on import.
 */

const IDS = 'SELECT value FROM json_each(?)';
const types = (list: readonly string[]) => list.map((t) => `'${t}'`).join(', ');

/** Earliest principal date of the given event types for `p.id`. */
const vital = (list: readonly string[]) =>
  `(SELECT min(e.date_sort) FROM event_role r JOIN event e ON e.id = r.event_id
    WHERE r.person_id = p.id AND r.role = 'principal' AND e.type IN (${types(list)})
      AND e.date_sort IS NOT NULL)`;

// A function, not a constant: queries.ts and this module import each other.
const keys = () => `SELECT p.id, n.surname, n.given, ${vital(BIRTH_TYPES)}, ${vital(DEATH_TYPES)},
  p.sex, p.living FROM person p LEFT JOIN person_name n ON n.person_id = p.id AND n.is_primary = 1`;

/** Rewrites the sort keys of the given people (removing those that no longer exist). */
export function refreshSortKeys(store: TreeStore, personIds: string[]): void {
  if (personIds.length === 0) return;
  const ids = JSON.stringify(personIds);
  store.stmt(`DELETE FROM person_sort WHERE person_id IN (${IDS})`).run(ids);
  store
    .stmt(
      `INSERT INTO person_sort (person_id, surname, given, birth_key, death_key, sex, living)
       ${keys()} WHERE p.id IN (${IDS})`,
    )
    .run(ids);
}

/** Rebuilds every person's sort keys in one statement. Callers own the transaction. */
export function rebuildSortKeys(db: Database): void {
  const grouped = (list: readonly string[], alias: string) =>
    `LEFT JOIN (SELECT r.person_id, min(e.date_sort) AS k FROM event_role r
       JOIN event e ON e.id = r.event_id
       WHERE r.role = 'principal' AND e.type IN (${types(list)}) AND e.date_sort IS NOT NULL
       GROUP BY r.person_id) ${alias} ON ${alias}.person_id = p.id`;
  db.exec('DELETE FROM person_sort');
  db.exec(
    `INSERT INTO person_sort (person_id, surname, given, birth_key, death_key, sex, living)
     SELECT p.id, n.surname, n.given, b.k, d.k, p.sex, p.living
     FROM person p LEFT JOIN person_name n ON n.person_id = p.id AND n.is_primary = 1
     ${grouped(BIRTH_TYPES, 'b')} ${grouped(DEATH_TYPES, 'd')}`,
  );
}
