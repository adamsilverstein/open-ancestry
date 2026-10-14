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
import { exportGedcom, exportGedzip } from '@open-ancestry/export';
import type { Api, Deps } from '../context';
import { edit } from '../edits';
import { ExportQuery, GedzipQuery, HistoryQuery, HomeBody, TreeBody, TreeParams } from '../schemas';

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

/**
 * Content-Disposition for a download named after the tree: an ASCII fallback
 * (anything outside letters, digits, space, dot, dash and underscore becomes
 * `_`, so no quote or header syntax gets through) plus the exact UTF-8 name.
 */
export function attachment(tree: string, extension: string): string {
  const ascii = tree.replace(/[^A-Za-z0-9 ._-]/g, '_');
  // RFC 8187 ext-value: encodeURIComponent leaves ' ( ) * as they are, which are not allowed.
  const utf8 = encodeURIComponent(tree).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}.${extension}"; filename*=UTF-8''${utf8}.${extension}`;
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
        .header('content-disposition', attachment(tree, 'json'))
        .send(json);
    },
  );

  app.get(
    '/api/trees/:tree/export.ged',
    { schema: { params: TreeParams, querystring: ExportQuery } },
    async (request, reply) => {
      const { tree } = request.params;
      const text = exportGedcom(library.open(tree), {
        version: request.query.version ?? '5.5.1',
        privatizeLiving: request.query.privatize ?? false,
      });
      return reply
        .type('text/vnd.familysearch.gedcom; charset=utf-8')
        .header('content-disposition', attachment(tree, 'ged'))
        .send(text);
    },
  );

  app.get(
    '/api/trees/:tree/export.gdz',
    { schema: { params: TreeParams, querystring: GedzipQuery } },
    async (request, reply) => {
      const { tree } = request.params;
      const bytes = exportGedzip(library.open(tree), {
        privatizeLiving: request.query.privatize ?? false,
      });
      return reply
        .type('application/vnd.familysearch.gedcom+zip')
        .header('content-disposition', attachment(tree, 'gdz'))
        .send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    },
  );
}
