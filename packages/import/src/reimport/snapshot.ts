import type {
  EventRow,
  FamilyChildRow,
  FamilyRow,
  MediaRow,
  PersonNameRow,
  PersonRow,
  TreeStore,
} from '@open-ancestry/db';
import { normalizeForSearch } from '@open-ancestry/core';
import { tokenizeLine } from '@open-ancestry/gedcom';

/*
 * A person-centric, in-memory view of a tree, read with a handful of bulk
 * queries so matching and diffing never query per person. Built for the
 * existing tree and for the incoming export (imported into a memory tree).
 */

export interface SnapCitation {
  id: string;
  sourceKey: string;
  sourceTitle: string;
  page: string | null;
  apid: string | null;
}

export interface SnapEvent {
  row: EventRow;
  place: string | null;
  isPreferred: boolean;
  citations: SnapCitation[];
}

export interface SnapPerson {
  row: PersonRow;
  names: PersonNameRow[];
  /** Normalized primary given and surname, for matching. */
  given: string;
  surname: string;
  events: SnapEvent[];
  birthYear: number | null;
  /**
   * Years a birth date spans when it is not one year: `BET 1940 AND 1949`,
   * or 30 years before `BEF` / after `AFT`. Null for a plain date.
   */
  birthRange: { start: number; end: number } | null;
  deathYear: number | null;
  birthPlace: string | null;
  parents: string[];
  spouses: string[];
  children: string[];
  /** Record-level Ancestry ids (`_APID`) cited anywhere on the person. */
  apids: Set<string>;
  citations: SnapCitation[];
  tags: { id: string; key: string; name: string; category: string }[];
  media: { row: MediaRow; key: string }[];
}

export interface Snapshot {
  people: Map<string, SnapPerson>;
  families: Map<string, FamilyRow>;
  familyChildren: FamilyChildRow[];
  /** Family events (marriage, divorce, ...) by family id. */
  /** Family facts (marriage, divorce) by family, paired like person facts (#268). */
  familyEvents: Map<string, SnapEvent[]>;
  /**
   * The latest import's person records by xref, mapped to the person they
   * belong to now. A merge (#70) points several xrefs at one person.
   */
  importXrefs: Map<string, string>;
}

const year = (sort: number | null | undefined) => (sort ? Math.floor(sort / 10000) : null);

/** How far a BEF or AFT date reaches, in years. */
export const OPEN_RANGE_YEARS = 30;

function birthRange(
  start: number | null,
  end: number | null,
  qualifier: string | null,
): SnapPerson['birthRange'] {
  if (start === null) return null;
  if (end !== null && end !== start) return { start, end };
  if (qualifier === 'before') return { start: start - OPEN_RANGE_YEARS, end: start };
  if (qualifier === 'after') return { start, end: start + OPEN_RANGE_YEARS };
  return null;
}

export const norm = (text: string | null | undefined) => normalizeForSearch(text ?? '').trim();

/** A source identity that survives re-export: its Ancestry database id, else its title. */
export const sourceKey = (title: string, apid: string | null) =>
  apid ? `apid:${apid}` : `title:${norm(title)}`;

type KeyedMedia = Pick<
  MediaRow,
  'id' | 'ancestry_oid' | 'remote_url' | 'sha256' | 'local_path' | 'title'
>;

/**
 * A media identity that survives re-export. Media whose file was missing at
 * import have no path of their own, so their imported FILE value stands in:
 * without it, two untitled missing photos would share one key.
 */
export const mediaKey = (m: KeyedMedia, file?: string) =>
  m.ancestry_oid
    ? `oid:${m.ancestry_oid}`
    : m.remote_url
      ? `url:${m.remote_url}`
      : m.sha256
        ? `sha:${m.sha256}`
        : `path:${m.local_path ?? file ?? ''}:${norm(m.title)}`;

/** `mediaKey` for a tree's media, reading each one's imported FILE line once. */
export function mediaKeys(store: TreeStore): (m: KeyedMedia) => string {
  const files = new Map<string, string>();
  const rows = store.db
    .prepare(
      `SELECT owner_id, line FROM unmapped_line
        WHERE owner_type = 'media' AND (path = 'FILE' OR path LIKE '%.FILE')
        ORDER BY line_no`,
    )
    .all() as { owner_id: string; line: string }[];
  for (const row of rows) {
    const value = tokenizeLine(row.line)?.value?.trim();
    if (value && !files.has(row.owner_id)) files.set(row.owner_id, value);
  }
  return (m) => mediaKey(m, files.get(m.id));
}

