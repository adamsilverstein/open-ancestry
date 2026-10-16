import {
  families,
  familyChildren,
  getPersonSummary,
  events,
  meta,
  noteLinks,
  notes,
  persons,
  tags,
  type FamilyRow,
  type TableName,
  type TreeStore,
  type Tx,
} from '@open-ancestry/db';
import type { Api, Deps } from '../context';
import {
  createEvent,
  createPerson,
  edit,
  eventPeople,
  eventRow,
  bodyLabel,
  eventOwnerLabel,
  eventTypeLabel,
  familyLabel,
  familyMembers,
  noteLabel,
  ownerLabel,
  personLabel,
  refreshLiving,
  refuseCycles,
  relativesOf,
  requireRow,
  resolveRelative,
} from '../edits';
import { badRequest, conflict, notFound } from '../errors';
import { mergePeople } from '../merge';
import {
  addName,
  checkSeen,
  createTag,
  deleteName,
  runOperation,
  tagPerson,
  untagPerson,
  updateFamilyChild,
  updateName,
  updatePerson,
} from '../operations';
import {
  AddChildBody,
  AddParentBody,
  AddSiblingBody,
  AddSpouseBody,
  BatchBody,
  MergeBody,
  EventBody,
  EventPatch,
  FamilyChildPatch,
  FamilyPatch,
  NameBody,
  NoteBody,
  NotePatch,
  PersonBody,
  PersonPatch,
  PersonTagBody,
  PersonTagParams,
  TagBody,
  TagPatch,
  TreeIdParams,
  TreeParams,
} from '../schemas';

/*
 * Mutations. Each request is one change batch (one SQLite transaction) and
 * returns its `batchId` for undo, or null when nothing changed.
 */

const ids = { schema: { params: TreeIdParams } };

function notSelf(a: string, b: string): void {
  if (a === b) throw badRequest('A person cannot be related to themselves');
}

/** The empty partner slot of a family, or a conflict when both are filled. */
function emptySlot(family: FamilyRow): 'partner1_id' | 'partner2_id' {
  if (!family.partner1_id) return 'partner1_id';
  if (!family.partner2_id) return 'partner2_id';
  throw conflict(`Family ${family.id} already has two partners`);
}

function addParent(tx: Tx, childId: string, body: AddParentBody) {
  const links = familyChildren.listForChild(tx.store, childId);
  let link = body.familyId ? links.find((l) => l.family_id === body.familyId) : undefined;
  if (body.familyId && !link)
    throw badRequest(`Family ${body.familyId} is not a parent family of ${childId}`);
  // Without a family, join the preferred parent set when it has room.
  if (!link) {
    const preferred = links.find((l) => l.is_preferred === 1);
    const family = preferred && tx.store.getRow('family', preferred.family_id);
    if (family && (!family.partner1_id || !family.partner2_id)) link = preferred;
  }
  const parentId = resolveRelative(tx, body);
  notSelf(parentId, childId);
  const { rel } = body;
  // Joining a family makes the new parent a parent of all its children.
  const children = link
    ? familyChildren.listForFamily(tx.store, link.family_id).map((l) => l.child_id)
    : [childId];
  refuseCycles(tx.store, [parentId], children, 'parent');
  if (link) {
    const slot = emptySlot(tx.store.getRow('family', link.family_id)!);
    const family = families.update(tx, link.family_id, { [slot]: parentId });
    if (rel)
      familyChildren.update(
        tx,
        link.id,
        slot === 'partner1_id' ? { partner1_rel: rel } : { partner2_rel: rel },
      );
    return { family, parentId };
  }
  const family = families.create(tx, {
    partner1_id: parentId,
    children: [{ child_id: childId, ...(rel ? { partner1_rel: rel } : {}) }],
  });
  return { family, parentId };
}

/** History label for a family patch: a removed partner or a type change, named as such. */
type PartnerPatch = { partner1_id?: string | null; partner2_id?: string | null };

/**
 * The partner a family patch takes out of the partnership, or null. Moving
 * a partner between slots, or replacing one, is not a removal.
 */
function removedPartner(family: FamilyRow, body: PartnerPatch): string | null {
  const before = [family.partner1_id, family.partner2_id].filter((p): p is string => !!p);
  const after = [
    body.partner1_id === undefined ? family.partner1_id : body.partner1_id,
    body.partner2_id === undefined ? family.partner2_id : body.partner2_id,
  ].filter((p): p is string => !!p);
  if (after.length >= before.length) return null;
  return before.find((p) => !after.includes(p)) ?? null;
}

