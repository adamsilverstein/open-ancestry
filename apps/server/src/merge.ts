import { ancestorWord, descendantWord } from '@open-ancestry/core';
import {
  ancestorGenerations,
  meta,
  names,
  persons,
  events,
  type FamilyRow,
  type Tx,
} from '@open-ancestry/db';
import { morePrivate } from '@open-ancestry/import';
import { dropDismissalsFor } from './checks';
import { personLabel, refreshLiving, requireRow } from './edits';
import { badRequest, conflict } from './errors';

/*
 * Merging two people (#57): everything recorded for `other` moves to `keep`,
 * in one transaction (so one undo step). Facts that conflict become
 * alternates; identical ones are folded together; families that end up with
 * the same partners are combined.
 */

export type Side = 'keep' | 'other';

export interface MergeChoices {
  /** Whose primary name stays primary (the other becomes an extra name). */
  name?: Side | undefined;
  sex?: Side | undefined;
  living?: Side | undefined;
  /** Per event type, whose fact is preferred when both have one (BIRT: 'other'). */
  preferred?: Record<string, Side> | undefined;
}

/** Facts a person has once; a second one is an alternate (as the importer treats them). */
const SINGULAR = new Set(['BIRT', 'CHR', 'BAPM', 'DEAT', 'BURI', 'CREM']);

const OWNED_LINKS = ['citation_link', 'media_link', 'note_link', 'tag_link'] as const;
const LINK_TARGET = {
  citation_link: 'citation_id',
  media_link: 'media_id',
  note_link: 'note_id',
  tag_link: 'tag_id',
} as const;

interface LinkRow {
  id: string;
  owner_type: string;
  owner_id: string;
  [target: string]: string;
}

/** Re-points owned links (sources, media, notes, tags) from one owner to another, without duplicates. */
function moveLinks(tx: Tx, ownerType: string, from: string, to: string): void {
  if (from === to) return;
  for (const table of OWNED_LINKS) {
    const target = LINK_TARGET[table];
    const rows = tx.store
      .stmt(`SELECT * FROM ${table} WHERE owner_type = ? AND owner_id = ?`)
      .all(ownerType, from) as LinkRow[];
    for (const row of rows) {
      const existing = tx.store
        .stmt(`SELECT id FROM ${table} WHERE owner_type = ? AND owner_id = ? AND ${target} = ?`)
        .get(ownerType, to, row[target]);
      if (existing) tx.delete(table, row.id);
      else tx.update(table, row.id, { owner_id: to });
    }
  }
  for (const table of ['raw_record', 'unmapped_line'] as const) {
    const rows = tx.store
      .stmt(`SELECT id FROM ${table} WHERE owner_type = ? AND owner_id = ?`)
      .all(ownerType, from) as { id: string }[];
    for (const row of rows) tx.update(table, row.id, { owner_id: to });
  }
}

interface RoleRow {
  id: string;
  event_id: string;
  role: string;
  is_preferred: 0 | 1;
  type: string;
  date_text: string | null;
  place_id: string | null;
  value: string | null;
}

function roles(tx: Tx, owner: 'person_id' | 'family_id', id: string): RoleRow[] {
  return tx.store
    .stmt(
      `SELECT r.id, r.event_id, r.role, r.is_preferred, e.type, e.date_text, e.place_id, e.value
       FROM event_role r JOIN event e ON e.id = r.event_id
       WHERE r.${owner} = ? ORDER BY r.is_preferred DESC, r.sort_order, r.id`,
    )
    .all(id) as RoleRow[];
}

const sameFact = (a: RoleRow, b: RoleRow) =>
  a.type === b.type &&
  a.role === b.role &&
  (a.date_text ?? '') === (b.date_text ?? '') &&
  a.place_id === b.place_id &&
  (a.value ?? '') === (b.value ?? '');

/**
 * The same fact recorded twice: keeps `twin`'s event, with both events' sources
 * and notes, and drops `role`. When both roles are on one shared event (a
 * census listing both people), only the duplicate role goes.
 */
