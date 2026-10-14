import type { APIRequestContext, Page } from '@playwright/test';

/*
 * Editing tests change data, so each one gets its own small tree, built
 * through the public API (invented people only) and opened in the page.
 */

export interface SeededTree {
  tree: string;
  rowan: string;
  edmund: string;
  clara: string;
  iris: string;
  /** Unrelated person to attach through search. */
  wendell: string;
}

interface Session {
  headers: Record<string, string>;
}

async function session(request: APIRequestContext, baseURL: string): Promise<Session> {
  const { token } = (await (await request.get('/api/session')).json()) as { token: string };
  return { headers: { origin: baseURL, 'x-oa-token': token } };
}

async function send<T>(
  request: APIRequestContext,
  { headers }: Session,
  method: 'post' | 'put' | 'patch',
  path: string,
  data: unknown,
): Promise<T> {
  const res = await request[method](path, { headers, data });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

const person = (
  given: string,
  surname: string,
  sex: 'M' | 'F',
  birth?: string,
  death?: string,
) => ({
  sex,
  names: [{ given, surname }],
  events: [
    ...(birth ? [{ type: 'BIRT', date_text: birth, place: 'Brackenford, Westmere' }] : []),
    ...(death ? [{ type: 'DEAT', date_text: death, place: 'Thornbury, Northvale' }] : []),
  ],
});

export async function seedTree(
  request: APIRequestContext,
  baseURL: string,
  label: string,
): Promise<SeededTree> {
  const s = await session(request, baseURL);
  const tree = `edit ${label.replace(/[^\w ]/g, '')} ${Date.now()}`.slice(0, 100);
  await send(request, s, 'post', '/api/trees', { name: tree });
  const base = `/api/trees/${encodeURIComponent(tree)}`;

  const { person: rowan } = await send<{ person: { id: string } }>(
    request,
    s,
    'post',
    `${base}/people`,
    person('Rowan', 'Ashdown', 'M', '12 MAR 1880', '3 NOV 1950'),
  );
  const { parentId: edmund } = await send<{ parentId: string }>(
    request,
    s,
    'post',
    `${base}/people/${rowan.id}/parents`,
    { person: person('Edmund', 'Ashdown', 'M', '1850', '1901') },
  );
  const { parentId: clara } = await send<{ parentId: string }>(
    request,
    s,
    'post',
    `${base}/people/${rowan.id}/parents`,
    { person: person('Clara', 'Penhallow', 'F', '1853', '1930') },
  );
  const { spouseId: iris } = await send<{ spouseId: string }>(
    request,
    s,
    'post',
    `${base}/people/${rowan.id}/spouses`,
    { person: person('Iris', 'Vale', 'F', '1885', '1940') },
  );
  const { person: wendell } = await send<{ person: { id: string } }>(
    request,
    s,
    'post',
    `${base}/people`,
    person('Wendell', 'Quarrier', 'M', '1884', '1960'),
  );
  await send(request, s, 'put', `${base}/home`, { personId: rowan.id });
  return { tree, rowan: rowan.id, edmund, clara, iris, wendell: wendell.id };
}

/** Opens a seeded person in the page, with the seeded tree as the current tree. */
export async function openSeeded(page: Page, seeded: SeededTree, id = seeded.rowan) {
  // Runs after the default fixture's init script, so this tree wins.
  await page.addInitScript((tree) => localStorage.setItem('oa-tree', tree), seeded.tree);
  await page.goto(`/person/${id}`);
  await page.locator('html[data-shell-ready]').waitFor({ state: 'attached' });
  await page.locator('[aria-busy="true"]').waitFor({ state: 'detached' });
}
