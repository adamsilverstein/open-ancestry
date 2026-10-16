import {
  familyChildren,
  type EventRow,
  type FamilyRow,
  type MediaRow,
  type PlaceRow,
  type SourceRow,
  type TableName,
  type TableRows,
  type TreeStore,
  type Tx,
} from '@open-ancestry/db';
import { BASE_KEY, imageOfView } from './diff';
import type { ReimportSession } from './session';
import { mediaKeys, norm, sourceKey } from './snapshot';

/*
 * Applies the changes a user accepted as one unit of work, so a single undo
 * reverts the whole re-import. Rows are copied from the incoming (memory)
 * tree; places, sources, repositories, tags and media are reused when the
 * tree already has them.
 */

export class ReimportStaleError extends Error {
  constructor() {
    super('The tree changed since this re-import was reviewed; review it again');
    this.name = 'ReimportStaleError';
  }
}

export interface ApplyResult {
  batchId: string;
  applied: number;
  skipped: number;
  /** Changes not applied because a change they depend on was rejected. */
  blocked: string[];
}

/**
 * A signature of the tree's history, so apply can tell whether the tree moved
 * since the review. Undo and redo add no batch, so the signature also covers
 * batch states and when they last changed.
 */
export const treeRevision = (store: TreeStore): string => {
  const row = store.db
    .prepare(
      `SELECT max(id) AS id, count(*) AS n, sum(state != 'applied') AS off,
              max(state_changed_at) AS changed
         FROM change_batch`,
    )
    .get() as { id: string | null; n: number; off: number | null; changed: string | null };
  const seq = store.db.prepare('SELECT max(seq) FROM change_log').pluck().get() as number | null;
  return [row.id ?? '', row.n, row.off ?? 0, row.changed ?? '', seq ?? 0].join('|');
};

type Row<T extends TableName> = TableRows[T];
type Writable = Record<string, unknown>;

/** A row without its timestamps, which the unit of work sets. */
function plain<T extends object>(row: T): Writable {
  const { created_at: _c, updated_at: _u, ...rest } = row as Writable;
  void _c;
  void _u;
  return rest;
}

