import {
  families,
  familyChildren,
  getPersonSummary,
  events,
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
  refreshLiving,
  requireRow,
  resolveRelative,
} from '../edits';
import { badRequest, conflict, notFound } from '../errors';
import {
  addName,
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
      const { batchId, result } = edit(store, 'Add person', (tx) => createPerson(tx, request.body));
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
      const { batchId } = edit(store, 'Edit person', (tx) => updatePerson(tx, id, request.body));
      return { batchId, person: summary(store, id) };
    },
  );

  app.delete('/api/trees/:tree/people/:id', ids, async (request) => {
    const store = open(request.params.tree);
    const { batchId } = edit(store, 'Delete person', (tx) => persons.delete(tx, request.params.id));
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
      const { batchId, result } = edit(store, 'Add name', (tx) => addName(tx, id, request.body));
      return reply.code(201).send({ batchId, name: result });
    },
  );

  app.patch(
    '/api/trees/:tree/names/:id',
    { schema: { params: TreeIdParams, body: NameBody } },
    async (request) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      requireRow(store, 'person_name', id);
      const { batchId, result } = edit(store, 'Edit name', (tx) =>
        updateName(tx, id, request.body),
      );
      return { batchId, name: result };
    },
  );

  app.delete('/api/trees/:tree/names/:id', ids, async (request) => {
    const store = open(request.params.tree);
    requireRow(store, 'person_name', request.params.id);
    const { batchId } = edit(store, 'Delete name', (tx) => deleteName(tx, request.params.id));
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
      const { batchId, result } = edit(store, 'Add event', (tx) => {
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
      const { batchId, result } = edit(store, 'Add family event', (tx) =>
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
      requireRow(store, 'event', id);
      const { batchId, result } = edit(store, 'Edit event', (tx) => {
        const event = events.update(tx, id, eventRow(tx, request.body));
        refreshLiving(tx, eventPeople(tx.store, id));
        return event;
      });
      return { batchId, event: result };
    },
  );

  app.delete('/api/trees/:tree/events/:id', ids, async (request) => {
    const store = open(request.params.tree);
    const { batchId } = edit(store, 'Delete event', (tx) => {
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
      const { batchId, result } = edit(store, 'Add parent', (tx) => {
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
      const { batchId, result } = edit(store, 'Add spouse', (tx) => {
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
      const { batchId, result } = edit(store, 'Add child', (tx) => {
        const childId = resolveRelative(tx, request.body);
        notSelf(id, childId);
        const rels = {
          ...(partner1_rel ? { partner1_rel } : {}),
          ...(partner2_rel ? { partner2_rel } : {}),
        };
        const family = familyId
          ? tx.store.getRow('family', familyId)!
          : families.create(tx, { partner1_id: id });
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
      const { batchId, result } = edit(store, 'Add sibling', (tx) => {
        const siblingId = resolveRelative(tx, request.body);
        notSelf(id, siblingId);
        const links = familyChildren.listForChild(tx.store, id);
        const preferred = links.find((l) => l.is_preferred === 1) ?? links[0];
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
      const { batchId, result } = edit(store, 'Edit relationship', (tx) =>
        families.update(tx, id, request.body),
      );
      return { batchId, family: result };
    },
  );

  app.delete('/api/trees/:tree/families/:id', ids, async (request) => {
    const store = open(request.params.tree);
    const { batchId } = edit(store, 'Delete family', (tx) =>
      families.delete(tx, request.params.id),
    );
    return { batchId };
  });

  app.patch(
    '/api/trees/:tree/family-children/:id',
    { schema: { params: TreeIdParams, body: FamilyChildPatch } },
    async (request) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      requireRow(store, 'family_child', id);
      const { batchId, result } = edit(store, 'Edit child relationship', (tx) =>
        updateFamilyChild(tx, id, request.body),
      );
      return { batchId, link: result };
    },
  );

  app.delete('/api/trees/:tree/family-children/:id', ids, async (request) => {
    const store = open(request.params.tree);
    const { batchId } = edit(store, 'Remove child from family', (tx) =>
      familyChildren.delete(tx, request.params.id),
    );
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
      const { batchId, result } = edit(store, 'Add note', (tx) => {
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
      const { batchId, result } = edit(store, 'Edit note', (tx) =>
        notes.update(tx, id, { text: request.body.text }),
      );
      return { batchId, note: result };
    },
  );

  app.delete('/api/trees/:tree/notes/:id', ids, async (request) => {
    const store = open(request.params.tree);
    const { batchId } = edit(store, 'Delete note', (tx) => notes.delete(tx, request.params.id));
    return { batchId };
  });

  // ------------------------------------------------------------ tags

  app.post(
    '/api/trees/:tree/tags',
    { schema: { params: TreeParams, body: TagBody } },
    async (request, reply) => {
      const store = open(request.params.tree);
      const { batchId, result } = edit(store, 'Add tag', (tx) => createTag(tx, request.body));
      return reply.code(201).send({ batchId, tag: result });
    },
  );

  app.patch(
    '/api/trees/:tree/tags/:id',
    { schema: { params: TreeIdParams, body: TagPatch } },
    async (request) => {
      const store = open(request.params.tree);
      const { id } = request.params;
      requireRow(store, 'tag', id);
      const { batchId, result } = edit(store, 'Edit tag', (tx) =>
        tags.update(tx, id, request.body),
      );
      return { batchId, tag: result };
    },
  );

  app.delete('/api/trees/:tree/tags/:id', ids, async (request) => {
    const store = open(request.params.tree);
    const { batchId } = edit(store, 'Delete tag', (tx) => tags.delete(tx, request.params.id));
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
      const { batchId, result } = edit(store, 'Tag person', (tx) =>
        tagPerson(tx, id, request.body.tagId),
      );
      return reply.code(201).send({ batchId, link: result });
    },
  );

  app.delete(
    '/api/trees/:tree/people/:id/tags/:tagId',
    { schema: { params: PersonTagParams } },
    async (request) => {
      const store = open(request.params.tree);
      const { id, tagId } = request.params;
      const { batchId } = edit(store, 'Untag person', (tx) => untagPerson(tx, id, tagId));
      return { batchId };
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
      const { batchId, result } = edit(store, label, (tx) =>
        operations.map((operation) => runOperation(tx, operation)),
      );
      return { batchId, results: result };
    },
  );
}
