import type { CitationOwner, MediaOwner, NoteOwner, TagOwner } from './enums';
import { NotFoundError, type TreeStore, type Tx } from './store';
import type {
  CitationLinkRow,
  EventRoleRow,
  FamilyChildRow,
  FamilyRow,
  InsertRow,
  MediaLinkRow,
  NoteLinkRow,
  PatchRow,
  PersonNameRow,
  TableName,
  TableRows,
  TagLinkRow,
  TagRow,
} from './types';

/*
 * Repositories: typed create/read/update/delete for each aggregate. Reads take
 * the store; writes take the Tx from `store.transact`, so every write (including
 * cascades, which are explicit here rather than ON DELETE actions) is logged.
 */

function crud<T extends TableName>(table: T) {
  return {
    get: (store: TreeStore, id: string): TableRows[T] | undefined => store.getRow(table, id),
    create: (tx: Tx, input: InsertRow<T>): TableRows[T] => tx.insert(table, input),
    update: (tx: Tx, id: string, patch: PatchRow<T>): TableRows[T] => tx.update(table, id, patch),
    delete: (tx: Tx, id: string): TableRows[T] => tx.delete(table, id),
  };
}

function all<R>(store: TreeStore, sql: string, ...params: unknown[]): R[] {
  return store.stmt(sql).all(...params) as R[];
}

/** Deletes rows that hang off an owner: citation/media/note/tag links and preserved GEDCOM. */
function deleteOwned(tx: Tx, ownerType: string, ownerId: string): void {
  for (const table of [
    'citation_link',
    'media_link',
    'note_link',
    'tag_link',
    'raw_record',
    'unmapped_line',
  ] as const) {
    for (const { id } of all<{ id: string }>(
      tx.store,
      `SELECT id FROM ${table} WHERE owner_type = ? AND owner_id = ? ORDER BY id`,
      ownerType,
      ownerId,
    ))
      tx.delete(table, id);
  }
}

/** Deletes events that no longer have any role. */
function deleteOrphanEvent(tx: Tx, eventId: string): void {
  if (!tx.store.stmt('SELECT 1 FROM event_role WHERE event_id = ?').get(eventId)) {
    events.delete(tx, eventId);
  }
}

// ---------------------------------------------------------------- names

export type NameInput = Omit<InsertRow<'person_name'>, 'person_id'>;

export const names = {
  ...crud('person_name'),

  /** Names of a person, primary first, then by sort_order. */
  list: (store: TreeStore, personId: string): PersonNameRow[] =>
    all(
      store,
      'SELECT * FROM person_name WHERE person_id = ? ORDER BY is_primary DESC, sort_order, id',
      personId,
    ),

  /** Adds a name; the first name of a person becomes primary. */
  add(tx: Tx, personId: string, input: NameInput): PersonNameRow {
    const stats = tx.store
      .stmt(
        'SELECT count(*) AS n, max(sort_order) AS maxOrder, max(is_primary) AS hasPrimary FROM person_name WHERE person_id = ?',
      )
      .get(personId) as { n: number; maxOrder: number | null; hasPrimary: number | null };
    const wantsPrimary = input.is_primary === 1 || !stats.hasPrimary;
    if (wantsPrimary && stats.hasPrimary) demotePrimary(tx, personId);
    return tx.insert('person_name', {
      ...input,
      person_id: personId,
      is_primary: wantsPrimary ? 1 : 0,
      sort_order: input.sort_order ?? (stats.n === 0 ? 0 : (stats.maxOrder ?? 0) + 1),
    });
  },

  update(tx: Tx, id: string, patch: PatchRow<'person_name'>): PersonNameRow {
    const { is_primary, ...rest } = patch;
    if (is_primary === 1) names.setPrimary(tx, id);
    return tx.update('person_name', id, is_primary === 0 ? patch : rest);
  },

  setPrimary(tx: Tx, id: string): PersonNameRow {
    const name = tx.store.getRow('person_name', id);
    if (!name) throw new NotFoundError('person_name', id);
    if (name.is_primary) return name;
    demotePrimary(tx, name.person_id);
    return tx.update('person_name', id, { is_primary: 1 });
  },

  /** Deletes a name; if it was primary the next name by sort_order is promoted. */
  delete(tx: Tx, id: string): PersonNameRow {
    deleteOwned(tx, 'person_name', id);
    const removed = tx.delete('person_name', id);
    if (removed.is_primary) {
      const next = tx.store
        .stmt('SELECT id FROM person_name WHERE person_id = ? ORDER BY sort_order, id LIMIT 1')
        .get(removed.person_id) as { id: string } | undefined;
      if (next) tx.update('person_name', next.id, { is_primary: 1 });
    }
    return removed;
  },
};