export function applyReimport(
  store: TreeStore,
  session: ReimportSession,
  accepted: ReadonlySet<string>,
  label: string,
): ApplyResult {
  if (treeRevision(store) !== session.baseRevision) throw new ReimportStaleError();
  const inc = session.incoming;
  const changes = session.diff.people.flatMap((p) => p.changes);
  const chosen = new Set(
    changes.filter((c) => c.applicable && accepted.has(c.id)).map((c) => c.id),
  );
  // A change whose prerequisite (a new person) was rejected cannot be applied.
  const blocked: string[] = [];
  let settled = false;
  while (!settled) {
    settled = true;
    for (const c of changes) {
      if (chosen.has(c.id) && c.requires?.some((r) => !chosen.has(r))) {
        chosen.delete(c.id);
        blocked.push(c.id);
        settled = false;
      }
    }
  }
  const toApply = changes.filter((c) => chosen.has(c.id));

  const get = <T extends TableName>(table: T, id: string) =>
    inc.getRow(table, id) as Row<T> | undefined;
  const incAll = <T>(sql: string, ...params: unknown[]) =>
    inc.db.prepare(sql).all(...params) as T[];

  const { batchId } = store.transact(label, (tx) => {
    const has = (table: TableName, id: string) => !!tx.store.getRow(table, id);
    const insert = <T extends TableName>(table: T, row: Writable): string => {
      const id = row.id as string | undefined;
      // Incoming ids are fresh ULIDs; reuse them unless (rarely) already taken.
      const input = id && has(table, id) ? { ...row, id: undefined } : row;
      return (tx.insert(table, input as never) as { id: string }).id;
    };

    // ---------------------------------------------------------- shared rows
    const personMap = new Map<string, string>();
    for (const m of session.matches.values()) personMap.set(m.incomingId, m.existingId);
    for (const c of toApply) if (c.kind === 'person.new') personMap.set(c.incomingId, c.incomingId);

    const batch = inc.db.prepare('SELECT * FROM import_batch').get() as Row<'import_batch'>;
    tx.insert('import_batch', { ...batch });

    const placeMap = new Map<string, string>();
    const ensurePlace = (incomingId: string | null): string | null => {
      if (!incomingId) return null;
      const known = placeMap.get(incomingId);
      if (known) return known;
      const p = get('place', incomingId) as PlaceRow;
      const existing = tx.store
        .stmt('SELECT id FROM place WHERE full_name = ? ORDER BY id LIMIT 1')
        .get(p.full_name) as { id: string } | undefined;
      const id =
        existing?.id ?? insert('place', { ...plain(p), parent_id: ensurePlace(p.parent_id) });
      placeMap.set(incomingId, id);
      return id;
    };

    const repoMap = new Map<string, string>();
    const ensureRepository = (incomingId: string | null): string | null => {
      if (!incomingId) return null;
      if (repoMap.has(incomingId)) return repoMap.get(incomingId)!;
      const r = get('repository', incomingId)!;
      const existing = tx.store
        .stmt('SELECT id FROM repository WHERE name = ? ORDER BY id LIMIT 1')
        .get(r.name) as { id: string } | undefined;
      const id = existing?.id ?? insert('repository', plain(r));
      repoMap.set(incomingId, id);
      return id;
    };

    const sourceMap = new Map<string, string>();
    const existingSources = new Map<string, string>();
    for (const s of tx.store.db
      .prepare('SELECT id, title, apid FROM source')
      .all() as SourceRow[]) {
      existingSources.set(sourceKey(s.title, s.apid), s.id);
    }
    const ensureSource = (incomingId: string): string => {
      if (sourceMap.has(incomingId)) return sourceMap.get(incomingId)!;
      const s = get('source', incomingId)!;
      const key = sourceKey(s.title, s.apid);
      const id =
        existingSources.get(key) ??
        insert('source', { ...plain(s), repository_id: ensureRepository(s.repository_id) });
      existingSources.set(key, id);
      sourceMap.set(incomingId, id);
      return id;
    };

    const tagMap = new Map<string, string>();
    const ensureTag = (incomingId: string): string => {
      if (tagMap.has(incomingId)) return tagMap.get(incomingId)!;
      const t = get('tag', incomingId)!;
      const existing = (
        tx.store.db.prepare('SELECT id, name, category FROM tag').all() as Row<'tag'>[]
      ).find((x) => norm(x.name) === norm(t.name) && norm(x.category) === norm(t.category));
      const id = existing?.id ?? insert('tag', plain(t));
      tagMap.set(incomingId, id);
      return id;
    };

    const mediaMap = new Map<string, string>();
    const existingMedia = new Map<string, string>();
    const existingKey = mediaKeys(tx.store);
    const incomingKey = mediaKeys(inc);
    for (const m of tx.store.db.prepare('SELECT * FROM media').all() as MediaRow[]) {
      existingMedia.set(existingKey(m), m.id);
    }
    /** Existing media already matched to an incoming row. */
    const claimed = new Set<string>();
    const ensureMedia = (incomingId: string): string => {
      if (mediaMap.has(incomingId)) return mediaMap.get(incomingId)!;
      const m = get('media', incomingId)!;
      const key = incomingKey(m);
      // Files are not copied by a re-import; a local path is kept only if the tree has it.
      // Two incoming media never share one row: the second one's lines would replace the first's.
      const match = existingMedia.get(key);
      const id =
        match && !claimed.has(match)
          ? match
          : insert('media', { ...plain(m), local_path: localIfPresent(tx, m) });
      claimed.add(id);
      existingMedia.set(key, id);
      mediaMap.set(incomingId, id);
      return id;
    };

    const link = (
      table: 'citation_link' | 'media_link' | 'note_link' | 'tag_link',
      column: string,
      target: string,
      ownerType: string,
      ownerId: string,
    ) => {
      const exists = tx.store
        .stmt(`SELECT 1 FROM ${table} WHERE ${column} = ? AND owner_type = ? AND owner_id = ?`)
        .get(target, ownerType, ownerId);
      if (exists) return;
      const row: Writable = { [column]: target, owner_type: ownerType, owner_id: ownerId };
      if (table !== 'tag_link') {
        row.sort_order = (
          tx.store
            .stmt(
              `SELECT coalesce(max(sort_order) + 1, 0) AS n FROM ${table} WHERE owner_type = ? AND owner_id = ?`,
            )
            .get(ownerType, ownerId) as { n: number }
        ).n;
      }
      tx.insert(table, row as never);
    };

    const noteMap = new Map<string, string>();
    const copyAttachments = (
      incomingOwnerType: string,
      incomingOwnerId: string,
      ownerType: string,
      ownerId: string,
    ) => {
      for (const l of incAll<Row<'citation_link'>>(
        'SELECT * FROM citation_link WHERE owner_type = ? AND owner_id = ? ORDER BY sort_order',
        incomingOwnerType,
        incomingOwnerId,
      )) {
        link('citation_link', 'citation_id', copyCitation(l.citation_id), ownerType, ownerId);
      }
      for (const l of incAll<Row<'note_link'>>(
        'SELECT * FROM note_link WHERE owner_type = ? AND owner_id = ? ORDER BY sort_order',
        incomingOwnerType,
        incomingOwnerId,
      )) {
        let id = noteMap.get(l.note_id);
        if (!id) {
          id = insert('note', plain(get('note', l.note_id)!));
          noteMap.set(l.note_id, id);
        }
        link('note_link', 'note_id', id, ownerType, ownerId);
      }
      if (['person', 'event', 'family', 'source', 'citation', 'place'].includes(ownerType)) {
        for (const l of incAll<Row<'media_link'>>(
          'SELECT * FROM media_link WHERE owner_type = ? AND owner_id = ? ORDER BY sort_order',
          incomingOwnerType,
          incomingOwnerId,
        )) {
          link('media_link', 'media_id', ensureMedia(l.media_id), ownerType, ownerId);
        }
      }
      if (['person', 'event', 'family', 'source', 'media'].includes(ownerType)) {
        for (const l of incAll<Row<'tag_link'>>(
          'SELECT * FROM tag_link WHERE owner_type = ? AND owner_id = ?',
          incomingOwnerType,
          incomingOwnerId,
        )) {
          link('tag_link', 'tag_id', ensureTag(l.tag_id), ownerType, ownerId);
        }
      }
    };

    const citationMap = new Map<string, string>();
    const copyCitation = (incomingId: string): string => {
      if (citationMap.has(incomingId)) return citationMap.get(incomingId)!;
      const c = get('citation', incomingId)!;
      const id = insert('citation', { ...plain(c), source_id: ensureSource(c.source_id) });
      citationMap.set(incomingId, id);
      for (const l of incAll<Row<'note_link'>>(
        "SELECT * FROM note_link WHERE owner_type = 'citation' AND owner_id = ?",
        incomingId,
      )) {
        const note = insert('note', plain(get('note', l.note_id)!));
        link('note_link', 'note_id', note, 'citation', id);
      }
      return id;
    };

    const nextOrder = (column: 'person_id' | 'family_id', ownerId: string) =>
      (
        tx.store
          .stmt(`SELECT coalesce(max(sort_order) + 1, 0) AS n FROM event_role WHERE ${column} = ?`)
          .get(ownerId) as { n: number }
      ).n;

    const copyEvent = (incomingId: string, owner: { person?: string; family?: string }) => {
      const e = get('event', incomingId) as EventRow;
      const id = insert('event', { ...plain(e), place_id: ensurePlace(e.place_id) });
      const role = incAll<Row<'event_role'>>(
        'SELECT * FROM event_role WHERE event_id = ?',
        incomingId,
      )[0];
      tx.insert('event_role', {
        event_id: id,
        person_id: owner.person ?? null,
        family_id: owner.family ?? null,
        role: role?.role ?? 'principal',
        is_preferred: role?.is_preferred ?? 1,
        sort_order: nextOrder(
          owner.person ? 'person_id' : 'family_id',
          (owner.person ?? owner.family)!,
        ),
      });
      copyAttachments('event', incomingId, 'event', id);
      return id;
    };

    const copyPerson = (incomingId: string) => {
      const p = get('person', incomingId)!;
      insert('person', { ...plain(p), primary_media_id: null });
      for (const n of incAll<Row<'person_name'>>(
        'SELECT * FROM person_name WHERE person_id = ? ORDER BY sort_order',
        incomingId,
      )) {
        const nameId = insert('person_name', { ...n });
        copyAttachments('person_name', n.id, 'person_name', nameId);
      }
      for (const r of incAll<Row<'event_role'>>(
        'SELECT * FROM event_role WHERE person_id = ? ORDER BY sort_order',
        incomingId,
      )) {
        copyEvent(r.event_id, { person: incomingId });
      }
      copyAttachments('person', incomingId, 'person', incomingId);
      if (p.primary_media_id)
        tx.update('person', incomingId, { primary_media_id: ensureMedia(p.primary_media_id) });
    };

    // ---------------------------------------------------------- families
    const familyKey = (a: string | null, b: string | null) =>
      [a, b].filter(Boolean).sort().join('+');
    const familyMap = new Map<string, string>();
    const familiesByPartners = new Map<string, string>();
    for (const f of tx.store.db
      .prepare('SELECT id, partner1_id, partner2_id FROM family')
      .all() as FamilyRow[]) {
      const key = familyKey(f.partner1_id, f.partner2_id);
      if (!familiesByPartners.has(key)) familiesByPartners.set(key, f.id);
    }
    const familyFor = (incomingFamilyId: string, create: boolean): string | null => {
      if (familyMap.has(incomingFamilyId)) return familyMap.get(incomingFamilyId)!;
      // The family the review matched it to (also when the export dropped a partner).
      const matched = session.diff.familyMatches[incomingFamilyId];
      if (matched && has('family', matched)) {
        familyMap.set(incomingFamilyId, matched);
        return matched;
      }
      const f = get('family', incomingFamilyId) as FamilyRow;
      const p1 = f.partner1_id ? (personMap.get(f.partner1_id) ?? null) : null;
      const p2 = f.partner2_id ? (personMap.get(f.partner2_id) ?? null) : null;
      // A partner who was not added: never mistake the rest for a single-parent family.
      if ((f.partner1_id && !p1) || (f.partner2_id && !p2)) return null;
      const existing = familiesByPartners.get(familyKey(p1, p2));
      if (existing) {
        familyMap.set(incomingFamilyId, existing);
        return existing;
      }
      if (!create) return null;
      const order = (person: string | null) =>
        person
          ? (
              tx.store
                .stmt(`SELECT count(*) AS n FROM family WHERE partner1_id = ? OR partner2_id = ?`)
                .get(person, person) as { n: number }
            ).n
          : 0;
      const id = insert('family', {
        ...plain(f),
        partner1_id: p1,
        partner2_id: p2,
        partner1_order: order(p1),
        partner2_order: order(p2),
      });
      familyMap.set(incomingFamilyId, id);
      familiesByPartners.set(familyKey(p1, p2), id);
      for (const r of incAll<Row<'event_role'>>(
        'SELECT * FROM event_role WHERE family_id = ? ORDER BY sort_order',
        incomingFamilyId,
      )) {
        copyEvent(r.event_id, { family: id });
      }
      copyAttachments('family', incomingFamilyId, 'family', id);
      return id;
    };

    // ---------------------------------------------------------- the changes
    const owners = new Map<string, string | null>();
    for (const p of session.diff.people) {
      for (const c of p.changes) owners.set(c.id, p.existingId ?? p.incomingId);
    }
    let applied = 0;
    /** Changes whose rows this batch wrote: those rows are the next comparison's base. */
    const written = new Set<string>();
    for (const c of toApply.filter((x) => x.kind === 'person.new')) {
      copyPerson((c as { incomingId: string }).incomingId);
      applied++;
    }
    for (const c of toApply) {
      const person = owners.get(c.id) ?? null;
      switch (c.kind) {
        case 'person.new':
          continue;
        case 'sex':
          tx.update('person', person!, { sex: c.after as Row<'person'>['sex'] });
          break;
        case 'name.add': {
          const n = get('person_name', c.incomingNameId)!;
          const order = (
            tx.store
              .stmt(
                'SELECT coalesce(max(sort_order) + 1, 0) AS n FROM person_name WHERE person_id = ?',
              )
              .get(person) as { n: number }
          ).n;
          insert('person_name', {
            ...n,
            id: undefined,
            person_id: person,
            is_primary: 0,
            sort_order: order,
          });
          break;
        }
        case 'fact.add':
          if (c.owner === 'family') copyEvent(c.incomingEventId, { family: c.familyKey! });
          else copyEvent(c.incomingEventId, { person: person! });
          break;
        case 'fact.change': {
          const e = get('event', c.incomingEventId) as EventRow;
          tx.update('event', c.existingEventId, {
            custom_type: e.custom_type,
            date_text: e.date_text,
            date_qualifier: e.date_qualifier,
            date_sort: e.date_sort,
            date_sort_end: e.date_sort_end,
            calendar: e.calendar,
            place_id: ensurePlace(e.place_id),
            value: e.value,
            age: e.age,
            cause: e.cause,
          });
          break;
        }
        case 'citation.add':
          link(
            'citation_link',
            'citation_id',
            copyCitation(c.incomingCitationId),
            c.existingEventId ? 'event' : 'person',
            c.existingEventId ?? person!,
          );
          break;
        case 'tag.add':
          link('tag_link', 'tag_id', ensureTag(c.incomingTagId), 'person', person!);
          break;
        case 'media.add':
          link('media_link', 'media_id', ensureMedia(c.incomingMediaId), 'person', person!);
          break;
        case 'family.add':
          familyFor(c.incomingFamilyId, true);
          break;
        case 'child.add': {
          const familyId = familyFor(c.incomingFamilyId, true)!;
          const child = personMap.get(c.incomingChildId)!;
          const incomingLink = incAll<Row<'family_child'>>(
            'SELECT * FROM family_child WHERE family_id = ? AND child_id = ?',
            c.incomingFamilyId,
            c.incomingChildId,
          )[0];
          const exists = tx.store
            .stmt('SELECT 1 FROM family_child WHERE family_id = ? AND child_id = ?')
            .get(familyId, child);
          if (!exists) {
            familyChildren.create(tx, {
              family_id: familyId,
              child_id: child,
              partner1_rel: incomingLink?.partner1_rel ?? 'biological',
              partner2_rel: incomingLink?.partner2_rel ?? 'biological',
              sort_order: (
                tx.store
                  .stmt(
                    'SELECT coalesce(max(sort_order) + 1, 0) AS n FROM family_child WHERE family_id = ?',
                  )
                  .get(familyId) as { n: number }
              ).n,
            });
          }
          break;
        }
      }
      written.add(c.id);
      applied++;
    }

    // ---------------------------------------------------------- losslessness
    // The new export's text is kept whole under its own import batch, with
    // owners pointing at the rows they are now (looked up, never created).
    // The exporter copies a record verbatim only while its owner is clean, so
    // owners whose text no longer matches the tree are listed as stale for it.
    const stale = new Set<string>();
    const findRow = (type: string, id: string): string | null => {
      switch (type) {
        case 'person': {
          const mapped = personMap.get(id);
          return mapped && has('person', mapped) ? mapped : null;
        }
        case 'family':
          return familyFor(id, false);
        case 'source': {
          const s = get('source', id);
          return (
            sourceMap.get(id) ??
            (s ? (existingSources.get(sourceKey(s.title, s.apid)) ?? null) : null)
          );
        }
        case 'repository': {
          const r = get('repository', id);
          if (repoMap.has(id) || !r) return repoMap.get(id) ?? null;
          return (
            (
              tx.store
                .stmt('SELECT id FROM repository WHERE name = ? ORDER BY id LIMIT 1')
                .get(r.name) as { id: string } | undefined
            )?.id ?? null
          );
        }
        case 'media': {
          const m = get('media', id);
          return mediaMap.get(id) ?? (m ? (existingMedia.get(incomingKey(m)) ?? null) : null);
        }
        case 'note': {
          const n = get('note', id);
          if (noteMap.has(id) || !n) return noteMap.get(id) ?? null;
          return (
            (
              tx.store
                .stmt('SELECT id FROM note WHERE text = ? ORDER BY id LIMIT 1')
                .get(n.text) as { id: string } | undefined
            )?.id ?? null
          );
        }
        case 'tag': {
          const t = get('tag', id);
          if (tagMap.has(id) || !t) return tagMap.get(id) ?? null;
          return (
            (tx.store.db.prepare('SELECT id, name, category FROM tag').all() as Row<'tag'>[]).find(
              (x) => norm(x.name) === norm(t.name) && norm(x.category) === norm(t.category),
            )?.id ?? null
          );
        }
      }
      return null;
    };
    const ownerRows = new Map<string, string | null>();
    const ownerOf = (type: string | null, id: string | null): string | null => {
      if (!type || !id) return null;
      const key = `${type}|${id}`;
      if (!ownerRows.has(key)) {
        const found = findRow(type, id);
        ownerRows.set(key, found);
        if (found && type !== 'person' && type !== 'family' && differs(type, id, found)) {
          stale.add(`${type}|${found}`);
        }
      }
      return ownerRows.get(key)!;
    };
    /** Whether a reused source, repository, note, tag or media row says something else. */
    const differs = (type: string, incomingId: string, existingId: string) => {
      const a = get(type as TableName, incomingId) as unknown as Writable;
      const b = tx.store.getRow(type as TableName, existingId) as unknown as Writable;
      return Object.keys(a).some(
        (k) => !SAME_ANYWAY.has(k) && !k.endsWith('_id') && (a[k] ?? null) !== (b[k] ?? null),
      );
    };
    // People and families whose new text says something the tree does not
    // (a rejected or conflicting change, a missing fact or relationship).
    for (const person of session.diff.people) {
      if (!person.existingId || !person.changes.length) continue;
      const pending = person.changes.some((c) => !chosen.has(c.id));
      if (pending) stale.add(`person|${person.existingId}`);
      for (const c of person.changes) {
        if (chosen.has(c.id)) continue;
        if (c.kind === 'family.missing' || c.kind === 'child.missing') {
          stale.add(`family|${c.existingFamilyId}`);
        } else if (c.kind === 'fact.add' && c.familyKey) {
          stale.add(`family|${c.familyKey}`);
        }
      }
    }
    // Differences nothing was offered for, because the user's own change stands.
    for (const key of session.diff.held) stale.add(key);
    for (const c of changes) {
      if (chosen.has(c.id) || (c.kind !== 'family.add' && c.kind !== 'child.add')) continue;
      const family = familyFor(c.incomingFamilyId, false);
      if (family) stale.add(`family|${family}`);
    }

    for (const r of incAll<Row<'raw_record'>>('SELECT * FROM raw_record ORDER BY seq')) {
      const owner = ownerOf(r.owner_type, r.owner_id);
      // A record the user did not take (a rejected new person) is not part of the tree.
      if (r.owner_type && !owner) continue;
      tx.insert('raw_record', {
        ...r,
        id: undefined,
        owner_id: owner,
      } as never);
    }
    // Unmapped lines replace the tree's for the same owner, unless they are the same.
    const linesOf = (rows: Row<'unmapped_line'>[]) =>
      rows.map((u) => `${u.path}\u0000${u.line}`).join('\n');
    const incomingLines = new Map<string, Row<'unmapped_line'>[]>();
    for (const u of incAll<Row<'unmapped_line'>>('SELECT * FROM unmapped_line ORDER BY line_no')) {
      const owner = ownerOf(u.owner_type, u.owner_id);
      if (u.owner_type && !owner) continue;
      const key = owner ? `${u.owner_type}|${owner}` : '';
      incomingLines.set(key, [...(incomingLines.get(key) ?? []), { ...u, owner_id: owner }]);
    }
    for (const [key, lines] of incomingLines) {
      const [type, id] = key ? key.split('|') : [null, null];
      const old = (
        type
          ? tx.store
              .stmt(
                'SELECT * FROM unmapped_line WHERE owner_type = ? AND owner_id = ? ORDER BY line_no',
              )
              .all(type, id)
          : []
      ) as Row<'unmapped_line'>[];
      if (type && linesOf(old) === linesOf(lines)) continue;
      for (const u of old) tx.delete('unmapped_line', u.id);
      for (const u of lines) tx.insert('unmapped_line', { ...u, id: undefined } as never);
    }
    recordStale(tx, batch.id, stale);
    recordBase(tx, batch.id, session, written, incAll);
    return applied;
  }) as { batchId: string; result: number };

  const appliedCount = toApply.length;
  return {
    batchId,
    applied: appliedCount,
    skipped: changes.filter((c) => c.applicable).length - appliedCount,
    blocked,
  };
}

