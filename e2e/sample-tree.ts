import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { openTree } from '@open-ancestry/db';
import { importGedcom } from '../packages/import/src/index';
import { expect, test } from './fixtures';

/*
 * fixtures/ancestry-sample.ged imported into the e2e library once per worker
 * under its own name, with people's ids by "Given Surname". Tests in a worker
 * share it, so each one sets the home person it needs first.
 */

const sample = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'ancestry-sample.ged'));

export interface SampleTree {
  name: string;
  id: (person: string) => string;
}

let loaded: Promise<SampleTree> | undefined;

export function sampleTree(): Promise<SampleTree> {
  loaded ??= (async () => {
    const info = test.info();
    const name = `Relationship sample ${info.project.name} ${info.workerIndex} ${Date.now() % 1e6}`;
    const dir = join(process.env.OA_E2E_LIBRARY!, `${name}.oatree`);
    await importGedcom({ bytes: sample }, { dir, name });
    const store = openTree(dir);
    const rows = store.db
      .prepare(
        `SELECT p.id, n.given || ' ' || n.surname AS name FROM person p
         JOIN person_name n ON n.person_id = p.id AND n.is_primary = 1`,
      )
      .all() as { id: string; name: string }[];
    store.close();
    const ids = new Map(rows.map((r) => [r.name, r.id]));
    return {
      name,
      id: (person) => {
        const id = ids.get(person);
        if (!id) throw new Error(`no ${person} in the sample`);
        return id;
      },
    };
  })();
  return loaded;
}

/** Sets the sample's home person through the API. */
export async function setHome(page: Page, person: string) {
  const tree = await sampleTree();
  // Mutations need the session token and a same-origin Origin header.
  const { token } = (await (await page.request.get('/api/session')).json()) as { token: string };
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const res = await page.request.put(`/api/trees/${encodeURIComponent(tree.name)}/home`, {
    headers: { origin, 'x-oa-token': token },
    data: { personId: tree.id(person) },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** Opens a person page in the sample tree. */
export async function openSamplePerson(page: Page, person: string) {
  const tree = await sampleTree();
  await page.addInitScript((t) => localStorage.setItem('oa-tree', t), tree.name);
  await page.goto(`/person/${tree.id(person)}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(person);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}
