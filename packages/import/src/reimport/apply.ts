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
import type { ReimportSession } from './session';
import { mediaKey, norm, sourceKey } from './snapshot';

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
    for (const m of tx.store.db.prepare('SELECT * FROM media').all() as MediaRow[]) {
      existingMedia.set(mediaKey(m), m.id);
    }
    const ensureMedia = (incomingId: string): string => {
      if (mediaMap.has(incomingId)) return mediaMap.get(incomingId)!;
      const m = get('media', incomingId)!;
      const key = mediaKey(m);
      // Files are not copied by a re-import; a local path is kept only if the tree has it.
      const id =
        existingMedia.get(key) ??
        insert('media', { ...plain(m), local_path: localIfPresent(tx, m) });
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
      const f = get('family', incomingFamilyId) as FamilyRow;
      const p1 = f.partner1_id ? (personMap.get(f.partner1_id) ?? null) : null;
      const p2 = f.partner2_id ? (personMap.get(f.partner2_id) ?? null) : null;
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
      applied++;
    }

    // ---------------------------------------------------------- losslessness
    // The new export's text is kept whole under its own import batch, with
    // owners pointing at the rows they became (or null when not applied).
    const ownerMap = (type: string | null, id: string | null): string | null => {
      if (!type || !id) return null;
      if (type === 'person')
        return personMap.has(id) && has('person', personMap.get(id)!) ? personMap.get(id)! : null;
      if (type === 'family') return familyFor(id, false);
      if (type === 'source') return sourceMap.get(id) ?? null;
      if (type === 'media') return mediaMap.get(id) ?? null;
      if (type === 'note') return noteMap.get(id) ?? null;
      if (type === 'tag') return tagMap.get(id) ?? null;
      if (type === 'repository') return repoMap.get(id) ?? null;
      return null;
    };
    for (const r of incAll<Row<'raw_record'>>('SELECT * FROM raw_record ORDER BY seq')) {
      const owner = ownerMap(r.owner_type, r.owner_id);
      tx.insert('raw_record', {
        ...r,
        id: undefined,
        owner_type: owner ? r.owner_type : null,
        owner_id: owner,
      } as never);
    }
    for (const u of incAll<Row<'unmapped_line'>>('SELECT * FROM unmapped_line ORDER BY line_no')) {
      const owner = ownerMap(u.owner_type, u.owner_id);
      tx.insert('unmapped_line', {
        ...u,
        id: undefined,
        owner_type: owner ? u.owner_type : null,
        owner_id: owner,
      } as never);
    }
    // Matched people now trace back to this export's records.
    for (const m of session.matches.values()) {
      const p = get('person', m.incomingId)!;
      tx.update('person', m.existingId, { external_id: p.external_id, import_batch_id: batch.id });
    }
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

function localIfPresent(tx: Tx, m: MediaRow): string | null {
  if (!m.local_path || !tx.store.dir) return null;
  const known = tx.store.stmt('SELECT 1 FROM media WHERE local_path = ?').get(m.local_path);
  return known ? m.local_path : null;
}
