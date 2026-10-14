import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Route } from '@playwright/test';
import {
  LATEST_SCHEMA_VERSION,
  getNeighborhood,
  getPersonDetail,
  meta,
  openTree,
  type TreeStore,
} from '@open-ancestry/db';
import { FIXTURE_TREE, MANIFEST, type FixtureManifest } from './tree-fixture';

/*
 * Stand-in for the read API of PR #29 (docs/api.md), answered from the real
 * fixture tree with the same packages/db queries the server uses. Remove once
 * the server API lands and the e2e web server is pointed at the fixture library.
 */

let store: TreeStore | undefined;

function library(): string {
  const dir = process.env.OA_E2E_LIBRARY;
  if (!dir) throw new Error('OA_E2E_LIBRARY is not set');
  return dir;
}

function tree(): TreeStore {
  store ??= openTree(join(library(), `${FIXTURE_TREE}.oatree`));
  return store;
}

export function readManifest(): FixtureManifest {
  return JSON.parse(readFileSync(join(library(), MANIFEST), 'utf8')) as FixtureManifest;
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const notFound = (route: Route, message: string) =>
  json(route, 404, { error: { code: 'not_found', message } });

async function handle(route: Route) {
  const url = new URL(route.request().url());
  const parts = url.pathname.split('/').filter(Boolean); // api, trees, ...
  const store = tree();
  if (parts.length === 2) {
    return json(route, 200, {
      trees: [{ id: FIXTURE_TREE, name: 'Ashdown family', modifiedAt: '2026-01-01T00:00:00Z' }],
    });
  }
  if (parts[2] !== FIXTURE_TREE) return notFound(route, `Tree ${parts[2]} not found`);
  if (parts.length === 3) {
    const { n } = store.stmt('SELECT count(*) AS n FROM person').get() as { n: number };
    return json(route, 200, {
      tree: {
        id: FIXTURE_TREE,
        name: 'Ashdown family',
        modifiedAt: '2026-01-01T00:00:00Z',
        peopleCount: n,
        homePersonId: meta.getHomePersonId(store),
        schemaVersion: LATEST_SCHEMA_VERSION,
      },
    });
  }
  if (parts[3] === 'people' && parts.length === 5) {
    const detail = getPersonDetail(store, parts[4]!);
    return detail ? json(route, 200, detail) : notFound(route, 'Person not found');
  }
  if (parts[3] === 'neighborhood') {
    const q = url.searchParams;
    const focus = q.get('focus') ?? meta.getHomePersonId(store)!;
    if (!store.getRow('person', focus)) return notFound(route, 'Person not found');
    return json(
      route,
      200,
      getNeighborhood(store, focus, {
        up: Number(q.get('up') ?? 4),
        down: Number(q.get('down') ?? 3),
        siblings: q.get('siblings') !== 'false',
      }),
    );
  }
  if (parts[3] === 'media') return notFound(route, 'No media');
  return json(route, 501, { error: { code: 'not_implemented', message: url.pathname } });
}

export async function mockApi(page: Page): Promise<void> {
  await page.route(/\/api\/trees(\/|\?|$)/, handle);
}