/** Ancestry record ids only: the database-level `1,7602::0` ids are shared by everyone. */
export const isRecordApid = (apid: string | null): apid is string => !!apid && !/::0$/.test(apid);

function all<T>(store: TreeStore, sql: string): T[] {
  return store.db.prepare(sql).all() as T[];
}

export function snapshot(store: TreeStore): Snapshot {
  const keyOf = mediaKeys(store);
  const people = new Map<string, SnapPerson>();
  for (const row of all<PersonRow>(store, 'SELECT * FROM person')) {
    people.set(row.id, {
      row,
      names: [],
      given: '',
      surname: '',
      events: [],
      birthYear: null,
      birthRange: null,
      deathYear: null,
      birthPlace: null,
      parents: [],
      spouses: [],
      children: [],
      apids: new Set(),
      citations: [],
      tags: [],
      media: [],
    });
  }
  for (const name of all<PersonNameRow>(
    store,
    'SELECT * FROM person_name ORDER BY person_id, sort_order, id',
  )) {
    const p = people.get(name.person_id);
    if (!p) continue;
    p.names.push(name);
    if (name.is_primary) {
      p.given = norm(name.given);
      p.surname = norm(name.surname);
    }
  }

  // Citations by owner.
  const citations = new Map<string, SnapCitation[]>();
  for (const c of all<{
    owner_type: string;
    owner_id: string;
    id: string;
    page: string | null;
    apid: string | null;
    title: string;
    source_apid: string | null;
  }>(
    store,
    `SELECT l.owner_type, l.owner_id, c.id, c.page, c.apid, s.title, s.apid AS source_apid
     FROM citation_link l JOIN citation c ON c.id = l.citation_id JOIN source s ON s.id = c.source_id
     ORDER BY l.sort_order, l.id`,
  )) {
    const key = `${c.owner_type}|${c.owner_id}`;
    const list = citations.get(key) ?? [];
    list.push({
      id: c.id,
      sourceKey: sourceKey(c.title, c.source_apid),
      sourceTitle: c.title,
      page: c.page,
      apid: c.apid,
    });
    citations.set(key, list);
  }

  for (const e of all<
    EventRow & { person_id: string; is_preferred: number; place_name: string | null }
  >(
    store,
    `SELECT e.*, r.person_id, r.is_preferred, p.full_name AS place_name
     FROM event_role r JOIN event e ON e.id = r.event_id LEFT JOIN place p ON p.id = e.place_id
     WHERE r.person_id IS NOT NULL AND r.role = 'principal'
     ORDER BY r.person_id, r.sort_order, e.id`,
  )) {
    const p = people.get(e.person_id);
    if (!p) continue;
    const { person_id: _p, is_preferred, place_name, ...row } = e;
    void _p;
    const event: SnapEvent = {
      row: row as EventRow,
      place: place_name,
      isPreferred: is_preferred === 1,
      citations: citations.get(`event|${row.id}`) ?? [],
    };
    p.events.push(event);
    if (event.isPreferred && row.type === 'BIRT') {
      if (p.birthYear === null) {
        p.birthYear = year(row.date_sort);
        p.birthRange = birthRange(p.birthYear, year(row.date_sort_end), row.date_qualifier);
      }
      p.birthPlace ??= place_name;
    }
    if (event.isPreferred && row.type === 'DEAT') p.deathYear ??= year(row.date_sort);
    for (const c of event.citations) if (isRecordApid(c.apid)) p.apids.add(c.apid);
  }
  for (const p of people.values()) {
    p.citations = citations.get(`person|${p.row.id}`) ?? [];
    for (const c of p.citations) if (isRecordApid(c.apid)) p.apids.add(c.apid);
  }

  const families = new Map(all<FamilyRow>(store, 'SELECT * FROM family').map((f) => [f.id, f]));
  const familyChildren = all<FamilyChildRow>(store, 'SELECT * FROM family_child');
  for (const f of families.values()) {
    if (f.partner1_id && f.partner2_id) {
      people.get(f.partner1_id)?.spouses.push(f.partner2_id);
      people.get(f.partner2_id)?.spouses.push(f.partner1_id);
    }
  }
  for (const link of familyChildren) {
    const f = families.get(link.family_id);
    if (!f) continue;
    for (const parent of [f.partner1_id, f.partner2_id]) {
      if (!parent) continue;
      people.get(link.child_id)?.parents.push(parent);
      people.get(parent)?.children.push(link.child_id);
    }
  }

  for (const t of all<{ owner_id: string; id: string; name: string; category: string }>(
    store,
    `SELECT l.owner_id, t.id, t.name, t.category FROM tag_link l JOIN tag t ON t.id = l.tag_id
     WHERE l.owner_type = 'person'`,
  )) {
    people.get(t.owner_id)?.tags.push({
      id: t.id,
      key: `${norm(t.category)}|${norm(t.name)}`,
      name: t.name,
      category: t.category,
    });
  }
  for (const m of all<MediaRow & { owner_id: string }>(
    store,
    `SELECT m.*, l.owner_id FROM media_link l JOIN media m ON m.id = l.media_id
     WHERE l.owner_type = 'person' ORDER BY l.sort_order, l.id`,
  )) {
    const { owner_id, ...row } = m;
    people.get(owner_id)?.media.push({ row: row as MediaRow, key: keyOf(row as MediaRow) });
  }

  const familyEvents = new Map<string, SnapEvent[]>();
  for (const e of all<
    EventRow & { family_id: string; is_preferred: number; place_name: string | null }
  >(
    store,
    `SELECT e.*, r.family_id, r.is_preferred, p.full_name AS place_name
     FROM event_role r JOIN event e ON e.id = r.event_id LEFT JOIN place p ON p.id = e.place_id
     WHERE r.family_id IS NOT NULL ORDER BY r.sort_order, e.id`,
  )) {
    const { family_id, is_preferred, place_name, ...row } = e;
    const list = familyEvents.get(family_id) ?? [];
    // Family facts' sources are not compared (as before #268): only the facts are.
    list.push({
      row: row as EventRow,
      place: place_name,
      isPreferred: is_preferred === 1,
      citations: [],
    });
    familyEvents.set(family_id, list);
  }

  const importXrefs = new Map<string, string>();
  for (const r of all<{ xref: string; owner_id: string }>(
    store,
    `SELECT xref, owner_id FROM raw_record
     WHERE owner_type = 'person' AND xref IS NOT NULL AND owner_id IS NOT NULL
       AND import_batch_id = (SELECT id FROM import_batch ORDER BY started_at DESC, id DESC LIMIT 1)`,
  )) {
    if (people.has(r.owner_id)) importXrefs.set(r.xref, r.owner_id);
  }

  return { people, families, familyChildren, familyEvents, importXrefs };
}