/** History label for a family patch: a removed partner or a type change, named as such. */
function familyPatchLabel(store: TreeStore, family: FamilyRow, body: PartnerPatch): string {
  const removed = removedPartner(family, body);
  if (removed) {
    const other = [family.partner1_id, family.partner2_id].find((p) => p && p !== removed);
    const from = other ? ` from ${personLabel(store, other)}` : '';
    return `Remove partner: ${personLabel(store, removed)}${from}`;
  }
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === 'relationship_type') {
    return `Edit relationship type: ${familyLabel(store, family.id)}`;
  }
  return `Edit relationship: ${familyLabel(store, family.id)}`;
}

function isOnlyPerson(store: TreeStore, id: string): boolean {
  const others = store.stmt('SELECT 1 FROM person WHERE id <> ? LIMIT 1').get(id);
  return others === undefined;
}

function ownerExists(store: TreeStore, table: string, id: string): void {
  if (!store.getRow(table as TableName, id)) throw notFound(`${table} ${id} not found`);
}

export function editRoutes(app: Api, { library }: Deps): void {
  const open = (tree: string) => library.open(tree);
  const summary = (store: TreeStore, id: string) => getPersonSummary(store, id);

  // ------------------------------------------------------------ people

  app.post(
    '/api/trees/:tree/people',
    { schema: { params: TreeParams, body: PersonBody } },
    async (request, reply) => {
      const store = open(request.params.tree);
      const { batchId, result } = edit(store, `Add person: ${bodyLabel(request.body)}`, (tx) => {
        const person = createPerson(tx, request.body);
        // The first person in an empty tree is its home person, in the same undo step.
        if (!meta.getHomePersonId(tx.store) && isOnlyPerson(tx.store, person.id)) {
          meta.setHomePerson(tx, person.id);
        }
        return person;
      });
      return reply.code(201).send({ batchId, person: summary(store, result.id) });
    },
  );

  app.patch(
    '/api/trees/:tree/people/:id',
    { schema: { params: TreeIdParams, body: PersonPatch } },
    async (request) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      requireRow(store, 'person', id);
      const { batchId } = edit(store, `Edit person: ${personLabel(store, id)}`, (tx) =>
        updatePerson(tx, id, request.body),
      );
      return { batchId, person: summary(store, id) };
    },
  );

  app.delete('/api/trees/:tree/people/:id', ids, async (request) => {
    const store = open(request.params.tree);
    const { id } = request.params;
    const { batchId } = edit(store, `Delete person: ${personLabel(store, id)}`, (tx) => {
      // Relatives' inferred status can rest on this person's dates.
      const relatives = relativesOf(tx.store, id);
      persons.delete(tx, id);
      refreshLiving(tx, relatives, { relatives: false });
    });
    return { batchId };
  });

  // ------------------------------------------------------------ names

  app.post(
    '/api/trees/:tree/people/:id/names',
    { schema: { params: TreeIdParams, body: NameBody } },
    async (request, reply) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      requireRow(store, 'person', id);
      const { batchId, result } = edit(store, `Add name: ${personLabel(store, id)}`, (tx) =>
        addName(tx, id, request.body),
      );
      return reply.code(201).send({ batchId, name: result });
    },
  );

  app.patch(
    '/api/trees/:tree/names/:id',
    { schema: { params: TreeIdParams, body: NameBody } },
    async (request) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      const name = requireRow(store, 'person_name', id);
      const label = `Edit name: ${personLabel(store, name.person_id)}`;
      const { batchId, result } = edit(store, label, (tx) => updateName(tx, id, request.body));
      return { batchId, name: result };
    },
  );

  app.delete('/api/trees/:tree/names/:id', ids, async (request) => {
    const store = open(request.params.tree);
    const name = requireRow(store, 'person_name', request.params.id);
    const label = `Delete name: ${personLabel(store, name.person_id)}`;
    const { batchId } = edit(store, label, (tx) => deleteName(tx, request.params.id));
    return { batchId };
  });

  // ------------------------------------------------------------ events

  app.post(
    '/api/trees/:tree/people/:id/events',
    { schema: { params: TreeIdParams, body: EventBody } },
    async (request, reply) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      requireRow(store, 'person', id);
      const label = `Add ${eventTypeLabel(request.body.type, request.body.custom_type)}: ${personLabel(store, id)}`;
      const { batchId, result } = edit(store, label, (tx) => {
        const event = createEvent(tx, request.body, { person_id: id });
        refreshLiving(tx, [id]);
        return event;
      });
      return reply.code(201).send({ batchId, event: result });
    },
  );

  app.post(
    '/api/trees/:tree/families/:id/events',
    { schema: { params: TreeIdParams, body: EventBody } },
    async (request, reply) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      requireRow(store, 'family', id);
      const label = `Add ${eventTypeLabel(request.body.type, request.body.custom_type)}: ${familyLabel(store, id)}`;
      const { batchId, result } = edit(store, label, (tx) =>
        createEvent(tx, request.body, { family_id: id }),
      );
      return reply.code(201).send({ batchId, event: result });
    },
  );

  app.patch(
    '/api/trees/:tree/events/:id',
    { schema: { params: TreeIdParams, body: EventPatch } },
    async (request) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      const existing = requireRow(store, 'event', id);
      const label = `Edit ${eventTypeLabel(existing.type, existing.custom_type)}: ${eventOwnerLabel(store, id)}`;
      const { batchId, result } = edit(store, label, (tx) => {
        const event = events.update(tx, id, eventRow(tx, request.body));
        refreshLiving(tx, eventPeople(tx.store, id));
        return event;
      });
      return { batchId, event: result };
    },
  );

  app.delete('/api/trees/:tree/events/:id', ids, async (request) => {
    const store = open(request.params.tree);
    const existing = store.getRow('event', request.params.id);
    const label = existing
      ? `Delete ${eventTypeLabel(existing.type, existing.custom_type)}: ${eventOwnerLabel(store, existing.id)}`
      : 'Delete event';
    const { batchId } = edit(store, label, (tx) => {
      const people = eventPeople(tx.store, request.params.id);
      events.delete(tx, request.params.id);
      refreshLiving(tx, people);
    });
    return { batchId };
  });

  // ------------------------------------------------------------ relationships

  app.post(
    '/api/trees/:tree/people/:id/parents',
    { schema: { params: TreeIdParams, body: AddParentBody } },
    async (request, reply) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      requireRow(store, 'person', id);
      const { batchId, result } = edit(store, `Add parent: ${personLabel(store, id)}`, (tx) => {
        const added = addParent(tx, id, request.body);
        refreshLiving(tx, [id, added.parentId]);
        return added;
      });
      return reply.code(201).send({ batchId, ...result });
    },
  );

  app.post(
    '/api/trees/:tree/people/:id/spouses',
    { schema: { params: TreeIdParams, body: AddSpouseBody } },
    async (request, reply) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      requireRow(store, 'person', id);
      const { batchId, result } = edit(store, `Add spouse: ${personLabel(store, id)}`, (tx) => {
        const spouseId = resolveRelative(tx, request.body);
        notSelf(id, spouseId);
        const family = families.create(tx, {
          partner1_id: id,
          partner2_id: spouseId,
          ...(request.body.relationship_type
            ? { relationship_type: request.body.relationship_type }
            : {}),
        });
        refreshLiving(tx, [id, spouseId]);
        return { family, spouseId };
      });
      return reply.code(201).send({ batchId, ...result });
    },
  );

  app.post(
    '/api/trees/:tree/people/:id/children',
    { schema: { params: TreeIdParams, body: AddChildBody } },
    async (request, reply) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      requireRow(store, 'person', id);
      const { familyId, partner1_rel, partner2_rel } = request.body;
      if (familyId) {
        const family = requireRow(store, 'family', familyId);
        if (family.partner1_id !== id && family.partner2_id !== id)
          throw badRequest(`Person ${id} is not a partner in family ${familyId}`);
      }
      const { batchId, result } = edit(store, `Add child: ${personLabel(store, id)}`, (tx) => {
        const childId = resolveRelative(tx, request.body);
        notSelf(id, childId);
        const existing = familyId ? tx.store.getRow('family', familyId)! : null;
        const parents = existing ? [existing.partner1_id, existing.partner2_id] : [id];
        refuseCycles(tx.store, parents, [childId], 'child');
        const rels = {
          ...(partner1_rel ? { partner1_rel } : {}),
          ...(partner2_rel ? { partner2_rel } : {}),
        };
        const family = existing ?? families.create(tx, { partner1_id: id });
        const link = familyChildren.create(tx, {
          family_id: family.id,
          child_id: childId,
          sort_order: familyChildren.listForFamily(tx.store, family.id).length,
          ...rels,
        });
        refreshLiving(tx, [id, childId]);
        return { family, childId, link };
      });
      return reply.code(201).send({ batchId, ...result });
    },
  );

  app.post(
    '/api/trees/:tree/people/:id/siblings',
    { schema: { params: TreeIdParams, body: AddSiblingBody } },
    async (request, reply) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      requireRow(store, 'person', id);
      const { batchId, result } = edit(store, `Add sibling: ${personLabel(store, id)}`, (tx) => {
        const siblingId = resolveRelative(tx, request.body);
        notSelf(id, siblingId);
        const links = familyChildren.listForChild(tx.store, id);
        const preferred = links.find((l) => l.is_preferred === 1) ?? links[0];
        if (preferred) {
          const family = tx.store.getRow('family', preferred.family_id)!;
          refuseCycles(tx.store, [family.partner1_id, family.partner2_id], [siblingId], 'child');
        }
        // No parents yet: a family with unknown parents holds both children.
        const familyId =
          preferred?.family_id ?? families.create(tx, { children: [{ child_id: id }] }).id;
        const link = familyChildren.create(tx, {
          family_id: familyId,
          child_id: siblingId,
          sort_order: familyChildren.listForFamily(tx.store, familyId).length,
        });
        refreshLiving(tx, [id, siblingId]);
        return { familyId, siblingId, link };
      });
      return reply.code(201).send({ batchId, ...result });
    },
  );

  app.patch(
    '/api/trees/:tree/families/:id',
    { schema: { params: TreeIdParams, body: FamilyPatch } },
    async (request) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      const family = requireRow(store, 'family', id);
      const { partner1_id = family.partner1_id, partner2_id = family.partner2_id } = request.body;
      for (const partner of [partner1_id, partner2_id])
        if (partner) requireRow(store, 'person', partner);
      if (partner1_id && partner1_id === partner2_id) throw badRequest('Partners must differ');
      const { batchId, result } = edit(
        store,
        familyPatchLabel(store, family, request.body),
        (tx) => {
          const before = familyMembers(tx.store, id);
          const added = [partner1_id, partner2_id].filter(
            (p) => p !== family.partner1_id && p !== family.partner2_id,
          );
          const children = familyChildren.listForFamily(tx.store, id).map((l) => l.child_id);
          refuseCycles(tx.store, added, children, 'parent');
          const updated = families.update(tx, id, request.body);
          let result: typeof updated | null = updated;
          if (removedPartner(family, request.body)) {
            // The partnership has ended: its marriage and other events go with it,
            // and a family left with one partner and no children goes too.
            families.deleteEvents(tx, id);
            if (families.pruneIfEmpty(tx, id)) result = null;
          }
          refreshLiving(tx, before, { relatives: false });
          return result;
        },
      );
      return { batchId, family: result };
    },
  );

  app.delete('/api/trees/:tree/families/:id', ids, async (request) => {
    const store = open(request.params.tree);
    const { id } = request.params;
    const { batchId } = edit(store, `Remove relationship: ${familyLabel(store, id)}`, (tx) => {
      const members = familyMembers(tx.store, id);
      families.delete(tx, id);
      refreshLiving(tx, members, { relatives: false });
    });
    return { batchId };
  });

  app.patch(
    '/api/trees/:tree/family-children/:id',
    { schema: { params: TreeIdParams, body: FamilyChildPatch } },
    async (request) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      const link = requireRow(store, 'family_child', id);
      const label = `Edit child relationship: ${personLabel(store, link.child_id)}`;
      const { batchId, result } = edit(store, label, (tx) =>
        updateFamilyChild(tx, id, request.body),
      );
      return { batchId, link: result };
    },
  );

  app.delete('/api/trees/:tree/family-children/:id', ids, async (request) => {
    const store = open(request.params.tree);
    const link = store.getRow('family_child', request.params.id);
    const label = link
      ? `Remove child link: ${personLabel(store, link.child_id)} from ${familyLabel(store, link.family_id)}`
      : 'Remove child link';
    const { batchId } = edit(store, label, (tx) => {
      const members = link ? familyMembers(tx.store, link.family_id) : [];
      familyChildren.delete(tx, request.params.id);
      // A one-parent family whose last child left records nothing any more.
      if (link) families.pruneIfEmpty(tx, link.family_id);
      refreshLiving(tx, members, { relatives: false });
    });
    return { batchId };
  });

  // ------------------------------------------------------------ notes

  app.post(
    '/api/trees/:tree/notes',
    { schema: { params: TreeParams, body: NoteBody } },
    async (request, reply) => {
      const store = open(request.params.tree);
      const { text, owner_type, owner_id } = request.body;
      ownerExists(store, owner_type, owner_id);
      const label = `Add note: ${ownerLabel(store, owner_type, owner_id)}`;
      const { batchId, result } = edit(store, label, (tx) => {
        const note = tx.insert('note', { text });
        const count = noteLinks.listFor(tx.store, owner_type, owner_id).length;
        noteLinks.create(tx, { note_id: note.id, owner_type, owner_id, sort_order: count });
        return note;
      });
      return reply.code(201).send({ batchId, note: result });
    },
  );

  app.patch(
    '/api/trees/:tree/notes/:id',
    { schema: { params: TreeIdParams, body: NotePatch } },
    async (request) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      requireRow(store, 'note', id);
      const { batchId, result } = edit(store, `Edit note: ${noteLabel(store, id)}`, (tx) =>
        notes.update(tx, id, { text: request.body.text }),
      );
      return { batchId, note: result };
    },
  );

  app.delete('/api/trees/:tree/notes/:id', ids, async (request) => {
    const store = open(request.params.tree);
    const label = `Delete note: ${noteLabel(store, request.params.id)}`;
    const { batchId } = edit(store, label, (tx) => notes.delete(tx, request.params.id));
    return { batchId };
  });

  // ------------------------------------------------------------ tags

  app.post(
    '/api/trees/:tree/tags',
    { schema: { params: TreeParams, body: TagBody } },
    async (request, reply) => {
      const store = open(request.params.tree);
      const { batchId, result } = edit(store, `Add tag: ${request.body.name}`, (tx) =>
        createTag(tx, request.body),
      );
      return reply.code(201).send({ batchId, tag: result });
    },
  );

  app.patch(
    '/api/trees/:tree/tags/:id',
    { schema: { params: TreeIdParams, body: TagPatch } },
    async (request) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      const tag = requireRow(store, 'tag', id);
      const { batchId, result } = edit(store, `Edit tag: ${tag.name}`, (tx) =>
        tags.update(tx, id, request.body),
      );
      return { batchId, tag: result };
    },
  );

  app.delete('/api/trees/:tree/tags/:id', ids, async (request) => {
    const store = open(request.params.tree);
    const tag = store.getRow('tag', request.params.id);
    const label = `Delete tag: ${tag?.name ?? request.params.id}`;
    const { batchId } = edit(store, label, (tx) => tags.delete(tx, request.params.id));
    return { batchId };
  });

  app.post(
    '/api/trees/:tree/people/:id/tags',
    { schema: { params: TreeIdParams, body: PersonTagBody } },
    async (request, reply) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      requireRow(store, 'person', id);
      requireRow(store, 'tag', request.body.tagId);
      const label = `Tag ${personLabel(store, id)}: ${store.getRow('tag', request.body.tagId)!.name}`;
      const { batchId, result } = edit(store, label, (tx) => tagPerson(tx, id, request.body.tagId));
      return reply.code(201).send({ batchId, link: result });
    },
  );

  app.delete(
    '/api/trees/:tree/people/:id/tags/:tagId',
    { schema: { params: PersonTagParams } },
    async (request) => {
      const store = open(request.params.tree);
      const { id, tagId } = request.params;
      const label = `Untag ${personLabel(store, id)}: ${store.getRow('tag', tagId)?.name ?? tagId}`;
      const { batchId } = edit(store, label, (tx) => untagPerson(tx, id, tagId));
      return { batchId };
    },
  );

  // ------------------------------------------------------------ merge

  /** Merges another person into this one: one transaction, one undo step. */
  app.post(
    '/api/trees/:tree/people/:id/merge',
    { schema: { params: TreeIdParams, body: MergeBody } },
    async (request) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      const { otherId, choices } = request.body;
      requireRow(store, 'person', id);
      requireRow(store, 'person', otherId);
      const label = `Merge ${personLabel(store, otherId)} into ${personLabel(store, id)}`;
      const { batchId } = edit(store, label, (tx) => mergePeople(tx, id, otherId, choices));
      return { batchId, person: summary(store, id) };
    },
  );

  // ------------------------------------------------------------ batch

  /** Several edits as one change batch, so a dialog save is one undo step. */
  app.post(
    '/api/trees/:tree/batch',
    { schema: { params: TreeParams, body: BatchBody } },
    async (request) => {
      const store = open(request.params.tree);
      const { label, operations } = request.body;
      const { batchId, result } = edit(store, label, (tx) => {
        checkSeen(tx.store, operations);
        return operations.map((operation) => runOperation(tx, operation));
      });
      return { batchId, results: result };
    },
  );
}
