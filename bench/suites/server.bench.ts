import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createServer, Library } from '../../apps/server/src/index';
import { bulkInsert, generateSyntheticTree } from '../../packages/db/src/index';
import type { BenchCase } from '../types';

// API budgets from design.md section 7, measured through the whole Fastify
// pipeline (security hooks, validation, serialization, ETag, compression).
// The spec says p95 < 20ms; p99 is the stricter metric the runner offers.
const TREE = 'Bench';
const headers = { host: '127.0.0.1:4317', 'accept-encoding': 'br, gzip' };
const TOKEN = 'bench-token';
const writeHeaders = { ...headers, origin: 'http://127.0.0.1:4317', 'x-oa-token': TOKEN };
let root: string | undefined;
let app: FastifyInstance;
let ids: string[];
let i = 0;
const nextId = () => ids[i++ % ids.length] as string;

async function loaded() {
  if (root) return;
  root = mkdtempSync(join(tmpdir(), 'oa-bench-'));
  const library = new Library(root);
  const data = generateSyntheticTree({ people: 10_000, seed: 1 });
  bulkInsert(library.create(TREE), data);
  ids = data.family_child.map((c) => c.child_id);
  app = createServer({ library, token: TOKEN });
  await app.ready();
}

async function get(url: string) {
  const res = await app.inject({ method: 'GET', url, headers });
  if (res.statusCode !== 200) throw new Error(`${url}: ${res.statusCode} ${res.body}`);
}

export default [
  {
    name: 'server: cold start to first person detail (10k tree)',
    setup: loaded,
    fn: async () => {
      const cold = createServer({ library: root });
      await cold.ready();
      await cold.inject({ method: 'GET', url: `/api/trees/${TREE}/people/${nextId()}`, headers });
      await cold.close();
    },
    budgetMs: 300,
    metric: 'mean',
    iterations: 5,
    time: 0,
  },
  {
    name: 'server: GET person detail (10k tree)',
    setup: loaded,
    fn: () => get(`/api/trees/${TREE}/people/${nextId()}`),
    budgetMs: 20,
  },
  {
    name: 'server: GET neighborhood up 4 down 3 (10k tree)',
    setup: loaded,
    fn: () => get(`/api/trees/${TREE}/neighborhood?focus=${nextId()}&up=4&down=3`),
    budgetMs: 20,
  },
  {
    // What the family view asks for: aunts, uncles, half siblings and their partners.
    name: 'server: GET neighborhood up 4 down 3 siblingsDepth 2 (10k tree)',
    setup: loaded,
    fn: () => get(`/api/trees/${TREE}/neighborhood?focus=${nextId()}&up=4&down=3&siblingsDepth=2`),
    budgetMs: 20,
  },
  {
    name: 'server: GET search (10k tree)',
    setup: loaded,
    fn: () => get(`/api/trees/${TREE}/search?q=${['ash', 'bel', 'cor', 'dun', 'ell'][i++ % 5]}`),
    budgetMs: 50,
  },
  {
    // Given name, sounds-alike surname and a year: all three tiers run.
    name: 'server: GET search, three tiers (10k tree)',
    setup: loaded,
    fn: () =>
      get(
        `/api/trees/${TREE}/search?q=${encodeURIComponent(['alder ashgrof 1850', 'hazel corren 1900', 'ellis dunmoor'][i++ % 3]!)}`,
      ),
    budgetMs: 50,
  },
  {
    name: 'server: GET people list page of 100 (10k tree)',
    setup: loaded,
    fn: () => get(`/api/trees/${TREE}/people?sort=birth&limit=100&offset=${(i++ % 50) * 100}`),
    budgetMs: 50,
  },
  {
    // The checker rescans after any edit; a privacy change is about the cheapest one.
    name: 'server: GET checks after an edit, full scan (10k tree)',
    setup: loaded,
    fn: async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/trees/${TREE}/people/${nextId()}`,
        headers: writeHeaders,
        payload: { privacy: i % 2 ? 'private' : 'public' },
      });
      if (res.statusCode !== 200) throw new Error(`PATCH: ${res.statusCode} ${res.body}`);
      await get(`/api/trees/${TREE}/checks`);
    },
    budgetMs: 300,
    metric: 'mean',
    iterations: 10,
    time: 0,
    warmupIterations: 2,
  },
  {
    // Unchanged tree: the last scan is reused (the request still builds summaries).
    name: 'server: GET checks, unchanged tree (10k tree)',
    setup: loaded,
    fn: () => get(`/api/trees/${TREE}/checks`),
    budgetMs: 50,
  },
] satisfies BenchCase[];