/**
 * Name ids whose export gave a name type (`2 TYPE` under the NAME). Matched
 * by the NAME value, which is enough for Ancestry's exports: two identical
 * NAME lines where only one is typed would both count, and a NAME continued
 * with CONC would not match. Others
 * get the importer's default, which the review should not present as fact.
 */
export function statedNameTypes(store: TreeStore): Set<string> {
  const stated = new Set<string>();
  const typed = new Set<string>();
  for (const r of all<{ owner_id: string; raw_text: string }>(
    store,
    "SELECT owner_id, raw_text FROM raw_record WHERE owner_type = 'person' AND owner_id IS NOT NULL",
  )) {
    let name: string | null = null;
    for (const line of r.raw_text.split('\n')) {
      if (line.startsWith('1 ')) name = line.startsWith('1 NAME') ? line.slice(7).trim() : null;
      else if (name !== null && line.startsWith('2 TYPE')) typed.add(`${r.owner_id}|${name}`);
    }
  }
  if (!typed.size) return stated;
  for (const n of all<{ id: string; person_id: string; full_text: string | null }>(
    store,
    'SELECT id, person_id, full_text FROM person_name',
  )) {
    if (typed.has(`${n.person_id}|${(n.full_text ?? '').trim()}`)) stated.add(n.id);
  }
  return stated;
}
