import { existsSync, readFileSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { constants as zlib } from 'node:zlib';
import fastifyCompress from '@fastify/compress';
import fastifyEtag from '@fastify/etag';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  IMPORT_LIMITS,
  prepareReimport,
  resolveImportLimits,
  type ImportLimits,
} from '@open-ancestry/import';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { Deps } from './context';
import { errorBody, registerErrorHandling, toApiError } from './errors';
import { JobManager, type Comparer, type Importer } from './jobs';
import { Library, defaultLibraryRoot } from './library';
import { checkRoutes } from './routes/checks';
import { editRoutes } from './routes/edit';
import { importRoutes, sweepStaleUploads } from './routes/imports';
import { reimportRoutes } from './routes/reimports';
import { ReimportSessions } from './reimports';
import { mediaRoutes } from './routes/media';
import { peopleRoutes } from './routes/people';
import { treeRoutes } from './routes/trees';
import { galleryRoutes } from './routes/gallery';
import { ThumbnailQueue } from './thumbnails';
import { SECURITY_HEADERS, createToken, isLoopbackHost, registerSecurity } from './security';
import { sendShell } from './shell';
import { staticFileIndex } from './static-files';
import { lazyValidatorFactory, plainSerializerFactory } from './validation';

export { Library, defaultLibraryRoot, treeNameProblem } from './library';
export {
  JobManager,
  type Importer,
  type ImporterOptions,
  type ImportProgress,
  type JobView,
} from './jobs';
export { SECURITY_HEADERS, TOKEN_HEADER, isLoopbackHost } from './security';
export {
  IMPORT_RESOURCE_LIMITS,
  devWorkerComparer,
  devWorkerImporter,
  workerComparer,
  workerImporter,
  type WorkerImporterOptions,
} from './import-runner';

declare module 'fastify' {
  interface FastifyInstance {
    /** Cancels what can be cancelled, waits for every job and thumbnail to finish. */
    drain(): Promise<void>;
  }
}

export interface ServerOptions {
  /** Directory containing the built web app (index.html + assets). */
  staticDir?: string | undefined;
  logger?: boolean;
  /** Library folder or instance (default OA_LIBRARY or ~/OpenAncestry). Created on first use. */
  library?: string | Library;
  /** GEDCOM importer; without one the import endpoint answers 501. */
  importer?: Importer;
  /**
   * Re-import compare; default runs on the server's thread (fine for tests).
   * The CLI and dev server pass `workerComparer` so it never blocks (#161).
   */
  comparer?: Comparer;
  /** Mutation token; random per process by default. */
  token?: string;
  /** Hostnames accepted in the Host header besides loopback. */
  allowedHosts?: readonly string[];
  /**
   * The importer's caps, which also size import uploads (default
   * IMPORT_LIMITS). Pass the same ones to the importer.
   */
  importLimits?: Partial<ImportLimits>;
  /** Largest GEDCOM upload in bytes (default: importLimits.maxBytes, 64 MiB). */
  uploadLimit?: number;
  /** Largest GEDZIP upload in bytes (default: importLimits.maxArchiveBytes, 1 GiB). */
  archiveUploadLimit?: number;
  /** Largest media upload in bytes (default 1 GiB). */
  mediaUploadLimit?: number;
  /** Concurrent imports (default 1) and how many may wait (default 4). */
  importConcurrency?: number;
  maxQueuedImports?: number;
}

export interface StartOptions extends ServerOptions {
  /** Defaults to loopback; the app holds private data and must not be exposed. */
  host?: string;
  port?: number;
}

export interface RunningServer {
  url: string;
  app: FastifyInstance;
  close: () => Promise<void>;
}

