import { openMemoryTree, type TreeStore } from '@open-ancestry/db';
import { parseGedcom, serializeGedcom, type GedcomNode } from '@open-ancestry/gedcom';
import { importGedcom, type ImportOptions } from '@open-ancestry/import';
import { GEDCOM7_TAGS } from './merge';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURES = join(import.meta.dirname, '../../../fixtures');
export const TODAY = new Date('2026-10-14T12:00:00Z');

/** Every committed GEDCOM fixture, relative to fixtures/. */
export const FIXTURE_FILES = [
  'ancestry-sample.ged',
  'generated/synthetic-1000.ged',
  ...readdirSync(join(FIXTURES, 'gedcom'))
    .filter((f) => f.endsWith('.ged'))
    .map((f) => `gedcom/${f}`),
];

/** Imports GEDCOM text or bytes into a fresh in-memory tree. */
export async function importInto(
  bytes: Uint8Array | string,
  options: ImportOptions = {},
): Promise<TreeStore> {
  const store = openMemoryTree();
  await importGedcom({ bytes }, store, { today: TODAY, ...options });
  return store;
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

/** The text of one level-0 record (by xref) in a GEDCOM document. */
export function recordText(gedcom: string, xref: string): string | undefined {
  const node = parseGedcom(gedcom).records.find((r) => r.xref === xref);
  return node && serializeGedcom({ records: [node], header: { schema: {} } }).slice(0, -1);
}

const HEAD_PATCHED = new Set(['CHAR', 'GEDC', 'SCHMA']);

/**
 * The documented normalization for comparing an export with the file it was
 * imported from: the text as decoded (no BOM, LF line endings), without
 * unparseable lines before HEAD, without the HEAD lines an export rewrites
 * (`CHAR`, `GEDC`, `SCHMA`), and with a TRLR at the end.
 */
export function normalizeGedcom(input: Uint8Array | string): string {
  const doc = parseGedcom(input);
  const records = doc.records.map((r) =>
    r.tag === 'HEAD' ? { ...r, children: r.children.filter((c) => !HEAD_PATCHED.has(c.tag)) } : r,
  );
  if (records.at(-1)?.tag !== 'TRLR') {
    records.push({ level: 0, tag: 'TRLR', children: [], line: 0 });
  }
  return serializeGedcom({ records, header: doc.header });
}

// ------------------------------------------------------------------ GEDCOM 7 checks

const NAME_TYPES = new Set([
  'AKA',
  'BIRTH',
  'IMMIGRANT',
  'MAIDEN',
  'MARRIED',
  'PROFESSIONAL',
  'OTHER',
]);
const PEDI = new Set(['ADOPTED', 'BIRTH', 'FOSTER', 'SEALING', 'OTHER']);
// GEDCOM 7 DateValue (spec 2.x, "Date"): an optional calendar decides which
// months are valid and whether the BCE epoch is allowed.
const CALENDAR_POINTS = [
  ['(?:GREGORIAN )?', 'JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC', true],
  ['JULIAN ', 'JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC', true],
  ['HEBREW ', 'TSH|CSH|KSL|TVT|SHV|ADR|ADS|NSN|IYR|SVN|TMZ|AAV|ELL', false],
  ['FRENCH_R ', 'VEND|BRUM|FRIM|NIVO|PLUV|VENT|GERM|FLOR|PRAI|MESS|THER|FRUC|COMP', false],
] as const;
const DATE_POINT = `(?:${CALENDAR_POINTS.map(
  ([calendar, months, bce]) =>
    `${calendar}(?:(?:\\d+ )?(?:${months}) )?\\d+${bce ? '(?: BCE)?' : ''}`,
).join('|')})`;
const DATE_VALUE = new RegExp(
  `^(?:(?:ABT|CAL|EST|BEF|AFT) ${DATE_POINT}|BET ${DATE_POINT} AND ${DATE_POINT}|FROM ${DATE_POINT}(?: TO ${DATE_POINT})?|TO ${DATE_POINT}|${DATE_POINT})?$`,
);
const AGE = /^(?:[<>] )?(?=\d)(?:\d+y)?(?: ?\d+m)?(?: ?\d+w)?(?: ?\d+d)?$|^$/;

/**
 * Problems that make a document invalid GEDCOM 7 (beyond what our lenient
 * parser accepts): header shape, CONC, undeclared extension tags, pointers
 * that do not resolve, and enumerations and payload grammars the exporter
 * writes. Empty means valid.
 */
export function gedcom7Problems(text: string): string[] {
  const problems: string[] = [];
  const doc = parseGedcom(text);
  if (doc.warnings.length) problems.push(...doc.warnings.map((w) => `warning: ${w.message}`));
  const head = doc.records[0];
  if (head?.tag !== 'HEAD') problems.push('first record is not HEAD');
  const vers = head?.children.find((c) => c.tag === 'GEDC')?.children.find((c) => c.tag === 'VERS');
  if (!vers?.value?.startsWith('7.0')) problems.push('HEAD.GEDC.VERS is not 7.0');
  if (doc.records.at(-1)?.tag !== 'TRLR') problems.push('last record is not TRLR');
  const schema = doc.header.schema;
  const xrefs = new Set<string>();
  for (const r of doc.records) {
    if (!r.xref) continue;
    if (xrefs.has(r.xref)) problems.push(`duplicate xref ${r.xref}`);
    xrefs.add(r.xref);
  }
  const visit = (node: GedcomNode, path: string) => {
    const at = `${path} (line ${node.line})`;
    if (node.tag === 'CONC') problems.push(`CONC at ${at}`);
    if (node.continuations?.some((c) => c.tag === 'CONC')) problems.push(`CONC under ${at}`);
    if (node.tag.startsWith('_') && !schema[node.tag]) problems.push(`undeclared ${node.tag}`);
    if (!node.tag.startsWith('_') && !GEDCOM7_TAGS.has(node.tag)) {
      problems.push(`${node.tag} is not a GEDCOM 7 tag at ${at}`);
    }
    if (node.pointer && node.pointer !== '@VOID@' && !xrefs.has(node.pointer)) {
      problems.push(`dangling pointer ${node.pointer} at ${at}`);
    }
    const v = node.value ?? '';
    if (node.tag === 'DATE' && !DATE_VALUE.test(v)) problems.push(`bad DATE "${v}" at ${at}`);
    if (node.tag === 'AGE' && !AGE.test(v)) problems.push(`bad AGE "${v}" at ${at}`);
    if (path.endsWith('NAME.TYPE') && !NAME_TYPES.has(v)) problems.push(`bad NAME.TYPE ${v}`);
    if (node.tag === 'PEDI' && !PEDI.has(v)) problems.push(`bad PEDI ${v}`);
    if (node.tag === 'SEX' && !/^[MFXU]$/.test(v)) problems.push(`bad SEX ${v}`);
    if (
      node.tag === 'RESN' &&
      !/^(CONFIDENTIAL|LOCKED|PRIVACY)(, ?(CONFIDENTIAL|LOCKED|PRIVACY))*$/.test(v)
    ) {
      problems.push(`bad RESN ${v}`);
    }
    if (path.endsWith('OBJE.FILE') && !node.children.some((c) => c.tag === 'FORM')) {
      problems.push(`FILE without FORM at ${at}`);
    }
    for (const c of node.children) visit(c, `${path}.${c.tag}`);
  };
  for (const r of doc.records) visit(r, r.tag);
  return problems;
}

// ------------------------------------------------------------------ domain snapshot

type Row = Record<string, unknown>;

/**
 * Everything a GEDCOM round trip must keep, without ids: people and families
 * keyed by xref (`xrefOf`), every other row described by its content and
 * nested under what it is attached to.
 */
export function domainSnapshot(
  store: TreeStore,
  xrefOf: (table: 'person' | 'family', id: string) => string,
  { files = false }: { files?: boolean } = {},
) {
  const all = (sql: string, ...params: unknown[]) => rows<Row>(store, sql, ...params);
  const one = (sql: string, ...params: unknown[]) => all(sql, ...params)[0];
  const notes = (type: string, id: string) =>
    all(
      `SELECT n.text FROM note_link l JOIN note n ON n.id = l.note_id
       WHERE l.owner_type = ? AND l.owner_id = ? ORDER BY l.sort_order, l.id`,
      type,
      id,
    ).map((r) => r.text);
  const tags = (type: string, id: string) =>
    all(
      `SELECT t.category || '/' || t.name AS tag FROM tag_link l JOIN tag t ON t.id = l.tag_id
       WHERE l.owner_type = ? AND l.owner_id = ? ORDER BY tag`,
      type,
      id,
    ).map((r) => r.tag);
  const media = (row: Row | undefined): Row | null => {
    if (!row) return null;
    const { kind, mime, remote_url, ancestry_oid, title, date_text, description, width, height } =
      row;
    return {
      kind,
      mime,
      remote_url,
      ancestry_oid,
      title,
      date_text,
      description,
      width,
      height,
      ...(files && { local_path: row.local_path, sha256: row.sha256, byte_size: row.byte_size }),
      notes: notes('media', row.id as string),
      tags: tags('media', row.id as string),
    };
  };
  const mediaOf = (type: string, id: string) =>
    all(
      `SELECT m.* FROM media_link l JOIN media m ON m.id = l.media_id
       WHERE l.owner_type = ? AND l.owner_id = ? ORDER BY l.sort_order, l.id`,
      type,
      id,
    ).map(media);
  const repository = (id: unknown) => {
    const r = id ? one('SELECT * FROM repository WHERE id = ?', id) : undefined;
    return r
      ? {
          name: r.name,
          address: r.address,
          url: r.url,
          email: r.email,
          phone: r.phone,
          notes: notes('repository', r.id as string),
        }
      : null;
  };
  const source = (s: Row) => ({
    title: s.title,
    author: s.author,
    publication: s.publication,
    abbreviation: s.abbreviation,
    text: s.text,
    apid: s.apid,
    call_number: s.call_number,
    repository: repository(s.repository_id),
    notes: notes('source', s.id as string),
    media: mediaOf('source', s.id as string),
  });
  const citations = (type: string, id: string) =>
    all(
      `SELECT c.* FROM citation_link l JOIN citation c ON c.id = l.citation_id
       WHERE l.owner_type = ? AND l.owner_id = ? ORDER BY l.sort_order, l.id`,
      type,
      id,
    ).map((c) => ({
      source: source(one('SELECT * FROM source WHERE id = ?', c.source_id)!),
      page: c.page,
      quality: c.quality,
      date_text: c.date_text,
      text: c.text,
      apid: c.apid,
      url: c.url,
      notes: notes('citation', c.id as string),
      media: mediaOf('citation', c.id as string),
    }));
  const attached = (type: string, id: string) => ({
    citations: citations(type, id),
    notes: notes(type, id),
    media: mediaOf(type, id),
    tags: tags(type, id),
  });
  const place = (id: unknown) => {
    const p = id ? one('SELECT * FROM place WHERE id = ?', id) : undefined;
    return p
      ? {
          full_name: p.full_name,
          latitude: p.latitude,
          longitude: p.longitude,
          notes: notes('place', p.id as string),
        }
      : null;
  };
  const events = (column: 'person_id' | 'family_id', id: string) =>
    all(
      `SELECT e.*, r.role, r.is_preferred FROM event_role r JOIN event e ON e.id = r.event_id
       WHERE r.${column} = ? ORDER BY r.sort_order, r.id`,
      id,
    ).map((e) => ({
      type: e.type,
      custom_type: e.custom_type,
      date_text: e.date_text,
      date_qualifier: e.date_qualifier,
      date_sort: e.date_sort,
      date_sort_end: e.date_sort_end,
      calendar: e.calendar,
      place: place(e.place_id),
      value: e.value,
      description: e.description,
      age: e.age,
      cause: e.cause,
      privacy: e.privacy,
      role: e.role,
      is_preferred: e.is_preferred,
      ...attached('event', e.id as string),
    }));
  const personX = (id: unknown) => (id ? xrefOf('person', id as string) : null);
  const familyX = (id: unknown) => xrefOf('family', id as string);

  const people: Record<string, unknown> = {};
  for (const p of all('SELECT * FROM person ORDER BY id')) {
    const id = p.id as string;
    people[personX(id)!] = {
      sex: p.sex,
      privacy: p.privacy,
      living: p.living,
      primaryMedia: media(one('SELECT * FROM media WHERE id = ?', p.primary_media_id)),
      names: all(
        'SELECT * FROM person_name WHERE person_id = ? ORDER BY is_primary DESC, sort_order, id',
        id,
      ).map((n) => ({
        type: n.type,
        given: n.given,
        surname: n.surname,
        surname_prefix: n.surname_prefix,
        prefix: n.prefix,
        suffix: n.suffix,
        nickname: n.nickname,
        full_text: n.full_text,
        surname_key: n.surname_key,
        is_primary: n.is_primary,
        ...attached('person_name', n.id as string),
      })),
      events: events('person_id', id),
      ...attached('person', id),
      parents: all(
        'SELECT * FROM family_child WHERE child_id = ? ORDER BY child_order, id',
        id,
      ).map((c) => ({
        family: familyX(c.family_id),
        partner1_rel: c.partner1_rel,
        partner2_rel: c.partner2_rel,
        is_preferred: c.is_preferred,
        ...attached('family_child', c.id as string),
      })),
      spouseIn: all(
        `SELECT id FROM family WHERE partner1_id = @id OR partner2_id = @id
         ORDER BY CASE WHEN partner1_id = @id THEN partner1_order ELSE partner2_order END, id`,
        { id },
      ).map((f) => familyX(f.id)),
    };
  }
  const families: Record<string, unknown> = {};
  for (const f of all('SELECT * FROM family ORDER BY id')) {
    const id = f.id as string;
    families[familyX(id)] = {
      partner1: personX(f.partner1_id),
      partner2: personX(f.partner2_id),
      relationship_type: f.relationship_type,
      privacy: f.privacy,
      events: events('family_id', id),
      children: all(
        'SELECT * FROM family_child WHERE family_id = ? ORDER BY sort_order, id',
        id,
      ).map((c) => personX(c.child_id)),
      ...attached('family', id),
    };
  }
  const sorted = (list: unknown[]) => list.map((x) => JSON.stringify(x)).sort();
  return {
    people,
    families,
    sources: sorted(all('SELECT * FROM source').map(source)),
    repositories: sorted(all('SELECT id FROM repository').map((r) => repository(r.id))),
    media: sorted(all('SELECT * FROM media').map(media)),
    notes: sorted(all('SELECT text FROM note').map((n) => n.text)),
    tags: sorted(all("SELECT category || '/' || name AS t FROM tag").map((t) => t.t)),
    places: sorted(all('SELECT id FROM place').map((p) => place(p.id))),
    home: personX(value(store, "SELECT value FROM meta WHERE key = 'home_person_id'")),
  };
}

/** Snapshot of a tree imported from an export, where xrefs are the external ids. */
export function importedSnapshot(store: TreeStore, options?: { files?: boolean }) {
  const ids = new Map<string, string>();
  for (const table of ['person', 'family'] as const) {
    for (const r of rows<{ id: string; external_id: string }>(
      store,
      `SELECT id, external_id FROM ${table}`,
    ))
      ids.set(r.id, r.external_id);
  }
  return domainSnapshot(store, (_table, id) => ids.get(id)!, options);
}
