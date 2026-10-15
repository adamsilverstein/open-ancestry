import {
  LATEST_SCHEMA_VERSION,
  exportJsonString,
  getPersonSummary,
  listBatches,
  meta,
  redoLast,
  undo,
  undoLatest,
  type TreeStore,
} from '@open-ancestry/db';
import {
  GedzipTooLargeError,
  buildGedcomExport,
  planGedzipExport,
  streamGedzip,
} from '@open-ancestry/export';
import type { Api, Deps } from '../context';
import { edit } from '../edits';
import {
  ExportQuery,
  GedzipQuery,
  HistoryQuery,
  HomeBody,
  TreeBody,
  TreeParams,
  UndoQuery,
} from '../schemas';
import { conflict, notNewest } from '../errors';

function treeDetail(deps: Deps, id: string) {
  const store = deps.library.open(id);
  const { n } = store.stmt('SELECT count(*) AS n FROM person').get() as { n: number };
  // Who a privatized export hides: living people (isLiving: living, inferred or unknown),
  // and anyone else marked private or confidential (locked only guards edits).
  const hidden = store
    .stmt(
      `SELECT
         sum(living IN ('living', 'inferred_living', 'unknown')) AS living,
         sum(living NOT IN ('living', 'inferred_living', 'unknown') AND privacy IN ('private', 'confidential')) AS private
       FROM person`,
    )
    .get() as { living: number | null; private: number | null };
  return {
    ...deps.library.info(id),
    peopleCount: n,
    livingCount: hidden.living ?? 0,
    privateCount: hidden.private ?? 0,
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

/** Export warnings shown by the dialog: the count, and the first few as percent-encoded JSON. */
export const WARNING_COUNT_HEADER = 'x-oa-export-warning-count';
export const WARNINGS_HEADER = 'x-oa-export-warnings';
const MAX_HEADER_WARNINGS = 20;

function warningHeaders(warnings: string[]): Record<string, string> {
  return {
    [WARNING_COUNT_HEADER]: String(warnings.length),
    [WARNINGS_HEADER]: encodeURIComponent(JSON.stringify(warnings.slice(0, MAX_HEADER_WARNINGS))),
  };
}

/** A privatized download is not named after the tree: tree names are often surnames. */
const downloadName = (tree: string, privatize: boolean | undefined) =>
  privatize ? 'private-tree' : tree;

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

  app.post(
    '/api/trees/:tree/undo',
    { schema: { params: TreeParams, querystring: UndoQuery } },
    async (request) => {
      const store = library.open(request.params.tree);
      const { expect } = request.query;
      if (expect === undefined) {
        // `skipped`: newer batches stepped over because the NFC upgrade made them un-undoable.
        return undoLatest(store);
      }
      // A toast's Undo names its own batch: undo exactly that one, and only while nothing
      // newer exists, so it never undoes a later change in its place.
      const newest = store
        .stmt("SELECT id FROM change_batch WHERE state = 'applied' ORDER BY seq DESC LIMIT 1")
        .get() as { id: string } | undefined;
      if (newest?.id !== expect) {
        throw notNewest('Newer changes were made since; undo them from History first');
      }
      return { batch: undo(store, expect), skipped: [] };
    },
  );

  app.post('/api/trees/:tree/redo', { schema: { params: TreeParams } }, async (request) => {
    const store = library.open(request.params.tree);
    return { batch: redoLast(store), skipped: [] };
  });

  app.get(
    '/api/trees/:tree/export.json',
    { schema: { params: TreeParams } },
    async (request, reply) => {
      const { tree } = request.params;
      // Mid-import the tree is not the user's yet: export it once the import ends (#186).
      library.assertIdle(tree);
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
      // Mid-import the tree is not the user's yet: export it once the import ends (#186).
      library.assertIdle(tree);
      const { text, warnings } = buildGedcomExport(library.open(tree), {
        version: request.query.version ?? '5.5.1',
        privatizeLiving: request.query.privatize ?? false,
      });
      return reply
        .type('text/vnd.familysearch.gedcom; charset=utf-8')
        .header(
          'content-disposition',
          attachment(downloadName(tree, request.query.privatize), 'ged'),
        )
        .headers(warningHeaders(warnings))
        .send(text);
    },
  );

  app.get(
    '/api/trees/:tree/export.gdz',
    { schema: { params: TreeParams, querystring: GedzipQuery } },
    async (request, reply) => {
      const { tree } = request.params;
      // Mid-import the tree is not the user's yet: export it once the import ends (#186).
      library.assertIdle(tree);
      // The GEDCOM text and media list are taken now, in one snapshot; the
      // media bytes are streamed one file at a time, so memory stays bounded
      // and other requests keep being served (#198).
      let plan;
      try {
        plan = planGedzipExport(library.open(tree), {
          privatizeLiving: request.query.privatize ?? false,
        });
      } catch (error) {
        if (error instanceof GedzipTooLargeError) throw conflict(error.message);
        throw error;
      }
      const { warnings } = plan;
      return reply
        .type('application/vnd.familysearch.gedcom+zip')
        .header(
          'content-disposition',
          attachment(downloadName(tree, request.query.privatize), 'gdz'),
        )
        .headers(warningHeaders(warnings))
        .send(streamGedzip(plan));
    },
  );
}
