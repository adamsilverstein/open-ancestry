import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { treePaths } from '@open-ancestry/db';
import type { Api, Deps } from '../context';
import { ApiError, badRequest, notFound } from '../errors';
import { TooManyJobsError, type JobEvent } from '../jobs';
import { JobParams, TreeParams } from '../schemas';

export const IMPORT_EXTENSIONS = new Set(['.ged', '.gedcom', '.zip', '.gdz']);

/** Import uploads (multipart, streamed to a temp file) and job status over JSON and SSE. */
export function importRoutes(app: Api, { library, jobs, importer, uploadLimit }: Deps): void {
  app.post(
    '/api/trees/:tree/import',
    { schema: { params: TreeParams } },
    async (request, reply) => {
      const { tree } = request.params;
      library.open(tree);
      if (!importer) throw new ApiError(501, 'not_implemented', 'GEDCOM import is not available');
      if (!request.isMultipart()) {
        throw new ApiError(415, 'unsupported_media_type', 'Upload the file as multipart/form-data');
      }
      const file = await request.file({ limits: { fileSize: uploadLimit, files: 1, fields: 0 } });
      if (!file) throw badRequest('Attach a GEDCOM or GEDZIP file');
      const extension = extname(file.filename).toLowerCase();
      if (!IMPORT_EXTENSIONS.has(extension)) {
        file.file.resume();
        throw new ApiError(
          415,
          'unsupported_media_type',
          `Expected a ${[...IMPORT_EXTENSIONS].join(', ')} file`,
        );
      }

      // The upload is untrusted: only its extension is used in the temp path.
      const dir = await mkdtemp(join(tmpdir(), 'oa-upload-'));
      const cleanup = () => rm(dir, { recursive: true, force: true });
      const path = join(dir, `upload${extension}`);
      try {
        await pipeline(file.file, createWriteStream(path, { flags: 'wx' }));
        if (file.file.truncated) {
          throw new ApiError(
            413,
            'payload_too_large',
            `Uploads are limited to ${uploadLimit} bytes`,
          );
        }
        const job = jobs.enqueue(
          { tree, fileName: basename(file.filename).slice(0, 255) },
          (signal, onProgress) =>
            library.whileBusy(tree, () =>
              importer(path, library.open(tree), {
                mediaDir: treePaths(library.dirOf(tree)).media,
                onProgress,
                signal,
              }),
            ),
          cleanup,
        );
        return reply.code(202).send({ jobId: job.id, job });
      } catch (error) {
        await cleanup();
        if (error instanceof TooManyJobsError)
          throw new ApiError(429, 'too_many_jobs', error.message);
        throw error;
      }
    },
  );

  app.get('/api/jobs/:id', { schema: { params: JobParams } }, async (request) => {
    const job = jobs.get(request.params.id);
    if (!job) throw notFound(`Job ${request.params.id} not found`);
    return job;
  });

  // Server-sent events: `state` (full job) on connect and on every change,
  // `progress` while running; the stream ends when the job finishes.
  app.get('/api/jobs/:id/events', { schema: { params: JobParams } }, async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) throw notFound(`Job ${request.params.id} not found`);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const send = (event: JobEvent) => {
      res.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event.type === 'state' ? event.job : event.progress)}\n\n`,
      );
      if (
        event.type === 'state' &&
        (event.job.state === 'completed' || event.job.state === 'failed')
      ) {
        unsubscribe();
        res.end();
      }
    };
    const unsubscribe = jobs.subscribe(job.id, send);
    request.raw.on('close', unsubscribe);
    send({ type: 'state', job });
  });
}