export const DEFAULT_HOST = '127.0.0.1';
/** GEDCOM uploads: no larger than the importer accepts (IMPORT_LIMITS.maxBytes). */
export const DEFAULT_UPLOAD_LIMIT = IMPORT_LIMITS.maxBytes;
/** GEDZIP uploads, photos included (IMPORT_LIMITS.maxArchiveBytes). */
export const DEFAULT_ARCHIVE_UPLOAD_LIMIT = IMPORT_LIMITS.maxArchiveBytes;
export const DEFAULT_MEDIA_UPLOAD_LIMIT = 1024 * 1024 * 1024;
/** JSON bodies are small edits; uploads go through multipart with their own limit. */
export const JSON_BODY_LIMIT = 1024 * 1024;

/** Hashed build assets never change, so browsers may cache them forever. */
function staticHeaders(reply: FastifyReply, path: string) {
  const hashed = /[\\/]assets[\\/]/.test(path);
  reply.header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
}

/**
 * Node's HTTP parser rejects malformed requests (bad request line, headers
 * over 16 KB) before Fastify sees them; answer with the security headers too.
 */
export function handleClientError(error: Error & { code?: string }, socket: Duplex): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const status = error.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
  const body = JSON.stringify(errorBody('bad_request', 'Malformed request'));
  const headers = Object.entries(SECURITY_HEADERS).map(([name, value]) => `${name}: ${value}\r\n`);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n${headers.join('')}` +
      'content-type: application/json; charset=utf-8\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  );
}

export function createServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: JSON_BODY_LIMIT,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array' } },
    schemaController: {
      compilersFactory: {
        buildValidator: lazyValidatorFactory(),
        // No route declares a response schema, so skip loading fast-json-stringify.
        buildSerializer: plainSerializerFactory,
      },
    },
    clientErrorHandler: handleClientError,
    // Router-level failures (malformed URL, bad content type) get the typed envelope too.
    frameworkErrors: (error, _request, reply: FastifyReply) => {
      const api = toApiError(error);
      // These replies skip the request hooks, so add the headers here.
      return reply
        .headers(SECURITY_HEADERS)
        .code(api.statusCode)
        .send(errorBody(api.code, api.message));
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  const library =
    options.library instanceof Library
      ? options.library
      : new Library(options.library ?? defaultLibraryRoot());
  const jobs = new JobManager({
    concurrency: options.importConcurrency,
    maxQueued: options.maxQueuedImports,
  });
  // Leftovers of imports a crash or restart interrupted: their empty trees and uploads.
  library.sweepInterruptedImports();
  library.sweepReimportLeftovers();
  void sweepStaleUploads();
  const importLimits = resolveImportLimits(options.importLimits);
  const deps: Deps = {
    library,
    jobs,
    importer: options.importer,
    comparer:
      options.comparer ??
      ((path, store, { onProgress, signal }) =>
        prepareReimport(
          store,
          { path },
          {
            signal,
            onProgress: (phase, done, total) => onProgress({ phase, done, total }),
          },
        )),
    uploadLimit: options.uploadLimit ?? importLimits.maxBytes,
    archiveUploadLimit: options.archiveUploadLimit ?? importLimits.maxArchiveBytes,
    mediaUploadLimit: options.mediaUploadLimit ?? DEFAULT_MEDIA_UPLOAD_LIMIT,
    thumbnails: new ThumbnailQueue(),
    reimports: new ReimportSessions(),
  };

  registerErrorHandling(app);
  // Lets clients and tests read server-side latency without network noise.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('server-timing', `app;dur=${reply.elapsedTime.toFixed(2)}`);
    return payload;
  });
  registerSecurity(app, {
    token: options.token ?? createToken(),
    allowedHosts: options.allowedHosts,
  });
  // ETag hashes the uncompressed body, so it must run before compression.
  app.register(fastifyEtag, { weak: true });
  app.register(fastifyCompress, {
    threshold: 1024,
    encodings: ['br', 'gzip'],
    // Default Brotli quality (11) costs tens of ms per response; 4 is near gzip speed.
    brotliOptions: { params: { [zlib.BROTLI_PARAM_QUALITY]: 4 } },
  });
  app.register(fastifyMultipart, { throwFileSizeLimit: true });

  app.register(async (api) => {
    const typed = api.withTypeProvider<TypeBoxTypeProvider>();
    // No write may reach a tree while it imports: it would run inside the
    // import's transaction and share its fate (issue #96). Reads still work.
    typed.addHook('preHandler', async (request) => {
      if (request.method === 'GET' || request.method === 'HEAD') return;
      const tree = (request.params as { tree?: unknown } | undefined)?.tree;
      if (typeof tree === 'string') library.assertIdle(tree);
    });
    typed.get('/api/health', async () => ({ ok: true }));
    treeRoutes(typed, deps);
    peopleRoutes(typed, deps);
    editRoutes(typed, deps);
    checkRoutes(typed, deps);
    importRoutes(typed, deps);
    reimportRoutes(typed, deps);
    mediaRoutes(typed, deps);
    galleryRoutes(typed, deps);
  });

  const { staticDir } = options;
  const hasSpa = staticDir !== undefined && existsSync(join(staticDir, 'index.html'));
  const indexHtml = hasSpa ? readFileSync(join(staticDir, 'index.html'), 'utf8') : '';
  const isBuildFile = hasSpa ? staticFileIndex(staticDir) : () => false;
  if (hasSpa) {
    app.register(fastifyStatic, {
      root: staticDir,
      // One wildcard route instead of a route per file, which needs a glob of
      // the build at startup (cold start, #54). Only exact files of the build
      // are served; everything else (missing, dotfiles, directories, case
      // variants, the raw index.html) falls through to the shell.
      wildcard: true,
      setHeaders: staticHeaders,
      index: false,
      dotfiles: 'deny',
      allowedPath: (pathName) => isBuildFile(pathName),
    });
    app.get('/', (_request, reply) => sendShell(reply, indexHtml));
    // Any other read that is not exactly a file of the build gets the shell
    // before @fastify/static sees it, so it never serves dotfiles, directories
    // or case aliases, and its own 403s never surface.
    app.addHook('onRequest', async (request, reply) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') return;
      const path = request.url.split('?', 1)[0]!;
      if (path === '/' || path === '/api' || path.startsWith('/api/') || isBuildFile(path)) return;
      return sendShell(reply, indexHtml);
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url === '/api' || request.url.startsWith('/api/');
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    if (hasSpa && isRead && !isApi) {
      // Client-side routes (/tree/:id, /person/:id) all load the SPA shell.
      return sendShell(reply, indexHtml);
    }
    return reply
      .code(404)
      .send(errorBody('not_found', `No route for ${request.method} ${request.url}`));
  });

  // Before the HTTP server stops: aborting jobs ends their event streams, which
  // close() would otherwise wait on forever, and runs their cleanup. A job past
  // the point of no return saves first, which can take longer than Fastify's
  // 10s hook timeout, so startServer drains before close(); this hook then has
  // nothing left to wait for (and still covers a plain app.close()).
  const drain = async () => {
    await jobs.shutdown();
    await deps.thumbnails.idle();
  };
  app.decorate('drain', drain);
  app.addHook('preClose', drain);
  app.addHook('onClose', async () => {
    deps.reimports.closeAll();
    library.closeAll();
  });

  return app;
}

/**
 * Host header names to accept besides loopback when bound to `host`: the host
 * itself, or every interface address for a wildcard bind (0.0.0.0 or ::).
 */
export function allowedHostsFor(host: string): string[] {
  if (isLoopbackHost(host)) return [];
  const bracket = (h: string) => (h.includes(':') ? `[${h}]` : h);
  if (host !== '0.0.0.0' && host !== '::') return [bracket(host)];
  return Object.values(networkInterfaces())
    .flat()
    .flatMap((i) => (i ? [bracket(i.address)] : []));
}

export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const host = options.host ?? DEFAULT_HOST;
  const allowedHosts = [...(options.allowedHosts ?? []), ...allowedHostsFor(host)];
  const app = createServer({ ...options, allowedHosts });
  await app.listen({ host, port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    app,
    // Drain outside close(): its preClose hooks time out after 10s.
    close: async () => {
      await app.drain();
      await app.close();
    },
  };
}