function demotePrimary(tx: Tx, personId: string): void {
  const current = tx.store
    .stmt('SELECT id FROM person_name WHERE person_id = ? AND is_primary = 1')
    .get(personId) as { id: string } | undefined;
  if (current) tx.update('person_name', current.id, { is_primary: 0 });
}

// ---------------------------------------------------------------- persons

export type PersonInput = InsertRow<'person'> & { names?: NameInput[] };

export const persons = {
  ...crud('person'),

  list: (store: TreeStore) => all<TableRows['person']>(store, 'SELECT * FROM person ORDER BY id'),

  create(tx: Tx, { names: nameInputs = [], ...input }: PersonInput) {
    const person = tx.insert('person', input);
    nameInputs.forEach((n, i) => names.add(tx, person.id, { sort_order: i, ...n }));
    return person;
  },

  /**
   * Deletes a person and everything that only existed for them: names, roles
   * (and events left without any role), child links, owned links and raw
   * GEDCOM. Families they partnered keep the other partner and the children;
   * a family left with no partners and no children is deleted.
   */
  delete(tx: Tx, id: string) {
    if (!tx.store.getRow('person', id)) throw new NotFoundError('person', id);
    for (const n of names.list(tx.store, id)) {
      deleteOwned(tx, 'person_name', n.id);
      tx.delete('person_name', n.id);
    }
    for (const role of eventRoles.listForPerson(tx.store, id)) {
      tx.delete('event_role', role.id);
      deleteOrphanEvent(tx, role.event_id);
    }
    for (const link of familyChildren.listForChild(tx.store, id)) {
      deleteOwned(tx, 'family_child', link.id);
      tx.delete('family_child', link.id);
    }
    for (const family of families.listForPartner(tx.store, id)) {
      const patch = family.partner1_id === id ? { partner1_id: null } : { partner2_id: null };
      const updated = tx.update('family', family.id, patch);
      const hasChildren = tx.store
        .stmt('SELECT 1 FROM family_child WHERE family_id = ?')
        .get(family.id);
      if (!updated.partner1_id && !updated.partner2_id && !hasChildren)
        families.delete(tx, family.id);
    }
    deleteOwned(tx, 'person', id);
    if (meta.getHomePersonId(tx.store) === id) tx.delete('meta', 'home_person_id');
    return tx.delete('person', id);
  },
};

// ---------------------------------------------------------------- events

export type RoleInput = Omit<InsertRow<'event_role'>, 'event_id'>;
export type EventInput = InsertRow<'event'> & { roles?: RoleInput[] };

export const eventRoles = {
  ...crud('event_role'),
  listForEvent: (store: TreeStore, eventId: string): EventRoleRow[] =>
    all(store, 'SELECT * FROM event_role WHERE event_id = ? ORDER BY sort_order, id', eventId),
  listForPerson: (store: TreeStore, personId: string): EventRoleRow[] =>
    all(store, 'SELECT * FROM event_role WHERE person_id = ? ORDER BY sort_order, id', personId),
  listForFamily: (store: TreeStore, familyId: string): EventRoleRow[] =>
    all(store, 'SELECT * FROM event_role WHERE family_id = ? ORDER BY sort_order, id', familyId),
};

export const events = {
  ...crud('event'),

  create(tx: Tx, { roles = [], ...input }: EventInput) {
    const event = tx.insert('event', input);
    roles.forEach((r, i) => tx.insert('event_role', { sort_order: i, ...r, event_id: event.id }));
    return event;
  },

  delete(tx: Tx, id: string) {
    for (const role of eventRoles.listForEvent(tx.store, id)) tx.delete('event_role', role.id);
    deleteOwned(tx, 'event', id);
    return tx.delete('event', id);
  },
};

