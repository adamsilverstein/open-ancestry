import { request as httpRequest } from 'node:http';
import { networkInterfaces } from 'node:os';
import { expect, test, type APIRequestContext } from '@playwright/test';

/*
 * API behavior against the real server started by the CLI: the security rules
 * that protect a loopback app from other websites, and a happy path.
 */

const uniqueTree = (testInfo: { project: { name: string }; title: string }) =>
  `e2e ${testInfo.project.name} ${testInfo.title.replace(/[^\w ]/g, '')} ${Date.now()}`.slice(
    0,
    100,
  );

async function session(request: APIRequestContext, baseURL: string) {
  const { token } = (await (await request.get('/api/session')).json()) as { token: string };
  return { origin: baseURL, 'x-oa-token': token };
}

/** A raw HTTP request, so the test controls the Host header. */
function rawGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers, setHost: false }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('happy path: create a tree, add a family, browse, search, undo', async ({
  request,
  baseURL,
}, testInfo) => {
  const headers = await session(request, baseURL!);
  const name = uniqueTree(testInfo);
  const base = `/api/trees/${encodeURIComponent(name)}`;

  expect((await request.post('/api/trees', { headers, data: { name } })).status()).toBe(201);
  const ada = (await (
    await request.post(`${base}/people`, {
      headers,
      data: {
        sex: 'F',
        names: [{ given: 'Ada', surname: 'Vale' }],
        events: [{ type: 'BIRT', date_text: '5 SEP 1941' }],
      },
    })
  ).json()) as { person: { id: string } };
  const parent = await request.post(`${base}/people/${ada.person.id}/parents`, {
    headers,
    data: { person: { sex: 'M', names: [{ given: 'Bram', surname: 'Vale' }] } },
  });
  expect(parent.status()).toBe(201);

  const neighborhood = await (
    await request.get(`${base}/neighborhood?focus=${ada.person.id}&up=2&down=1`)
  ).json();
  expect(neighborhood.people.map((p: { given: string }) => p.given).sort()).toEqual([
    'Ada',
    'Bram',
  ]);

  const detail = await (await request.get(`${base}/people/${ada.person.id}`)).json();
  expect(detail.events[0].event.date_sort).toBe(19410905);

  const search = await (await request.get(`${base}/search?q=vail`)).json();
  expect(search.items).toHaveLength(2);

  const undo = await (await request.post(`${base}/undo`, { headers })).json();
  expect(undo.batch.label).toBe('Add parent');
  expect((await (await request.get(`${base}/people?limit=10`)).json()).total).toBe(1);

  expect((await request.delete(base, { headers })).status()).toBe(204);
});

test('mutations need a same-origin Origin header and the session token', async ({
  request,
  baseURL,
}, testInfo) => {
  const { 'x-oa-token': token } = await session(request, baseURL!);
  const data = { name: uniqueTree(testInfo) };
  const attempts: Record<string, string>[] = [
    {},
    { origin: baseURL! },
    { origin: 'http://evil.example', 'x-oa-token': token },
    { origin: baseURL!, 'x-oa-token': 'guess' },
  ];
  for (const headers of attempts) {
    const res = await request.post('/api/trees', { headers, data });
    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
  }
  const trees = (await (await request.get('/api/trees')).json()).trees as { id: string }[];
  expect(trees.map((t) => t.id)).not.toContain(data.name);
});

