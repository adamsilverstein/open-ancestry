import {
  ReimportStaleError,
  applyReimport,
  isReimportStale,
  refreshReimport,
} from '@open-ancestry/import';
import type { Api, Deps } from '../context';
import { conflict, notFound } from '../errors';
import { JobParams, ReimportApplyBody, ReimportStatusQuery } from '../schemas';

/** Review, apply and discard re-imports started by `POST /api/trees/:tree/reimport`. */
export function reimportRoutes(app: Api, { library, reimports, thumbnails }: Deps): void {
  const find = (id: string) => {
    const stored = reimports.get(id);
    if (!stored) throw notFound(`Re-import ${id} not found (it may have expired)`);
    return stored;
  };

  const view = (stored: ReturnType<typeof find>) => {
    const { id, tree, fileName, createdAt, session } = stored;
    const { report } = session;
    return {
      id,
      tree,
      fileName,
      createdAt,
      source: report.source,
      warningCount: report.warningCount,
      lines: report.lines,
      // Files found in the export (GEDZIP or media folder), as the import report counts them.
      media: report.media,
      timings: session.timings,
      /** Which comparison the change ids belong to: send it back with apply and status. */
      comparison: session.comparison,
      /** The tree changed since the comparison: apply would be refused (#163). */
      stale: isReimportStale(library.open(tree), session),
      // familyMatches is apply's bookkeeping; the review doesn't need it.
      diff: { people: session.diff.people, counts: session.diff.counts },
    };
  };

  app.get('/api/reimports/:id', { schema: { params: JobParams } }, async (request) =>
    view(find(request.params.id)),
  );

  // Cheap enough to ask on every focus of the review page.
  // Stale too when the client holds an older comparison (another tab compared again).
  app.get(
    '/api/reimports/:id/status',
    { schema: { params: JobParams, querystring: ReimportStatusQuery } },
    async (request) => {
      const { tree, session } = find(request.params.id);
      const { comparison } = request.query;
      return {
        stale:
          (comparison !== undefined && comparison !== session.comparison) ||
          isReimportStale(library.open(tree), session),
      };
    },
  );

  // Compare the same export again with the tree as it is now.
  app.post('/api/reimports/:id/refresh', { schema: { params: JobParams } }, async (request) => {
    const stored = find(request.params.id);
    // No :tree param, so the global busy check can't see this request (issue #96).
    library.assertIdle(stored.tree);
    refreshReimport(library.open(stored.tree), stored.session);
    return view(stored);
  });

  app.post(
    '/api/reimports/:id/apply',
    { schema: { params: JobParams, body: ReimportApplyBody } },
    async (request) => {
      const stored = find(request.params.id);
      // Ids are renumbered by every comparison: never apply ids from another one.
      if (request.body.comparison !== stored.session.comparison) {
        throw conflict('This review was compared again elsewhere; reload it before applying');
      }
      // No :tree param, so the global busy check can't see this write (issue #96).
      library.assertIdle(stored.tree);
      const store = library.open(stored.tree);
      try {
        const result = await library.whileBusy(stored.tree, async () =>
          applyReimport(
            store,
            stored.session,
            new Set(request.body.accept),
            `Re-import ${stored.fileName}`,
          ),
        );
        reimports.remove(stored.id);
        const dir = library.dirOf(stored.tree);
        for (const id of result.media.copied) {
          const media = store.getRow('media', id);
          // A replaced file (#75) must not keep the old file's thumbnails.
          if (media?.local_path) await thumbnails.refresh(dir, id, media.local_path);
        }
        return result;
      } catch (error) {
        if (error instanceof ReimportStaleError) throw conflict(error.message);
        throw error;
      }
    },
  );

  app.delete('/api/reimports/:id', { schema: { params: JobParams } }, async (request, reply) => {
    find(request.params.id);
    reimports.remove(request.params.id);
    return reply.code(204).send();
  });
}