// ---------------------------------------------------------------- families

export type ChildInput = Omit<InsertRow<'family_child'>, 'family_id'>;
export type FamilyInput = InsertRow<'family'> & { children?: ChildInput[] };

export const familyChildren = {
  ...crud('family_child'),
  listForFamily: (store: TreeStore, familyId: string): FamilyChildRow[] =>
    all(store, 'SELECT * FROM family_child WHERE family_id = ? ORDER BY sort_order, id', familyId),
  /** A person's parent families, in their order (GEDCOM `FAMC` order). */
  listForChild: (store: TreeStore, childId: string): FamilyChildRow[] =>
    all(store, 'SELECT * FROM family_child WHERE child_id = ? ORDER BY child_order, id', childId),

  /**
   * Adds a child to a family. The child's first parent family becomes the
   * preferred one (the default parent set in tree views); `is_preferred: 1`
   * moves the preference here.
   */
  create(tx: Tx, input: InsertRow<'family_child'>): FamilyChildRow {
    const stats = tx.store
      .stmt(
        'SELECT count(*) AS n, max(child_order) AS maxOrder, max(is_preferred) AS hasPreferred FROM family_child WHERE child_id = ?',
      )
      .get(input.child_id) as { n: number; maxOrder: number | null; hasPreferred: number | null };
    const preferred = input.is_preferred === 1 || !stats.hasPreferred;
    if (preferred && stats.hasPreferred) demotePreferredParents(tx, input.child_id);
    return tx.insert('family_child', {
      ...input,
      is_preferred: preferred ? 1 : 0,
      child_order: input.child_order ?? (stats.n === 0 ? 0 : (stats.maxOrder ?? 0) + 1),
    });
  },

  update(tx: Tx, id: string, patch: PatchRow<'family_child'>): FamilyChildRow {
    const { is_preferred, ...rest } = patch;
    if (is_preferred === 1) familyChildren.setPreferred(tx, id);
    return tx.update('family_child', id, is_preferred === 0 ? patch : rest);
  },

  /** Makes this the child's preferred parent family. */
  setPreferred(tx: Tx, id: string): FamilyChildRow {
    const link = tx.store.getRow('family_child', id);
    if (!link) throw new NotFoundError('family_child', id);
    if (link.is_preferred) return link;
    demotePreferredParents(tx, link.child_id);
    return tx.update('family_child', id, { is_preferred: 1 });
  },

  /** Removes a child from a family; if it was the preferred parent set, the next one is promoted. */
  delete(tx: Tx, id: string) {
    deleteOwned(tx, 'family_child', id);
    const removed = tx.delete('family_child', id);
    if (removed.is_preferred) {
      const next = tx.store
        .stmt('SELECT id FROM family_child WHERE child_id = ? ORDER BY child_order, id LIMIT 1')
        .get(removed.child_id) as { id: string } | undefined;
      if (next) tx.update('family_child', next.id, { is_preferred: 1 });
    }
    return removed;
  },
};

function demotePreferredParents(tx: Tx, childId: string): void {
  const current = tx.store
    .stmt('SELECT id FROM family_child WHERE child_id = ? AND is_preferred = 1')
    .get(childId) as { id: string } | undefined;
  if (current) tx.update('family_child', current.id, { is_preferred: 0 });
}

function familyCount(tx: Tx, personId: string | null | undefined): number {
  if (!personId) return 0;
  return (
    tx.store
      .stmt('SELECT count(*) AS n FROM family WHERE partner1_id = @id OR partner2_id = @id')
      .get({ id: personId }) as { n: number }
  ).n;
}

