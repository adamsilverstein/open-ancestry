import {
  ReimportStaleError,
  applyReimport,
  isReimportStale,
  refreshReimport,
} from '@open-ancestry/import';
import type { Api, Deps } from '../context';
import { conflict, notFound } from '../errors';
import { JobParams, ReimportApplyBody } from '../schemas';

/** Review, apply and discard re-imports started by `POST /api/trees/:tree/reimport`. */
export function reimportRoutes(app: Api, { library, reimports }: Deps): void {
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
      timings: session.timings,
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
  app.get('/api/reimports/:id/status', { schema: { params: JobParams } }, async (request) => {
    const { tree, session } = find(request.params.id);
    return { stale: isReimportStale(library.open(tree), session) };
  });

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
