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
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { Deps } from './context';
import { errorBody, registerErrorHandling, toApiError } from './errors';
import { JobManager, type Importer } from './jobs';
import { Library, defaultLibraryRoot } from './library';
import { editRoutes } from './routes/edit';
import { importRoutes, sweepStaleUploads } from './routes/imports';
import { mediaRoutes } from './routes/media';
import { peopleRoutes } from './routes/people';
import { treeRoutes } from './routes/trees';
import { SECURITY_HEADERS, createToken, isLoopbackHost, registerSecurity } from './security';
import { sendShell } from './shell';
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

export interface ServerOptions {
  /** Directory containing the built web app (index.html + assets). */
  staticDir?: string | undefined;
  logger?: boolean;
  /** Library folder or instance (default OA_LIBRARY or ~/OpenAncestry). Created on first use. */
  library?: string | Library;
  /** GEDCOM importer; without one the import endpoint answers 501. */
  importer?: Importer;
  /** Mutation token; random per process by default. */
  token?: string;
  /** Hostnames accepted in the Host header besides loopback. */
  allowedHosts?: readonly string[];
  /** Largest import upload in bytes (default 1 GiB). */
  uploadLimit?: number;
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
export const DEFAULT_UPLOAD_LIMIT = 1024 * 1024 * 1024;
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
  void sweepStaleUploads();
  const deps: Deps = {
    library,
    jobs,
    importer: options.importer,
    uploadLimit: options.uploadLimit ?? DEFAULT_UPLOAD_LIMIT,
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
    typed.get('/api/health', async () => ({ ok: true }));
    treeRoutes(typed, deps);
    peopleRoutes(typed, deps);
    editRoutes(typed, deps);
    importRoutes(typed, deps);
    mediaRoutes(typed, deps);
  });

  const { staticDir } = options;
  const hasSpa = staticDir !== undefined && existsSync(join(staticDir, 'index.html'));
  const indexHtml = hasSpa ? readFileSync(join(staticDir, 'index.html'), 'utf8') : '';
  if (hasSpa) {
    app.register(fastifyStatic, {
      root: staticDir,
      // One wildcard route instead of a route per file, which needs a glob of
      // the build at startup (cold start, #54). Missing files fall through to
      // the not-found handler, which serves the shell.
      wildcard: true,
      setHeaders: staticHeaders,
      // The shell is rendered per request (CSP nonce), never served as a file.
      index: false,
      allowedPath: (pathName) => pathName !== '/index.html',
    });
    app.get('/', (_request, reply) => sendShell(reply, indexHtml));
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
  // close() would otherwise wait on forever, and runs their cleanup.
  app.addHook('preClose', async () => {
    await jobs.shutdown();
  });
  app.addHook('onClose', async () => {
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
    close: () => app.close(),
  };
}