function foldRole(tx: Tx, role: RoleRow, twin: RoleRow) {
  tx.delete('event_role', role.id);
  if (role.event_id === twin.event_id) return;
  moveLinks(tx, 'event', role.event_id, twin.event_id);
  const shared = tx.store.stmt('SELECT 1 FROM event_role WHERE event_id = ?').get(role.event_id);
  if (!shared) events.delete(tx, role.event_id);
}

function moveEvents(tx: Tx, keepId: string, otherId: string, preferred: Record<string, Side>) {
  const kept = roles(tx, 'person_id', keepId);
  for (const role of roles(tx, 'person_id', otherId)) {
    const twin = kept.find((k) => sameFact(k, role));
    if (twin) {
      foldRole(tx, role, twin);
      continue;
    }
    const rival =
      role.role === 'principal' && SINGULAR.has(role.type)
        ? kept.find((k) => k.role === 'principal' && k.type === role.type && k.is_preferred === 1)
        : undefined;
    let isPreferred: 0 | 1 = role.is_preferred;
    if (rival) {
      // Conflicting single facts: the chosen one is preferred, the other an alternate.
      const otherWins = preferred[role.type] === 'other' && role.is_preferred === 1;
      if (otherWins) tx.update('event_role', rival.id, { is_preferred: 0 });
      isPreferred = otherWins ? 1 : 0;
    }
    tx.update('event_role', role.id, { person_id: keepId, is_preferred: isPreferred });
  }
}

function moveNames(tx: Tx, keepId: string, otherId: string, nameSide: Side) {
  const keepNames = names.list(tx.store, keepId);
  const fields = [
    'type',
    'prefix',
    'given',
    'surname_prefix',
    'surname',
    'suffix',
    'nickname',
  ] as const;
  let promote: string | null = null;
  for (const name of names.list(tx.store, otherId)) {
    const twin = keepNames.find((k) => fields.every((f) => (k[f] ?? '') === (name[f] ?? '')));
    if (twin) {
      if (name.is_primary === 1 && nameSide === 'other') promote = twin.id;
      moveLinks(tx, 'person_name', name.id, twin.id);
      tx.delete('person_name', name.id);
      continue;
    }
    if (name.is_primary === 1 && nameSide === 'other') promote = name.id;
    tx.update('person_name', name.id, {
      person_id: keepId,
      is_primary: 0,
      sort_order: keepNames.length + name.sort_order,
    });
  }
  if (promote) names.setPrimary(tx, promote);
}

/** Folds `from` into `into`: children, events and links move, then `from` is deleted. */
function foldFamily(tx: Tx, into: string, from: string) {
  const children = tx.store.stmt('SELECT * FROM family_child WHERE family_id = ?').all(from) as {
    id: string;
    child_id: string;
  }[];
  for (const link of children) {
    const already = tx.store
      .stmt('SELECT id FROM family_child WHERE family_id = ? AND child_id = ?')
      .get(into, link.child_id) as { id: string } | undefined;
    if (already) {
      moveLinks(tx, 'family_child', link.id, already.id);
      tx.delete('family_child', link.id);
    } else tx.update('family_child', link.id, { family_id: into });
  }
  // Facts both families recorded (the same marriage) fold into one event.
  const kept = roles(tx, 'family_id', into);
  for (const role of roles(tx, 'family_id', from)) {
    const twin = kept.find((k) => sameFact(k, role));
    if (twin) foldRole(tx, role, twin);
    else tx.update('event_role', role.id, { family_id: into });
  }
  moveLinks(tx, 'family', from, into);
  tx.delete('family', from);
}

/** Combines families that now have the same two partners. */
function foldDuplicateFamilies(tx: Tx, personId: string) {
  const families = tx.store
    .stmt(
      `SELECT * FROM family WHERE partner1_id = @id OR partner2_id = @id
       UNION SELECT f.* FROM family f JOIN family_child fc ON fc.family_id = f.id
       WHERE fc.child_id = @id`,
    )
    .all({ id: personId }) as FamilyRow[];
  const byPair = new Map<string, string>();
  for (const family of families) {
    if (!tx.store.getRow('family', family.id)) continue;
    const pair = [family.partner1_id, family.partner2_id].sort().join('+');
    if (pair === '+') continue;
    const first = byPair.get(pair);
    if (first) foldFamily(tx, first, family.id);
    else byPair.set(pair, family.id);
  }
}

