import { inferLiving, replaceNickname } from '@open-ancestry/core';
import {
  events,
  names,
  persons,
  toNFC,
  type EventRow,
  type PersonNameRow,
  type InsertRow,
  type PatchRow,
  type PersonRow,
  type TreeStore,
  type Tx,
} from '@open-ancestry/db';
import {
  BIRTH_SUBSTITUTES,
  DEATH_EVENTS,
  OTHER_DEATH_FACTS,
  dateColumns as importDateColumns,
  surnameKey as importSurnameKey,
} from '@open-ancestry/import';
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

/** Same keys as an import, so search treats typed and imported names alike. */
export const surnameKey = importSurnameKey;

type NameParts = Pick<PersonNameRow, 'given' | 'surname' | 'surname_prefix' | 'prefix' | 'suffix'>;

/** The name in GEDCOM form (`Dr. Finn /Vale/ Jr.`), as the importer stores it. */
export function gedcomName(name: Partial<NameParts>): string | null {
  const surname = [name.surname_prefix, name.surname].filter((p) => p?.trim()).join(' ');
  const text = [name.prefix, name.given, surname ? `/${surname}/` : null, name.suffix]
    .filter((p) => p?.trim())
    .join(' ');
  return text || null;
}

/**
 * Name body to row. `existing` is the stored row on an edit, so derived
 * columns are computed from the name as it will be after the patch.
 */
export function nameRow(
  body: NameBody,
  existing?: PersonNameRow,
): Omit<InsertRow<'person_name'>, 'person_id'> {
  const { is_primary, ...fields } = body;
  const row: Omit<InsertRow<'person_name'>, 'person_id'> = { ...fields };
  if (is_primary !== undefined) row.is_primary = is_primary ? 1 : 0;
  if ('surname' in body) row.surname_key = surnameKey(body.surname);
  const parts = ['given', 'surname', 'surname_prefix', 'prefix', 'suffix'] as const;
  if (!existing || parts.some((p) => p in body)) {
    row.full_text = gedcomName({ ...existing, ...fields });
  } else if ('nickname' in body && existing.full_text && body.nickname !== existing.nickname) {
    // A nickname-only edit keeps the text as written, with the nickname in it swapped.
    const text = replaceNickname(existing.full_text, existing.nickname, body.nickname);
    if (text !== existing.full_text) row.full_text = text;
  }
  return row;
}

/** Date columns as the importer fills them; blank text clears them. */
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
  return importDateColumns(dateText);
}