test('rejects foreign Host headers (DNS rebinding)', async ({ baseURL }) => {
  const url = `${baseURL}/api/session`;
  const port = new URL(baseURL!).port;
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1.nip.io:${port}`]) {
    const res = await rawGet(url, { host });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('token');
  }
  expect((await rawGet(url, { host: `localhost:${port}` })).status).toBe(200);
  expect((await rawGet(`${baseURL}/`, { host: 'evil.example' })).status).toBe(403);
});

test('sends strict security headers and no CORS headers', async ({ request }) => {
  for (const path of ['/', '/api/health', '/api/nope']) {
    const res = await request.get(path, { headers: { origin: 'http://evil.example' } });
    const headers = res.headers();
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['access-control-allow-origin']).toBeUndefined();
  }
});

test('listens on loopback only by default', async ({ baseURL }) => {
  const external = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal);
  test.skip(!external, 'no non-loopback interface on this machine');
  const port = new URL(baseURL!).port;
  await expect(
    rawGet(`http://${external!.address}:${port}/api/health`, { host: `localhost:${port}` }),
  ).rejects.toThrow(/ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT/);
});

test('the app can mutate same-origin, other origins cannot read the token', async ({
  page,
  baseURL,
}, testInfo) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(violations).toEqual([]);

  const name = uniqueTree(testInfo);
  // Same-origin fetch from the page, exactly as the SPA will do it.
  const status = await page.evaluate(async (treeName) => {
    const { token } = (await (await fetch('/api/session')).json()) as { token: string };
    const res = await fetch('/api/trees', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-oa-token': token },
      body: JSON.stringify({ name: treeName }),
    });
    return res.status;
  }, name);
  expect(status).toBe(201);

  // localhost and 127.0.0.1 are different origins: the second cannot read the first.
  const port = new URL(baseURL!).port;
  await page.goto(`http://localhost:${port}/`);
  const crossOrigin = await page.evaluate(async (target) => {
    try {
      const res = await fetch(`${target}/api/session`);
      return `read ${res.status}`;
    } catch {
      return 'blocked';
    }
  }, baseURL!);
  expect(crossOrigin).toBe('blocked');
});

/** Sends `method path` exactly as written, so dot segments and escapes reach the server raw. */
function rawRequest(baseURL: string, method: string, path: string): Promise<number> {
  const { hostname, port } = new URL(baseURL);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname, port, method, path, headers: { host: `${hostname}:${port}` } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

test('encoded or dotted paths cannot sneak a mutation past the guard', async ({
  request,
  baseURL,
}, testInfo) => {
  const headers = await session(request, baseURL!);
  const name = uniqueTree(testInfo);
  const base = `/api/trees/${encodeURIComponent(name)}`;
  await request.post('/api/trees', { headers, data: { name } });
  await request.post(`${base}/people`, { headers, data: { names: [{ given: 'Ada' }] } });

  for (const path of [
    `/%61pi${base.slice(4)}/undo`,
    `/ap%69${base.slice(4)}/undo`,
    `/api/%2e%2e${base}/undo`,
    `/api/..${base}/undo`,
    `/%2561pi${base.slice(4)}/undo`,
  ]) {
    expect(await rawRequest(baseURL!, 'POST', path), path).toBe(400);
  }
  for (const path of [`${base}/undo/`, `/API${base.slice(4)}/undo`]) {
    expect(await rawRequest(baseURL!, 'POST', path), path).toBe(403);
  }
  const history = await (await request.get(`${base}/history`)).json();
  expect(history.items[0].state).toBe('applied');
});

test('a cross-site page cannot undo edits, even with an encoded path', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const headers = await session(request, baseURL!);
  const name = uniqueTree(testInfo);
  const base = `/api/trees/${encodeURIComponent(name)}`;
  await request.post('/api/trees', { headers, data: { name } });
  await request.post(`${base}/people`, { headers, data: { names: [{ given: 'Ada' }] } });

  const port = new URL(baseURL!).port;
  await page.goto(`http://localhost:${port}/`);
  await page.evaluate(
    async ({ target, paths }) => {
      for (const path of paths) {
        await fetch(`${target}${path}`, { method: 'POST', mode: 'no-cors', body: 'x' }).catch(
          () => {},
        );
      }
    },
    { target: baseURL!, paths: [`${base}/undo`, `/%61pi${base.slice(4)}/undo`] },
  );
  const history = await (await request.get(`${base}/history`)).json();
  expect(history.items[0].state).toBe('applied');
});
