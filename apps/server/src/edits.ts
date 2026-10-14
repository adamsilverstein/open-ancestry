import { parseDate, phoneticKeys } from '@open-ancestry/core';
import {
  events,
  names,
  persons,
  type EventRow,
  type InsertRow,
  type PatchRow,
  type PersonRow,
  type TreeStore,
  type Tx,
} from '@open-ancestry/db';
import { badRequest, notFound } from './errors';
import type { EventBody, EventPatch, NameBody, PersonBody, RelativeBody } from './schemas';

/*
 * Turns API write bodies into rows: derived columns (surname phonetic key,
 * parsed date sort keys) are computed here so callers cannot set them wrong.
 */

export interface EditResult<R> {
  /** The undoable change batch, or null when nothing changed. */
  batchId: string | null;
  result: R;
}

/** Runs `fn` as one undoable change batch. */
export function edit<R>(store: TreeStore, label: string, fn: (tx: Tx) => R): EditResult<R> {
  let changed = false;
  const { batchId, result } = store.transact(label, (tx) => {
    const value = fn(tx);
    changed = tx.changes > 0;
    return value;
  });
  return { batchId: changed ? batchId : null, result };
}

export function surnameKey(surname: string | null | undefined): string | null {
  const keys = surname ? phoneticKeys(surname) : [];
  return keys.length > 0 ? keys.join(' ') : null;
}

export function nameRow(body: NameBody): Omit<InsertRow<'person_name'>, 'person_id'> {
  const { is_primary, ...fields } = body;
  const row: Omit<InsertRow<'person_name'>, 'person_id'> = { ...fields };
  if (is_primary !== undefined) row.is_primary = is_primary ? 1 : 0;
  if ('surname' in body) row.surname_key = surnameKey(body.surname);
  return row;
}

export function dateColumns(dateText: string | null | undefined) {
  if (!dateText?.trim()) {
    return {
      date_text: null,
      date_qualifier: null,
      date_sort: null,
      date_sort_end: null,
      calendar: null,
    };
  }
  const parsed = parseDate(dateText);
  return {
    date_text: dateText,
    date_qualifier: parsed.qualifier,
    date_sort: parsed.valid ? parsed.sortKey : null,
    date_sort_end: parsed.valid ? (parsed.sortKeyEnd ?? null) : null,
    calendar: parsed.calendar === 'gregorian' ? null : parsed.calendar,
  };
}

/** Finds a place by its full name (case-insensitive) or creates it. */
export function placeId(tx: Tx, fullName: string | null | undefined): string | null {
  const name = fullName?.trim();
  if (!name) return null;
  const existing = tx.store
    .stmt('SELECT id FROM place WHERE full_name = ? COLLATE NOCASE ORDER BY id LIMIT 1')
    .get(name) as { id: string } | undefined;
  if (existing) return existing.id;
  return tx.insert('place', { name: name.split(',')[0]!.trim(), full_name: name }).id;
}

export function eventRow(tx: Tx, body: EventPatch): PatchRow<'event'> {
  const { place, date_text, ...fields } = body;
  const row: PatchRow<'event'> = { ...fields };
  if (body.type !== undefined) row.type = body.type.toUpperCase();
  if ('date_text' in body) Object.assign(row, dateColumns(date_text));
  if ('place' in body) row.place_id = placeId(tx, place);
  return row;
}

export function createEvent(
  tx: Tx,
  body: EventBody,
  owner: { person_id: string } | { family_id: string },
): EventRow {
  const { role = 'principal', ...fields } = body;
  return events.create(tx, {
    ...(eventRow(tx, fields) as InsertRow<'event'>),
    roles: [{ ...owner, role, is_preferred: 1 }],
  });
}

export function createPerson(tx: Tx, body: PersonBody): PersonRow {
  const { names: nameBodies = [], events: eventBodies = [], ...fields } = body;
  const person = persons.create(tx, fields);
  nameBodies.forEach((n, i) => names.add(tx, person.id, { sort_order: i, ...nameRow(n) }));
  for (const e of eventBodies) createEvent(tx, e, { person_id: person.id });
  return person;
}

/** Resolves `{ personId }` or creates `{ person }`; exactly one must be given. */
export function resolveRelative(tx: Tx, body: RelativeBody): string {
  if ((body.personId === undefined) === (body.person === undefined)) {
    throw badRequest('Give exactly one of personId (existing person) or person (new person)');
  }
  if (body.personId !== undefined) {
    if (!tx.store.getRow('person', body.personId))
      throw notFound(`Person ${body.personId} not found`);
    return body.personId;
  }
  return createPerson(tx, body.person!).id;
}

export function requireRow<
  T extends 'person' | 'family' | 'family_child' | 'person_name' | 'event' | 'note' | 'tag',
>(store: TreeStore, table: T, id: string) {
  const row = store.getRow(table, id);
  if (!row) throw notFound(`${table.replace('_', ' ')} ${id} not found`);
  return row;
}