export const families = {
  ...crud('family'),

  /** Families where the person is a partner, in that person's display order. */
  listForPartner: (store: TreeStore, personId: string): FamilyRow[] =>
    all(
      store,
      `SELECT * FROM family WHERE partner1_id = @id OR partner2_id = @id
       ORDER BY CASE WHEN partner1_id = @id THEN partner1_order ELSE partner2_order END, id`,
      { id: personId },
    ),

  create(tx: Tx, { children = [], ...input }: FamilyInput) {
    const family = tx.insert('family', {
      partner1_order: familyCount(tx, input.partner1_id),
      partner2_order: familyCount(tx, input.partner2_id),
      ...input,
    });
    children.forEach((c, i) =>
      familyChildren.create(tx, { sort_order: i, ...c, family_id: family.id }),
    );
    return family;
  },

  delete(tx: Tx, id: string) {
    for (const link of familyChildren.listForFamily(tx.store, id))
      familyChildren.delete(tx, link.id);
    families.deleteEvents(tx, id);
    deleteOwned(tx, 'family', id);
    return tx.delete('family', id);
  },

  /** Removes the family's events (marriage, divorce...), e.g. when the partnership ends. */
  deleteEvents(tx: Tx, id: string) {
    for (const role of eventRoles.listForFamily(tx.store, id)) {
      tx.delete('event_role', role.id);
      deleteOrphanEvent(tx, role.event_id);
    }
  },

  /**
   * Deletes a family that no longer records anything: at most one partner,
   * no children, and nothing attached (events, notes, media, citations, tags,
   * or imported GEDCOM kept for round-trip). Returns whether it was deleted.
   */
  pruneIfEmpty(tx: Tx, id: string): boolean {
    const family = tx.store.getRow('family', id);
    if (!family) return false;
    const partners = [family.partner1_id, family.partner2_id].filter(Boolean).length;
    if (partners > 1) return false;
    const attached = tx.store
      .stmt(
        `SELECT 1 WHERE
           EXISTS (SELECT 1 FROM family_child WHERE family_id = @id)
           OR EXISTS (SELECT 1 FROM event_role WHERE family_id = @id)
           OR EXISTS (SELECT 1 FROM note_link WHERE owner_type = 'family' AND owner_id = @id)
           OR EXISTS (SELECT 1 FROM media_link WHERE owner_type = 'family' AND owner_id = @id)
           OR EXISTS (SELECT 1 FROM citation_link WHERE owner_type = 'family' AND owner_id = @id)
           OR EXISTS (SELECT 1 FROM tag_link WHERE owner_type = 'family' AND owner_id = @id)
           OR EXISTS (SELECT 1 FROM raw_record WHERE owner_type = 'family' AND owner_id = @id)
           OR EXISTS (SELECT 1 FROM unmapped_line WHERE owner_type = 'family' AND owner_id = @id)`,
      )
      .get({ id });
    if (attached) return false;
    families.delete(tx, id);
    return true;
  },
};

// ---------------------------------------------------------------- places, sources, citations

export const places = {
  ...crud('place'),
  /** Deletes a place; events and child places that referenced it lose the reference. */
  delete(tx: Tx, id: string) {
    for (const { id: eventId } of all<{ id: string }>(
      tx.store,
      'SELECT id FROM event WHERE place_id = ? ORDER BY id',
      id,
    ))
      tx.update('event', eventId, { place_id: null });
    for (const { id: childId } of all<{ id: string }>(
      tx.store,
      'SELECT id FROM place WHERE parent_id = ? ORDER BY id',
      id,
    ))
      tx.update('place', childId, { parent_id: null });
    deleteOwned(tx, 'place', id);
    return tx.delete('place', id);
  },
};

export const repositories = {
  ...crud('repository'),
  delete(tx: Tx, id: string) {
    for (const { id: sourceId } of all<{ id: string }>(
      tx.store,
      'SELECT id FROM source WHERE repository_id = ? ORDER BY id',
      id,
    ))
      tx.update('source', sourceId, { repository_id: null });
    deleteOwned(tx, 'repository', id);
    return tx.delete('repository', id);
  },
};

export const citations = {
  ...crud('citation'),
  delete(tx: Tx, id: string) {
    for (const link of citationLinks.listForTarget(tx.store, id))
      tx.delete('citation_link', link.id);
    deleteOwned(tx, 'citation', id);
    return tx.delete('citation', id);
  },
};

