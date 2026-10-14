import {
  LATEST_SCHEMA_VERSION,
  exportJsonString,
  getPersonSummary,
  listBatches,
  meta,
  redoLast,
  undoLast,
  type TreeStore,
} from '@open-ancestry/db';
import type { Api, Deps } from '../context';
import { edit } from '../edits';
import { HistoryQuery, HomeBody, TreeBody, TreeParams } from '../schemas';

function treeDetail(deps: Deps, id: string) {
  const store = deps.library.open(id);
  const { n } = store.stmt('SELECT count(*) AS n FROM person').get() as { n: number };
  return {
    ...deps.library.info(id),
    peopleCount: n,
    homePersonId: meta.getHomePersonId(store),
    schemaVersion: LATEST_SCHEMA_VERSION,
  };
}

function hasBatch(store: TreeStore, state: 'applied' | 'undone'): boolean {
  return store.stmt('SELECT 1 FROM change_batch WHERE state = ? LIMIT 1').get(state) !== undefined;
}

/** Trees, home person, tags, history and export. */
export function treeRoutes(app: Api, deps: Deps): void {
  const { library } = deps;

  app.get('/api/trees', async () => ({ trees: library.list() }));

  app.post('/api/trees', { schema: { body: TreeBody } }, async (request, reply) => {
    library.create(request.body.name);
    return reply.code(201).send({ tree: treeDetail(deps, request.body.name) });
  });

  app.get('/api/trees/:tree', { schema: { params: TreeParams } }, async (request) => ({
    tree: treeDetail(deps, request.params.tree),
  }));

  app.patch(
    '/api/trees/:tree',
    { schema: { params: TreeParams, body: TreeBody } },
    async (request) => {
      library.rename(request.params.tree, request.body.name);
      return { tree: treeDetail(deps, request.body.name) };
    },
  );

  app.delete('/api/trees/:tree', { schema: { params: TreeParams } }, async (request, reply) => {
    library.delete(request.params.tree);
    return reply.code(204).send();
  });

  app.get('/api/trees/:tree/home', { schema: { params: TreeParams } }, async (request) => {
    const store = library.open(request.params.tree);
    const personId = meta.getHomePersonId(store);
    return { personId, person: personId ? getPersonSummary(store, personId) : null };
  });

  app.put(
    '/api/trees/:tree/home',
    { schema: { params: TreeParams, body: HomeBody } },
    async (request) => {
      const store = library.open(request.params.tree);
      const { personId } = request.body;
      const { batchId } = edit(store, 'Set home person', (tx) => meta.setHomePerson(tx, personId));
      return { batchId, personId };
    },
  );

  app.get('/api/trees/:tree/tags', { schema: { params: TreeParams } }, async (request) => {
    const store = library.open(request.params.tree);
    const items = store
      .stmt(
        `SELECT t.*, (SELECT count(*) FROM tag_link l WHERE l.tag_id = t.id AND l.owner_type = 'person') AS people
         FROM tag t ORDER BY t.category, t.name, t.id`,
      )
      .all();
    return { items };
  });

  app.get(
    '/api/trees/:tree/history',
    { schema: { params: TreeParams, querystring: HistoryQuery } },
    async (request) => {
      const store = library.open(request.params.tree);
      return {
        items: listBatches(store, { limit: request.query.limit ?? 50 }),
        canUndo: hasBatch(store, 'applied'),
        canRedo: hasBatch(store, 'undone'),
      };
    },
  );

  app.post('/api/trees/:tree/undo', { schema: { params: TreeParams } }, async (request) => {
    const store = library.open(request.params.tree);
    return { batch: undoLast(store) };
  });

  app.post('/api/trees/:tree/redo', { schema: { params: TreeParams } }, async (request) => {
    const store = library.open(request.params.tree);
    return { batch: redoLast(store) };
  });

  app.get(
    '/api/trees/:tree/export.json',
    { schema: { params: TreeParams } },
    async (request, reply) => {
      const { tree } = request.params;
      const json = exportJsonString(library.open(tree));
      return reply
        .type('application/json; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="tree.json"; filename*=UTF-8''${encodeURIComponent(tree)}.json`,
        )
        .send(json);
    },
  );
}
