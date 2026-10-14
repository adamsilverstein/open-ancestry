// Schema version 3. No table changes (history/schema-v3.sql equals v2).
//
// Text arrived both composed (NFC) and decomposed (NFD: macOS file names, PDFs,
// merged trees), so equal-looking names, places and tags were different values
// (#99). From this version on, writes store NFC (nfc.ts). This migration
// rewrites existing text in place, inside the migration transaction and
// without a change batch: it is an upgrade, not an edit, so nothing appears in
// History and exports stay verbatim. Places whose full name is then identical
// merge into the oldest row, and so do tags whose category and name are
// identical (their UNIQUE constraint would refuse the rewrite otherwise).
// Older change_log images and JSON backups get the same treatment through
// `upgradeRow` and `upgradeTables`.
import type { Database } from 'better-sqlite3';
import { MERGED_IDS_KEY, isNfcColumn, nfcRow, toNFC } from '../nfc';
import { rebuildSearchDocs } from '../search-docs';
import { DATA_TABLES } from '../tables';
import type { TableRowsByName } from './index';

type Row = Record<string, unknown>;

/** Owner references that point at a place, by link table and the column naming the linked row. */
const PLACE_LINKS = [
  ['media_link', 'media_id'],
  ['note_link', 'note_id'],
] as const;

export function normalizeText(db: Database): void {
  const merged: string[] = [];
  for (const table of DATA_TABLES) {
    const columns = (
      db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]
    ).map((c) => c.name);
    const text = columns.filter((c) => isNfcColumn(table, c));
    if (text.length === 0) continue;
    const key = table === 'meta' ? 'key' : 'id';
    // GLOB '[^ -~]' finds rows with any character outside printable ASCII.
    const where = text.map((c) => `${c} GLOB '*[^ -~]*'`).join(' OR ');
    const rows = db
      .prepare(`SELECT ${[key, ...text].join(', ')} FROM ${table} WHERE ${where}`)
      .all() as Row[];
    for (const row of rows) {
      const patch = Object.entries(nfcRow(table, row)).filter(
        ([column, value]) => column !== key && value !== row[column],
      );
      if (patch.length === 0) continue;
      if (table === 'tag' && mergeTag(db, row[key] as string, Object.fromEntries(patch))) {
        merged.push(row[key] as string);
        continue;
      }
      db.prepare(
        `UPDATE ${table} SET ${patch.map(([c]) => `${c} = ?`).join(', ')} WHERE ${key} = ?`,
      ).run(...patch.map(([, value]) => value), row[key]);
    }
  }
  merged.push(...mergePlaces(db));
  if (merged.length) {
    // Undo names these in its refusal of older edits that still point at them (see undo.ts).
    db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ).run(MERGED_IDS_KEY, JSON.stringify(merged.sort()));
  }
  rebuildSearchDocs(db);
}

/** Folds a tag into an existing one with the same normalized category and name. */
function mergeTag(db: Database, id: string, patch: Row): boolean {
  const tag = db.prepare('SELECT category, name FROM tag WHERE id = ?').get(id) as Row;
  const target = { ...tag, ...patch };
  const survivor = db
    .prepare('SELECT id FROM tag WHERE category = ? AND name = ? AND id <> ? ORDER BY id LIMIT 1')
    .pluck()
    .get(target.category, target.name, id) as string | undefined;
  if (survivor === undefined) return false;
  db.prepare(
    `DELETE FROM tag_link WHERE tag_id = ? AND EXISTS (SELECT 1 FROM tag_link s
       WHERE s.tag_id = ? AND s.owner_type = tag_link.owner_type AND s.owner_id = tag_link.owner_id)`,
  ).run(id, survivor);
  db.prepare('UPDATE tag_link SET tag_id = ? WHERE tag_id = ?').run(survivor, id);
  db.prepare('DELETE FROM tag WHERE id = ?').run(id);
  return true;
}

/**
 * Merges places with identical full names into the oldest, parents (shorter
 * names) first. Returns the ids of the places merged away.
 */