function moveFamilies(tx: Tx, keepId: string, otherId: string) {
  const partnered = tx.store
    .stmt('SELECT * FROM family WHERE partner1_id = @id OR partner2_id = @id')
    .all({ id: otherId }) as FamilyRow[];
  for (const family of partnered) {
    const slot = family.partner1_id === otherId ? 'partner1_id' : 'partner2_id';
    const partner = slot === 'partner1_id' ? family.partner2_id : family.partner1_id;
    if (partner === keepId) {
      throw conflict(
        'These two people are partners in a family; merging them would make someone their own partner',
      );
    }
    tx.update('family', family.id, { [slot]: keepId });
  }
  const keepHasParents = tx.store.stmt('SELECT 1 FROM family_child WHERE child_id = ?').get(keepId);
  const asChild = tx.store
    .stmt('SELECT * FROM family_child WHERE child_id = ? ORDER BY child_order')
    .all(otherId) as { id: string; family_id: string; is_preferred: 0 | 1 }[];
  for (const link of asChild) {
    const already = tx.store
      .stmt('SELECT id FROM family_child WHERE family_id = ? AND child_id = ?')
      .get(link.family_id, keepId) as { id: string } | undefined;
    if (already) {
      moveLinks(tx, 'family_child', link.id, already.id);
      tx.delete('family_child', link.id);
    } else {
      // Keep's own preferred parent set stays preferred.
      tx.update('family_child', link.id, {
        child_id: keepId,
        is_preferred: keepHasParents ? 0 : link.is_preferred,
      });
    }
  }
  foldDuplicateFamilies(tx, keepId);
}

/**
 * Refuses merging a person with their own ancestor or descendant, which would
 * make the merged person their own parent or grandparent (#95). Any loop a
 * merge could create runs through such a line, so this is the only check needed.
 */
function refuseLineal(tx: Tx, keepId: string, otherId: string) {
  const down = ancestorGenerations(tx.store, keepId, otherId);
  const up = down === null ? ancestorGenerations(tx.store, otherId, keepId) : null;
  if (down === null && up === null) return;
  const word = down !== null ? descendantWord(down, undefined) : ancestorWord(up!, undefined);
  throw conflict(
    `${personLabel(tx.store, otherId)} is a ${word} of ${personLabel(tx.store, keepId)}; ` +
      'a person cannot be merged with their own ancestor or descendant',
  );
}

/** Merges `otherId` into `keepId` inside the caller's transaction. */
export function mergePeople(tx: Tx, keepId: string, otherId: string, choices: MergeChoices = {}) {
  if (keepId === otherId) throw badRequest('Choose two different people to merge');
  const keep = requireRow(tx.store, 'person', keepId);
  const other = requireRow(tx.store, 'person', otherId);
  refuseLineal(tx, keepId, otherId);

  moveFamilies(tx, keepId, otherId);
  moveNames(tx, keepId, otherId, choices.name ?? 'keep');
  moveEvents(tx, keepId, otherId, choices.preferred ?? {});
  moveLinks(tx, 'person', otherId, keepId);

  const patch: Record<string, unknown> = {};
  if (choices.sex === 'other') patch.sex = other.sex;
  if (choices.living === 'other') patch.living = other.living;
  // The stricter privacy wins, so nothing private becomes public by merging.
  const privacy = morePrivate(other.privacy, keep.privacy);
  if (privacy !== keep.privacy) patch.privacy = privacy;
  if (!keep.primary_media_id && other.primary_media_id) {
    patch.primary_media_id = other.primary_media_id;
  }
  if (Object.keys(patch).length > 0) persons.update(tx, keepId, patch);
  const wasHome = meta.getHomePersonId(tx.store) === otherId;

  dropDismissalsFor(tx, otherId);
  persons.delete(tx, otherId);
  if (wasHome) meta.set(tx, 'home_person_id', keepId);
  refreshLiving(tx, [keepId]);
  return tx.store.getRow('person', keepId)!;
}
