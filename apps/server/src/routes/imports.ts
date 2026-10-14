import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import type { Api, Deps } from '../context';
import { ApiError, badRequest, conflict, notFound } from '../errors';
import { TooManyJobsError, type JobEvent } from '../jobs';
import { JobParams, TreeParams } from '../schemas';

export const IMPORT_EXTENSIONS = new Set(['.ged', '.gedcom', '.zip', '.gdz']);

export const UPLOAD_PREFIX = 'oa-upload-';
/** Upload folders older than this are left over from a crash and swept on startup. */
export const STALE_UPLOAD_MS = 6 * 60 * 60 * 1000;

/** Startup: removes upload temp folders an earlier, interrupted server left behind. */
export async function sweepStaleUploads(now = Date.now(), dir = tmpdir()): Promise<number> {
  let removed = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(UPLOAD_PREFIX)) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isDirectory() || now - info.mtimeMs < STALE_UPLOAD_MS) continue;
    await rm(path, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** Import uploads (multipart, streamed to a temp file) and job status over JSON and SSE. */
export function importRoutes(app: Api, deps: Deps): void {
  const { library, jobs, importer, uploadLimit, thumbnails } = deps;

  /** Streams the one uploaded file to a private temp folder. */
  async function receive(request: FastifyRequest) {
    if (!importer) throw new ApiError(501, 'not_implemented', 'GEDCOM import is not available');
    // Refuse before streaming up to the size cap to disk for a job that cannot queue.
    if (!jobs.hasRoom()) {
      throw new ApiError(
        429,
        'too_many_jobs',
        'Too many imports are queued; try again when one finishes',
      );
    }
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
    const dir = await mkdtemp(join(tmpdir(), UPLOAD_PREFIX));
    const cleanup = () => rm(dir, { recursive: true, force: true });
    const path = join(dir, `upload${extension}`);
    try {
      await pipeline(file.file, createWriteStream(path, { flags: 'wx' }));
      if (file.file.truncated) {
        throw new ApiError(413, 'payload_too_large', `Uploads are limited to ${uploadLimit} bytes`);
      }
    } catch (error) {
      await cleanup();
      throw error;
    }
    return { path, fileName: basename(file.filename).slice(0, 255), cleanup };
  }

  /**
   * Queues the import of `upload` into `tree`. With a `marker`, the tree was
   * created for this upload: success hands it to the user, and any failure
   * (including a cancel before it ran) removes it if it is still empty.
   */
  function start(tree: string, upload: Awaited<ReturnType<typeof receive>>, marker: string | null) {
    // Busy from queueing to the end of cleanup: no writes may share (or be
    // undone with) the import's transaction (issue #96).
    const release = library.markBusy(tree);
    try {
      return jobs.enqueue(
        { tree, fileName: upload.fileName, createdTree: marker !== null },
        async (signal, onProgress) => {
          const store = library.open(tree);
          const result = await importer!(upload.path, store, { onProgress, signal });
          if (marker) library.clearImportPending(tree, marker);
          thumbnails.enqueueTree(store, library.dirOf(tree));
          return result;
        },
        async () => {
          await upload.cleanup();
          if (marker) library.discardFailedImport(tree, marker);
          release();
        },
      );
    } catch (error) {
      release();
      void upload.cleanup();
      if (marker) library.discardFailedImport(tree, marker);
      if (error instanceof TooManyJobsError)
        throw new ApiError(429, 'too_many_jobs', error.message);
      throw error;
    }
  }

  // Import into a new tree named after the file. The server owns the tree's
  // lifecycle: the client never deletes anything when an import fails.
  app.post('/api/import', async (request, reply) => {
    const upload = await receive(request);
    const marker = randomUUID();
    let tree: string;
    try {
      tree = library.createForImport(upload.fileName, marker);
    } catch (error) {
      await upload.cleanup();
      throw error;
    }
    const job = start(tree, upload, marker);
    return reply.code(202).send({ jobId: job.id, job });
  });

  // Import into an existing, empty tree (never removed by the server).
  app.post(
    '/api/trees/:tree/import',
    { schema: { params: TreeParams } },
    async (request, reply) => {
      const { tree } = request.params;
      const store = library.open(tree);
      // The importer would refuse a tree with data; say so before reading the upload.
      const used = store.db
        .prepare('SELECT (SELECT count(*) FROM person) + (SELECT count(*) FROM import_batch)')
        .pluck()
        .get() as number;
      if (used > 0) throw conflict('Imports go into a new, empty tree');
      const upload = await receive(request);
      const job = start(tree, upload, null);
      return reply.code(202).send({ jobId: job.id, job });
    },
  );

  app.get('/api/jobs/:id', { schema: { params: JobParams } }, async (request) => {
    const job = jobs.get(request.params.id);
    if (!job) throw notFound(`Job ${request.params.id} not found`);
    return job;
  });

  // Cancel: a queued job never runs; a running one is aborted, and its cleanup
  // removes the upload and any empty tree the import created.
  app.delete('/api/jobs/:id', { schema: { params: JobParams } }, async (request, reply) => {
    const { id } = request.params;
    if (!jobs.get(id)) throw notFound(`Job ${id} not found`);
    if (!jobs.cancel(id)) {
      const job = jobs.get(id)!;
      throw conflict(
        job.state === 'running'
          ? `Job ${id} is saving and can no longer be cancelled`
          : `Job ${id} has already finished`,
      );
    }
    return reply.code(202).send({ job: jobs.get(id) });
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