/** Finds a place by its full name (case-insensitive) or creates it. */
export function placeId(tx: Tx, fullName: string | null | undefined): string | null {
  // NFC so a decomposed spelling finds the stored (NFC) place instead of adding a twin.
  const name = fullName === null || fullName === undefined ? undefined : toNFC(fullName.trim());
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
  refreshLiving(tx, [person.id], { relatives: false });
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

// ---------------------------------------------------------------- living

const INFERRED = new Set(['inferred_living', 'inferred_dead', 'unknown']);
const DEATH_FACTS = new Set([...DEATH_EVENTS, ...OTHER_DEATH_FACTS]);

interface PrincipalEvent {
  type: string;
  date_text: string | null;
  is_preferred: number;
}

function principalEvents(store: TreeStore, personId: string): PrincipalEvent[] {
  return store
    .stmt(
      `SELECT e.type, e.date_text, r.is_preferred FROM event_role r JOIN event e ON e.id = r.event_id
       WHERE r.person_id = ? AND r.role = 'principal'
       ORDER BY r.is_preferred DESC, r.sort_order, e.id`,
    )
    .all(personId) as PrincipalEvent[];
}

/** Birth date text the way the importer picks it: BIRT, else a christening or baptism. */
function birthOf(store: TreeStore, personId: string): string | undefined {
  const evts = principalEvents(store, personId);
  for (const types of [['BIRT'], BIRTH_SUBSTITUTES]) {
    const found = evts.find((e) => types.includes(e.type) && e.date_text);
    if (found) return found.date_text!;
  }
  return undefined;
}

interface Kin {
  parents: string[];
  spouses: string[];
  children: string[];
}

function kinOf(store: TreeStore, personId: string): Kin {
  const ids = (sql: string) =>
    (store.stmt(sql).all({ id: personId }) as { id: string | null }[])
      .map((r) => r.id)
      .filter((id): id is string => !!id && id !== personId);
  return {
    parents: ids(
      `SELECT f.partner1_id AS id FROM family_child fc JOIN family f ON f.id = fc.family_id WHERE fc.child_id = @id
       UNION SELECT f.partner2_id FROM family_child fc JOIN family f ON f.id = fc.family_id WHERE fc.child_id = @id`,
    ),
    spouses: ids(
      `SELECT partner2_id AS id FROM family WHERE partner1_id = @id
       UNION SELECT partner1_id FROM family WHERE partner2_id = @id`,
    ),
    children: ids(
      `SELECT fc.child_id AS id FROM family f JOIN family_child fc ON fc.family_id = f.id
       WHERE f.partner1_id = @id OR f.partner2_id = @id`,
    ),
  };
}

/**
 * Re-runs living inference (core inferLiving, as the importer does) for the
 * given people and, with `relatives`, their parents, spouses and children,
 * whose estimates can depend on them. Explicit living/dead choices are kept.
 */
export function refreshLiving(
  tx: Tx,
  personIds: Iterable<string>,
  { relatives = true } = {},
): void {
  const store = tx.store;
  const targets = new Set<string>();
  for (const id of personIds) {
    if (!store.getRow('person', id)) continue;
    targets.add(id);
    if (relatives) {
      const kin = kinOf(store, id);
      for (const k of [...kin.parents, ...kin.spouses, ...kin.children]) targets.add(k);
    }
  }
  for (const id of targets) {
    const person = store.getRow('person', id);
    if (!person || !INFERRED.has(person.living)) continue;
    const evts = principalEvents(store, id);
    const firstDate = (type: string) => {
      const found = evts.filter((e) => e.type === type);
      // Any record of the fact counts, even undated (empty string).
      return found.length > 0 ? (found.find((e) => e.date_text)?.date_text ?? '') : undefined;
    };
    const kin = kinOf(store, id);
    const births = (list: string[]) =>
      list.flatMap((k) => {
        const birth = birthOf(store, k);
        return birth ? [birth] : [];
      });
    const result = inferLiving({
      birth: birthOf(store, id),
      death: firstDate('DEAT'),
      burial: firstDate('BURI'),
      hasDeathFacts: evts.some(
        (e) => DEATH_FACTS.has(e.type) && e.type !== 'DEAT' && e.type !== 'BURI',
      ),
      parentBirths: births(kin.parents),
      spouseBirths: births(kin.spouses),
      childBirths: births(kin.children),
    });
    const living = result.living ? 'inferred_living' : 'inferred_dead';
    if (living !== person.living) persons.update(tx, id, { living });
  }
}

/** People with a principal role in an event (for refreshing their living status). */
export function eventPeople(store: TreeStore, eventId: string): string[] {
  return (
    store
      .stmt(
        'SELECT DISTINCT person_id AS id FROM event_role WHERE event_id = ? AND person_id IS NOT NULL',
      )
      .all(eventId) as { id: string }[]
  ).map((r) => r.id);
}

// ---------------------------------------------------------------- labels

/*
 * Change batch labels name who and what changed ("Edit name: Ada Vale",
 * "Add Census: Ada Vale"), so history and undo toasts are self-explanatory.
 */

const EVENT_LABELS: Record<string, string> = {
  BIRT: 'Birth',
  CHR: 'Christening',
  BAPM: 'Baptism',
  DEAT: 'Death',
  BURI: 'Burial',
  CREM: 'Cremation',
  MARR: 'Marriage',
  DIV: 'Divorce',
  ENGA: 'Engagement',
  RESI: 'Residence',
  OCCU: 'Occupation',
  EDUC: 'Education',
  CENS: 'Census',
  EMIG: 'Emigration',
  IMMI: 'Immigration',
  NATU: 'Naturalization',
  MILI: 'Military',
  RELI: 'Religion',
  RETI: 'Retirement',
  GRAD: 'Graduation',
  PROB: 'Probate',
  WILL: 'Will',
};

export function eventTypeLabel(type: string, customType?: string | null): string {
  return (
    EVENT_LABELS[type.toUpperCase()] ??
    (customType?.trim() || type.charAt(0) + type.slice(1).toLowerCase())
  );
}

/** `Ada Vale` from a person's primary name, or `unnamed person`. */
export function personLabel(store: TreeStore, personId: string | null | undefined): string {
  if (!personId) return 'unknown person';
  const name = store
    .stmt(
      `SELECT prefix, given, surname_prefix, surname, suffix FROM person_name
       WHERE person_id = ? ORDER BY is_primary DESC, sort_order, id LIMIT 1`,
    )
    .get(personId) as Partial<NameParts> | undefined;
  const text = [name?.prefix, name?.given, name?.surname_prefix, name?.surname, name?.suffix]
    .filter((p) => p?.trim())
    .join(' ');
  return text || 'unnamed person';
}

/** `Ada Vale and Dan Reed` for a family. */
export function familyLabel(store: TreeStore, familyId: string): string {
  const family = store.getRow('family', familyId);
  if (!family) return 'family';
  const partners = [family.partner1_id, family.partner2_id].filter((p): p is string => !!p);
  return partners.length > 0 ? partners.map((p) => personLabel(store, p)).join(' and ') : 'family';
}

/** Whose event it is: its principal person, else its family. */
export function eventOwnerLabel(store: TreeStore, eventId: string): string {
  const role = store
    .stmt(
      `SELECT person_id, family_id FROM event_role WHERE event_id = ?
       ORDER BY role = 'principal' DESC, sort_order LIMIT 1`,
    )
    .get(eventId) as { person_id: string | null; family_id: string | null } | undefined;
  if (role?.person_id) return personLabel(store, role.person_id);
  if (role?.family_id) return familyLabel(store, role.family_id);
  return 'unlinked event';
}

/** `Ada Vale` from a create body's first name. */
export function bodyLabel(body: { names?: { given?: string | null; surname?: string | null }[] }) {
  const [name] = body.names ?? [];
  return [name?.given, name?.surname].filter((p) => p?.trim()).join(' ') || 'unnamed person';
}

/** Parents, spouses and children of a person, whose inferred status can depend on them. */
export function relativesOf(store: TreeStore, personId: string): string[] {
  const kin = kinOf(store, personId);
  return [...kin.parents, ...kin.spouses, ...kin.children];
}

/** Everyone linked to a family: partners and children. */
export function familyMembers(store: TreeStore, familyId: string): string[] {
  const family = store.getRow('family', familyId);
  const children = (
    store.stmt('SELECT child_id AS id FROM family_child WHERE family_id = ?').all(familyId) as {
      id: string;
    }[]
  ).map((r) => r.id);
  return [family?.partner1_id, family?.partner2_id, ...children].filter((id): id is string => !!id);
}

/** Who or what a note is attached to, for labels. */
export function ownerLabel(store: TreeStore, ownerType: string, ownerId: string): string {
  if (ownerType === 'person') return personLabel(store, ownerId);
  if (ownerType === 'family') return familyLabel(store, ownerId);
  if (ownerType === 'event') return eventOwnerLabel(store, ownerId);
  return ownerType;
}

export function noteLabel(store: TreeStore, noteId: string): string {
  const link = store
    .stmt(
      'SELECT owner_type, owner_id FROM note_link WHERE note_id = ? ORDER BY sort_order LIMIT 1',
    )
    .get(noteId) as { owner_type: string; owner_id: string } | undefined;
  return link ? ownerLabel(store, link.owner_type, link.owner_id) : 'unlinked note';
}
