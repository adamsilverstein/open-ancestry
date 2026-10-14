import { openMemoryTree, type TreeStore } from '@open-ancestry/db';
import { join } from 'node:path';
import { importGedcom } from './import';
import type { ImportOptions, ImportReport } from './types';

export const FIXTURES = join(import.meta.dirname, '../../../fixtures');
export const TODAY = new Date('2026-10-14T12:00:00Z');

export interface Imported {
  store: TreeStore;
  report: ImportReport;
}

/** Imports GEDCOM text or bytes into a fresh in-memory tree. */
export async function importInto(
  bytes: Uint8Array | string,
  options: ImportOptions = {},
): Promise<Imported> {
  const store = openMemoryTree();
  const report = await importGedcom({ bytes }, store, { today: TODAY, ...options });
  return { store, report };
}

/** Builds a GEDCOM 5.5.1 file around the given record lines. */
export function ged(...lines: string[]): string {
  return ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', '1 CHAR UTF-8', ...lines, '0 TRLR', ''].join('\n');
}

export function rows<T = Record<string, unknown>>(
  store: TreeStore,
  sql: string,
  ...params: unknown[]
): T[] {
  return store.db.prepare(sql).all(...params) as T[];
}

export function row<T = Record<string, unknown>>(
  store: TreeStore,
  sql: string,
  ...params: unknown[]
): T | undefined {
  return store.db.prepare(sql).get(...params) as T | undefined;
}

export function value<T = unknown>(store: TreeStore, sql: string, ...params: unknown[]): T {
  return store.db
    .prepare(sql)
    .pluck()
    .get(...params) as T;
}

/** Person id by xref. */
export function pid(store: TreeStore, xref: string): string {
  const id = value<string | undefined>(store, 'SELECT id FROM person WHERE external_id = ?', xref);
  if (!id) throw new Error(`no person ${xref}`);
  return id;
}

/** Family id by xref. */
export function fid(store: TreeStore, xref: string): string {
  const id = value<string | undefined>(store, 'SELECT id FROM family WHERE external_id = ?', xref);
  if (!id) throw new Error(`no family ${xref}`);
  return id;
}

export interface EventView {
  id: string;
  type: string;
  custom_type: string | null;
  date_text: string | null;
  date_qualifier: string | null;
  date_sort: number | null;
  date_sort_end: number | null;
  value: string | null;
  description: string | null;
  age: string | null;
  cause: string | null;
  privacy: string;
  place: string | null;
  is_preferred: number;
  sort_order: number;
}

const EVENT_SELECT = `SELECT e.*, p.full_name AS place, r.is_preferred, r.sort_order
  FROM event e JOIN event_role r ON r.event_id = e.id LEFT JOIN place p ON p.id = e.place_id`;

/** A person's events (by xref), in sort order. */
export function personEvents(store: TreeStore, xref: string, type?: string): EventView[] {
  return rows<EventView>(
    store,
    `${EVENT_SELECT} WHERE r.person_id = ? AND (? IS NULL OR e.type = ?) ORDER BY r.sort_order`,
    pid(store, xref),
    type ?? null,
    type ?? null,
  );
}

/** A family's events (by xref), in sort order. */
export function familyEvents(store: TreeStore, xref: string, type?: string): EventView[] {
  return rows<EventView>(
    store,
    `${EVENT_SELECT} WHERE r.family_id = ? AND (? IS NULL OR e.type = ?) ORDER BY r.sort_order`,
    fid(store, xref),
    type ?? null,
    type ?? null,
  );
}

export interface CitationView {
  page: string | null;
  apid: string | null;
  url: string | null;
  quality: number | null;
  date_text: string | null;
  text: string | null;
  title: string;
  source_apid: string | null;
}

export function citationsOf(store: TreeStore, ownerType: string, ownerId: string): CitationView[] {
  return rows<CitationView>(
    store,
    `SELECT c.page, c.apid, c.url, c.quality, c.date_text, c.text, s.title, s.apid AS source_apid
     FROM citation_link l JOIN citation c ON c.id = l.citation_id JOIN source s ON s.id = c.source_id
     WHERE l.owner_type = ? AND l.owner_id = ? ORDER BY l.sort_order`,
    ownerType,
    ownerId,
  );
}

export function notesOf(store: TreeStore, ownerType: string, ownerId: string): string[] {
  return rows<{ text: string }>(
    store,
    `SELECT n.text FROM note_link l JOIN note n ON n.id = l.note_id
     WHERE l.owner_type = ? AND l.owner_id = ? ORDER BY l.sort_order`,
    ownerType,
    ownerId,
  ).map((r) => r.text);
}

export function tagsOf(store: TreeStore, ownerType: string, ownerId: string): string[] {
  return rows<{ name: string; category: string }>(
    store,
    `SELECT t.name, t.category FROM tag_link l JOIN tag t ON t.id = l.tag_id
     WHERE l.owner_type = ? AND l.owner_id = ? ORDER BY t.name`,
    ownerType,
    ownerId,
  ).map((r) => `${r.category}/${r.name}`);
}

/** Concatenated raw_record text plus preamble lines, in file order. */
export function rawText(store: TreeStore): string {
  const preamble = rows<{ line: string }>(
    store,
    "SELECT line FROM unmapped_line WHERE path = '(preamble)' ORDER BY line_no",
  ).map((r) => r.line + '\n');
  const records = rows<{ raw_text: string }>(
    store,
    'SELECT raw_text FROM raw_record ORDER BY seq',
  ).map((r) => r.raw_text + '\n');
  return preamble.join('') + records.join('');
}