function mergePlaces(db: Database): string[] {
  const merged: string[] = [];
  const names = db
    .prepare('SELECT full_name FROM place GROUP BY full_name HAVING count(*) > 1')
    .pluck()
    .all() as string[];
  for (const fullName of names.sort((a, b) => a.length - b.length)) {
    const [survivor, ...duplicates] = db
      .prepare('SELECT id, latitude, longitude FROM place WHERE full_name = ? ORDER BY id')
      .all(fullName) as { id: string; latitude: number | null; longitude: number | null }[];
    for (const dup of duplicates) {
      if (survivor!.latitude == null && dup.latitude != null) {
        db.prepare('UPDATE place SET latitude = ?, longitude = ? WHERE id = ?').run(
          dup.latitude,
          dup.longitude,
          survivor!.id,
        );
        survivor!.latitude = dup.latitude;
        survivor!.longitude = dup.longitude;
      }
      db.prepare('UPDATE event SET place_id = ? WHERE place_id = ?').run(survivor!.id, dup.id);
      db.prepare('UPDATE place SET parent_id = ? WHERE parent_id = ?').run(survivor!.id, dup.id);
      for (const [table, ref] of PLACE_LINKS) {
        db.prepare(
          `DELETE FROM ${table} WHERE owner_type = 'place' AND owner_id = ? AND EXISTS (
             SELECT 1 FROM ${table} s WHERE s.owner_type = 'place' AND s.owner_id = ? AND s.${ref} = ${table}.${ref})`,
        ).run(dup.id, survivor!.id);
        db.prepare(
          `UPDATE ${table} SET owner_id = ? WHERE owner_type = 'place' AND owner_id = ?`,
        ).run(survivor!.id, dup.id);
      }
      db.prepare('DELETE FROM place WHERE id = ?').run(dup.id);
      merged.push(dup.id);
    }
  }
  return merged;
}

/** The same rewrite for one row written before this version (change_log images, JSON rows). */
export function upgradeRow(table: string, row: Row): Row {
  return nfcRow(table, row);
}

/** The merges for an older JSON document, whose rows `upgradeRow` already normalized. */
export function upgradeTables(tables: TableRowsByName): void {
  const merged: string[] = [];
  merged.push(
    ...mergeRows(
      tables,
      'tag',
      (t) => `${String(t.category)}\u0000${String(t.name)}`,
      (from, to) => {
        const links = tables.tag_link;
        if (!links) return;
        for (const link of links) if (link.tag_id === from) link.tag_id = to;
        tables.tag_link = unique(
          links,
          (l) => `${String(l.tag_id)}|${String(l.owner_type)}|${String(l.owner_id)}`,
        );
      },
    ),
  );
  merged.push(
    ...mergeRows(
      tables,
      'place',
      (p) => String(p.full_name),
      (from, to, survivor, dup) => {
        if (survivor.latitude == null && dup.latitude != null) {
          survivor.latitude = dup.latitude;
          survivor.longitude = dup.longitude;
        }
        for (const event of tables.event ?? []) if (event.place_id === from) event.place_id = to;
        for (const place of tables.place ?? []) if (place.parent_id === from) place.parent_id = to;
        for (const [table, ref] of PLACE_LINKS) {
          const links = tables[table];
          if (!links) continue;
          for (const link of links) {
            if (link.owner_type === 'place' && link.owner_id === from) link.owner_id = to;
          }
          tables[table] = unique(
            links,
            (l) => `${String(l[ref])}|${String(l.owner_type)}|${String(l.owner_id)}`,
          );
        }
      },
    ),
  );
  if (merged.length) {
    const meta = (tables.meta ??= []).filter((row) => row.key !== MERGED_IDS_KEY);
    meta.push({ key: MERGED_IDS_KEY, value: JSON.stringify(merged.sort()) });
    tables.meta = meta;
  }
}

/**
 * Groups rows by `key`; every row after the one with the smallest id merges
 * into it. Returns the ids merged away.
 */
function mergeRows(
  tables: TableRowsByName,
  table: string,
  key: (row: Row) => string,
  merge: (from: unknown, to: unknown, survivor: Row, duplicate: Row) => void,
): string[] {
  const rows = tables[table];
  if (!rows) return [];
  const survivors = new Map<string, Row>();
  const removed = new Set<Row>();
  for (const row of [...rows].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))) {
    const k = toNFC(key(row));
    const survivor = survivors.get(k);
    if (!survivor) {
      survivors.set(k, row);
      continue;
    }
    merge(row.id, survivor.id, survivor, row);
    removed.add(row);
  }
  if (removed.size) tables[table] = rows.filter((row) => !removed.has(row));
  return [...removed].map((row) => String(row.id));
}

/** Keeps the first row for each key. */
function unique(rows: Row[], key: (row: Row) => string): Row[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const k = key(row);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
