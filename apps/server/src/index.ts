import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

export interface ServerOptions {
  /** Directory containing the built web app (index.html + assets). */
  staticDir?: string | undefined;
  logger?: boolean;
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

export function createServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/api/health', async () => ({ ok: true }));

  const { staticDir } = options;
  const hasSpa = staticDir !== undefined && existsSync(join(staticDir, 'index.html'));
  if (hasSpa) {
    app.register(fastifyStatic, { root: staticDir, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url === '/api' || request.url.startsWith('/api/');
    if (hasSpa && request.method === 'GET' && !isApi) {
      // Client-side routes (/tree/:id, /person/:id) all load the SPA shell.
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: `No route for ${request.url}` });
  });

  return app;
}

export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const app = createServer(options);
  const host = options.host ?? DEFAULT_HOST;
  await app.listen({ host, port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    url: `http://${host}:${port}`,
    app,
    close: () => app.close(),
  };
}
