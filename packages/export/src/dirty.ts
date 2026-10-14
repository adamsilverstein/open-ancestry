import type { TreeStore } from '@open-ancestry/db';
import { ownerKey, type TreeData } from './load';

/** Columns no GEDCOM line is written from; changing only these leaves a record verbatim. */
const IGNORED_COLUMNS = new Set(['updated_at', 'created_at', 'living', 'surname_key']);

/** Columns that name the rows a change belongs to (not rows it merely refers to). */
const OWNER_COLUMNS: Record<string, string> = {
  person_id: 'person',
  family_id: 'family',
  child_id: 'person',
  partner1_id: 'person',
  partner2_id: 'person',
};

interface LogRow {
  entity: string;
  entity_id: string;
  before_json: string | null;
  after_json: string | null;
}

/**
 * Top-level records (`person|<id>`, `family|<id>`, `source|<id>`, ...) whose
 * GEDCOM may differ from their raw_record text: anything an applied change
 * batch touched since import. Undone batches restored their rows exactly, so
 * they do not count. References to other rows (a place, a source) are not
 * followed, so editing a birth date does not regenerate everyone born in the
 * same town; a change to the place itself does.
 */
export function dirtyRecords(store: TreeStore, data: TreeData): Set<string> {
  const log = store.db
    .prepare(
      `SELECT l.entity, l.entity_id, l.before_json, l.after_json FROM change_log l
       JOIN change_batch b ON b.id = l.batch_id WHERE b.state = 'applied' ORDER BY l.seq`,
    )
    .all() as LogRow[];
  const dirty = new Set<string>();
  const seen = new Set<string>();

  const mark = (table: string, id: string | null | undefined): void => {
    if (!id) return;
    const key = ownerKey(table, id);
    if (seen.has(key)) return;
    seen.add(key);
    switch (table) {
      case 'person':
      case 'family':
        dirty.add(key);
        break;
      case 'person_name':
        mark('person', data.nameOwner.get(id));
        break;
      case 'event':
        for (const r of data.rolesByEvent.get(id) ?? []) {
          mark('person', r.person_id);
          mark('family', r.family_id);
        }
        break;
      case 'place':
        for (const e of data.eventsByPlace.get(id) ?? []) mark('event', e.id);
        break;
      case 'family_child': {
        const link = data.familyChild.get(id);
        mark('family', link?.family_id);
        mark('person', link?.child_id);
        break;
      }
      case 'citation':
        for (const l of data.citationLinksByCitation.get(id) ?? []) mark(l.owner_type, l.owner_id);
        break;
      case 'source':
      case 'repository':
      case 'tag':
        dirty.add(key);
        // Sources and repositories written inline (no record of their own) live in their users.
        if (table === 'source') {
          for (const c of data.citationsBySource.get(id) ?? []) mark('citation', c.id);
        }
        if (table === 'repository') {
          for (const s of data.sourcesByRepository.get(id) ?? []) mark('source', s.id);
        }
        break;
      case 'media':
        dirty.add(key);
        for (const l of data.mediaLinksByMedia.get(id) ?? []) mark(l.owner_type, l.owner_id);
        break;
      case 'note':
        dirty.add(key);
        for (const l of data.noteLinksByNote.get(id) ?? []) mark(l.owner_type, l.owner_id);
        break;
    }
  };

  for (const row of log) {
    const before = row.before_json
      ? (JSON.parse(row.before_json) as Record<string, unknown>)
      : null;
    const after = row.after_json ? (JSON.parse(row.after_json) as Record<string, unknown>) : null;
    if (before && after) {
      const changed = Object.keys(after).filter(
        (c) => !IGNORED_COLUMNS.has(c) && before[c] !== after[c],
      );
      if (changed.length === 0) continue;
    }
    mark(row.entity, row.entity_id);
    for (const image of [before, after]) {
      if (!image) continue;
      for (const [column, table] of Object.entries(OWNER_COLUMNS)) {
        mark(table, image[column] as string | null);
      }
      if (typeof image.owner_type === 'string') mark(image.owner_type, image.owner_id as string);
    }
  }
  return dirty;
}

/** Not nickname: full_text writes it in its own style (`"Nan"`), so a nickname edit alone keeps the text. */
const NAME_PARTS = ['given', 'surname', 'surname_prefix', 'prefix', 'suffix'];

/** How a name's imported `full_text` relates to its columns after edits. */
export type NameTextState =
  | { kind: 'stale' }
  /** `previous` is the nickname the text was written with. */
  | { kind: 'nickname'; previous: string | null };

/**
 * Names edited after `full_text` was last set (the edit API changes the
 * columns and may leave the imported text alone): `stale` when a part the
 * text spells out (given, surname, prefixes, suffix) changed, so the NAME
 * line must be built from the columns; `nickname` when only the nickname
 * changed, so the text is kept with that nickname swapped for the new one.
 */
export function nameTextStates(store: TreeStore): Map<string, NameTextState> {
  const rows = store.db
    .prepare(
      `SELECT l.entity_id, l.before_json, l.after_json FROM change_log l
       JOIN change_batch b ON b.id = l.batch_id
       WHERE b.state = 'applied' AND l.entity = 'person_name' AND l.op = 'update' ORDER BY l.seq`,
    )
    .all() as { entity_id: string; before_json: string; after_json: string }[];
  const states = new Map<string, NameTextState>();
  for (const row of rows) {
    const before = JSON.parse(row.before_json) as Record<string, unknown>;
    const after = JSON.parse(row.after_json) as Record<string, unknown>;
    if (before.full_text !== after.full_text) states.delete(row.entity_id);
    else if (NAME_PARTS.some((c) => before[c] !== after[c])) {
      states.set(row.entity_id, { kind: 'stale' });
    } else if (before.nickname !== after.nickname && !states.has(row.entity_id)) {
      states.set(row.entity_id, {
        kind: 'nickname',
        previous: (before.nickname as string | null) ?? null,
      });
    }
  }
  return states;
}
