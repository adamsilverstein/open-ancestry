import { rm } from 'node:fs/promises';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { createServer, type ServerOptions } from '../index';
import { makeTempDir } from '../../../../fixtures/temp-dir';

export const TOKEN = 'test-token-0123456789';
export const HOST = '127.0.0.1:4317';
export const ORIGIN = `http://${HOST}`;
/** Headers the SPA sends with every mutation. */
export const MUTATION_HEADERS = { host: HOST, origin: ORIGIN, 'x-oa-token': TOKEN };

export interface TestApi {
  app: FastifyInstance;
  root: string;
  get(url: string, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  post(url: string, body?: unknown): Promise<LightMyRequestResponse>;
  put(url: string, body?: unknown): Promise<LightMyRequestResponse>;
  patch(url: string, body?: unknown): Promise<LightMyRequestResponse>;
  del(url: string): Promise<LightMyRequestResponse>;
  inject(options: InjectOptions): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

/** A server over a fresh temporary library. */
export async function testApi(options: ServerOptions = {}): Promise<TestApi> {
  const root = makeTempDir('oa-lib-');
  const app = createServer({ library: root, token: TOKEN, ...options });
  await app.ready();
  const write = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE') => (url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: MUTATION_HEADERS,
      ...(body === undefined ? {} : { payload: body as object }),
    });
  return {
    app,
    root,
    get: (url, headers = {}) =>
      app.inject({ method: 'GET', url, headers: { host: HOST, ...headers } }),
    post: write('POST'),
    put: write('PUT'),
    patch: write('PATCH'),
    del: write('DELETE'),
    inject: (options) => app.inject(options),
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Creates a tree and returns its API base path. */
export async function createTestTree(api: TestApi, name = 'Test'): Promise<string> {
  const res = await api.post('/api/trees', { name });
  if (res.statusCode !== 201) throw new Error(`create tree failed: ${res.body}`);
  return `/api/trees/${encodeURIComponent(name)}`;
}

export interface Seeded {
  base: string;
  /** Ada Vale (focus), her parents Bram and Cora Vale, husband Dan Reed, child Eve Reed. */
  ada: string;
  bram: string;
  cora: string;
  dan: string;
  eve: string;
  marriage: string;
}

const person = (
  given: string,
  surname: string,
  sex: 'M' | 'F',
  birth?: string,
  place?: string,
) => ({
  sex,
  names: [{ given, surname }],
  ...(birth ? { events: [{ type: 'BIRT', date_text: birth, ...(place ? { place } : {}) }] } : {}),
});

/** A small synthetic family built through the API. */
export async function seed(api: TestApi): Promise<Seeded> {
  const base = await createTestTree(api);
  const json = async (res: Promise<LightMyRequestResponse>) => {
    const r = await res;
    if (r.statusCode >= 300) throw new Error(`${r.statusCode} ${r.body}`);
    return r.json();
  };
  const ada = (
    await json(
      api.post(
        `${base}/people`,
        person('Ada', 'Vale', 'F', '5 SEP 1941', 'Harlow, Essex, England'),
      ),
    )
  ).person.id;
  const father = await json(
    api.post(`${base}/people/${ada}/parents`, { person: person('Bram', 'Vale', 'M', 'ABT 1910') }),
  );
  const mother = await json(
    api.post(`${base}/people/${ada}/parents`, { person: person('Cora', 'Vale', 'F', '1912') }),
  );
  const spouse = await json(
    api.post(`${base}/people/${ada}/spouses`, {
      person: person('Dan', 'Reed', 'M', '1940'),
      relationship_type: 'married',
    }),
  );
  const child = await json(
    api.post(`${base}/people/${ada}/children`, {
      familyId: spouse.family.id,
      person: person('Eve', 'Reed', 'F', '1965'),
    }),
  );
  return {
    base,
    ada,
    bram: father.parentId,
    cora: mother.parentId,
    dan: spouse.spouseId,
    eve: child.childId,
    marriage: spouse.family.id,
  };
}