export const sources = {
  ...crud('source'),
  /** Deletes a source together with its citations. */
  delete(tx: Tx, id: string) {
    for (const { id: citationId } of all<{ id: string }>(
      tx.store,
      'SELECT id FROM citation WHERE source_id = ? ORDER BY id',
      id,
    ))
      citations.delete(tx, citationId);
    deleteOwned(tx, 'source', id);
    return tx.delete('source', id);
  },
};

// ---------------------------------------------------------------- media, notes, tags

export const media = {
  ...crud('media'),
  /** Deletes media, its links, and clears it as anyone's primary photo. */
  delete(tx: Tx, id: string) {
    for (const link of mediaLinks.listForTarget(tx.store, id)) tx.delete('media_link', link.id);
    for (const { id: personId } of all<{ id: string }>(
      tx.store,
      'SELECT id FROM person WHERE primary_media_id = ? ORDER BY id',
      id,
    ))
      tx.update('person', personId, { primary_media_id: null });
    deleteOwned(tx, 'media', id);
    return tx.delete('media', id);
  },
};

export const notes = {
  ...crud('note'),
  delete(tx: Tx, id: string) {
    for (const link of noteLinks.listForTarget(tx.store, id)) tx.delete('note_link', link.id);
    deleteOwned(tx, 'note', id);
    return tx.delete('note', id);
  },
};

export const tags = {
  ...crud('tag'),
  list: (store: TreeStore): TagRow[] => all(store, 'SELECT * FROM tag ORDER BY category, name, id'),
  delete(tx: Tx, id: string) {
    for (const link of tagLinks.listForTarget(tx.store, id)) tx.delete('tag_link', link.id);
    return tx.delete('tag', id);
  },
};

// ---------------------------------------------------------------- links

function linkRepo<
  T extends 'citation_link' | 'media_link' | 'note_link' | 'tag_link',
  Owner extends string,
>(table: T, targetColumn: string) {
  const order = table === 'tag_link' ? 'id' : 'sort_order, id';
  return {
    ...crud(table),
    /** Links owned by an entity (e.g. the citations on an event). */
    listFor: (store: TreeStore, ownerType: Owner, ownerId: string): TableRows[T][] =>
      all(
        store,
        `SELECT * FROM ${table} WHERE owner_type = ? AND owner_id = ? ORDER BY ${order}`,
        ownerType,
        ownerId,
      ),
    /** Links pointing at a citation, media item, note or tag. */
    listForTarget: (store: TreeStore, targetId: string): TableRows[T][] =>
      all(store, `SELECT * FROM ${table} WHERE ${targetColumn} = ? ORDER BY id`, targetId),
  };
}

export const citationLinks = linkRepo<'citation_link', CitationOwner>(
  'citation_link',
  'citation_id',
);
export const mediaLinks = linkRepo<'media_link', MediaOwner>('media_link', 'media_id');
export const noteLinks = linkRepo<'note_link', NoteOwner>('note_link', 'note_id');
export const tagLinks = linkRepo<'tag_link', TagOwner>('tag_link', 'tag_id');

export type { CitationLinkRow, MediaLinkRow, NoteLinkRow, TagLinkRow };

// ---------------------------------------------------------------- meta

/** Well-known meta keys: schema_version (read-only), tree_name, home_person_id, settings (JSON). */
export const meta = {
  get(store: TreeStore, key: string): string | undefined {
    return store.getRow('meta', key)?.value;
  },
  set(tx: Tx, key: string, value: string) {
    if (key === 'schema_version') throw new Error('schema_version is managed by migrations');
    return tx.store.getRow('meta', key)
      ? tx.update('meta', key, { value })
      : tx.insert('meta', { key, value });
  },
  delete(tx: Tx, key: string) {
    if (key === 'schema_version') throw new Error('schema_version is managed by migrations');
    return tx.delete('meta', key);
  },
  getHomePersonId(store: TreeStore): string | null {
    return meta.get(store, 'home_person_id') ?? null;
  },
  setHomePerson(tx: Tx, personId: string | null) {
    if (personId === null) {
      if (tx.store.getRow('meta', 'home_person_id')) tx.delete('meta', 'home_person_id');
      return;
    }
    if (!tx.store.getRow('person', personId)) throw new NotFoundError('person', personId);
    meta.set(tx, 'home_person_id', personId);
  },
};
