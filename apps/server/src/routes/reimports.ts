import { ReimportStaleError, applyReimport } from '@open-ancestry/import';
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

  app.get('/api/reimports/:id', { schema: { params: JobParams } }, async (request) => {
    const { id, tree, fileName, createdAt, session } = find(request.params.id);
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
      diff: session.diff,
    };
  });

  app.post(
    '/api/reimports/:id/apply',
    { schema: { params: JobParams, body: ReimportApplyBody } },
    async (request) => {
      const stored = find(request.params.id);
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
