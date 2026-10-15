import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { importFile } from '@open-ancestry/import';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MUTATION_HEADERS, testApi, type TestApi } from './test/helpers';

/*
 * #243/#246 review: two servers may share one library (#156). Neither may
 * take the other's open review's working folders, and a tree with an open
 * review can't be renamed or deleted under it.
 */

const enc = (text: string) => new TextEncoder().encode(text);
const FIRST = [
  '0 HEAD',
  '1 GEDC',
  '2 VERS 5.5.1',
  '0 @I1@ INDI',
  '1 NAME Ada /Vale/',
  '0 TRLR',
  '',
].join('\n');
const LATER = [
  '0 HEAD',
  '1 GEDC',
  '2 VERS 5.5.1',
  '0 @I51@ INDI',
  '1 NAME Ada /Vale/',
  '1 OBJE @O1@',
  '0 @O1@ OBJE',
  '1 FILE photos/ada.jpg',
  '2 TITL Ada',
  '0 TRLR',
  '',
].join('\n');

function upload(name: string, bytes: Uint8Array) {
  const boundary = '----oa-two';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { ...MUTATION_HEADERS, 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

let a: TestApi;
let b: TestApi | undefined;
beforeEach(async () => {
  a = await testApi({ importer: importFile });
});
afterEach(async () => {
  await b?.close();
  b = undefined;
  await a.close();
});

async function finished(api: TestApi, id: string) {
  await vi.waitFor(async () => {
    expect(['completed', 'failed']).toContain((await api.get(`/api/jobs/${id}`)).json().state);
  });
  return (await api.get(`/api/jobs/${id}`)).json();
}

async function openReview() {
  const imported = await a.inject({
    method: 'POST',
    url: '/api/import',
    ...upload('Vale.ged', enc(FIRST)),
  });
  const tree = (await finished(a, imported.json().jobId)).tree as string;
  const base = `/api/trees/${encodeURIComponent(tree)}`;
  const zip = zipSync({ 'gedcom.ged': enc(LATER), 'photos/ada.jpg': enc('ADA') });
  const started = await a.inject({
    method: 'POST',
    url: `${base}/reimport`,
    ...upload('Vale.zip', zip),
  });
  const job = await finished(a, started.json().jobId);
  expect(job.state).toBe('completed');
  const treeDir = join(a.root, `${tree}.oatree`);
  return { tree, base, treeDir, reimportId: (job.result as { reimportId: string }).reimportId };
}

const reimportFolders = (dir: string) => readdirSync(dir).filter((n) => n.startsWith('.reimport-'));

it("a second server opening the tree leaves the first server's open review alone", async () => {
  const { base, treeDir, reimportId } = await openReview();
  const before = reimportFolders(treeDir);
  expect(before.some((n) => n.startsWith('.reimport-media-'))).toBe(true);
  // Another server on the same library starts and opens the tree.
  b = await testApi({ library: a.root, importer: importFile });
  expect((await b.get(base)).statusCode).toBe(200);
  expect(reimportFolders(treeDir)).toEqual(before);
  // The first server's review still applies, files and all.
  const review = (await a.get(`/api/reimports/${reimportId}`)).json();
  const accept = review.diff.people.flatMap(
    (p: { changes: { id: string; applicable: boolean }[] }) =>
      p.changes.filter((c) => c.applicable).map((c) => c.id),
  );
  expect((await a.post(`/api/reimports/${reimportId}/apply`, { accept })).statusCode).toBe(200);
  expect(readFileSync(join(treeDir, 'media', 'photos', 'ada.jpg'), 'utf8')).toBe('ADA');
  // Applying released the review's folders.
  expect(reimportFolders(treeDir)).toEqual([]);
});

it('refuses to rename or delete a tree while a review of it is open', async () => {
  const { base, treeDir, reimportId } = await openReview();
  expect((await a.patch(base, { name: 'Other' })).statusCode).toBe(409);
  expect((await a.del(base)).statusCode).toBe(409);
  expect(existsSync(treeDir)).toBe(true);
  expect((await a.del(`/api/reimports/${reimportId}`)).statusCode).toBe(204);
  expect((await a.patch(base, { name: 'Other' })).statusCode).toBe(200);
});