/** Columns that differ between a reused row and its incoming copy without changing what it says. */
const SAME_ANYWAY = new Set([
  'id',
  'created_at',
  'updated_at',
  'external_id',
  'local_path',
  'sha256',
  'width',
  'height',
  'byte_size',
  'mime',
]);

/**
 * What the export said for each row it offered a change to whose row this
 * batch did not write: the base of the next re-import's three-way comparison
 * (#224). Without it a declined change would come back as a conflict every
 * time. A written row needs none, since the write is its base; a change that
 * was chosen but wrote nothing (a refused copy) keeps its image.
 * Written in the re-import's batch, so undo removes it.
 *
 * One meta row per re-import, never pruned: `localHistory` reads these from
 * the change log, where later batches' images replace earlier ones row by row,
 * and deleting an old meta row would only log a copy of it.
 */
function recordBase(
  tx: Tx,
  importBatchId: string,
  session: ReimportSession,
  written: ReadonlySet<string>,
  incAll: <T>(sql: string, ...params: unknown[]) => T[],
) {
  const images: Record<string, unknown> = {};
  for (const person of session.diff.people) {
    for (const c of person.changes) {
      if (written.has(c.id)) continue;
      if (c.kind === 'fact.change') images[`event|${c.existingEventId}`] = imageOfView(c.after);
      else if (c.kind === 'fact.add' && c.deletedEventId) {
        images[`event|${c.deletedEventId}`] = imageOfView(c.fact);
      } else if (c.kind === 'sex' && person.existingId) {
        images[`person|${person.existingId}`] = { sex: c.after };
      } else if (c.kind === 'name.add' && person.existingId && person.incomingId) {
        images[`names|${person.existingId}`] = {
          names: incAll<{ given: string | null; surname: string | null }>(
            'SELECT given, surname FROM person_name WHERE person_id = ?',
            person.incomingId,
          ).map((n) => norm([n.given, n.surname].filter(Boolean).join(' '))),
        };
      }
    }
  }
  if (Object.keys(images).length) {
    tx.insert('meta', {
      key: `${BASE_KEY}${importBatchId}`,
      value: JSON.stringify(images),
    } as never);
  }
}

/** Meta key listing records the exporter must not copy verbatim from an import batch. */
export const staleKey = (importBatchId: string) => `export.stale:${importBatchId}`;

function recordStale(tx: Tx, importBatchId: string, stale: Set<string>) {
  // The exporter only reads the newest import's list; older ones would only pile up.
  const old = tx.store
    .stmt("SELECT key FROM meta WHERE key LIKE 'export.stale:%'")
    .pluck()
    .all() as string[];
  for (const key of old) tx.delete('meta', key);
  if (stale.size) {
    tx.insert('meta', {
      key: staleKey(importBatchId),
      value: JSON.stringify([...stale].sort()),
    } as never);
  }
}

function localIfPresent(tx: Tx, m: MediaRow): string | null {
  if (!m.local_path || !tx.store.dir) return null;
  const known = tx.store.stmt('SELECT 1 FROM media WHERE local_path = ?').get(m.local_path);
  return known ? m.local_path : null;
}
