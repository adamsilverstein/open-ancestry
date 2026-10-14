import { openMemoryTree, openTree } from '@open-ancestry/db';
import { join } from 'node:path';
import { parseGedcom, readGedzip } from '@open-ancestry/gedcom';
import { importGedcom } from '@open-ancestry/import';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestTree, seed, testApi, type Seeded, type TestApi } from './test/helpers';

let api: TestApi;
let s: Seeded;
beforeEach(async () => {
  api = await testApi();
  s = await seed(api);
});
afterEach(() => api.close());

/** A tree imported from GEDCOM whose regenerated person has a pointer to a missing family. */
async function importedTree(): Promise<string> {
  const base = await createTestTree(api, 'Imported');
  const store = openTree(join(api.root, 'Imported.oatree'));
  await importGedcom(
    {
      bytes: [
        '0 HEAD',
        '1 GEDC',
        '2 VERS 5.5.1',
        '0 @I1@ INDI',
        '1 NAME Odile /Fernsby/',
        '1 FAMS @F99@',
        '0 TRLR',
        '',
      ].join('\n'),
    },
    store,
  );
  store.close();
  return base;
}

const givenNames = async (gedcom: Uint8Array | string) => {
  const store = openMemoryTree();
  await importGedcom(typeof gedcom === 'string' ? { bytes: gedcom } : { gedzip: gedcom }, store);
  return store.db.prepare('SELECT given FROM person_name ORDER BY given').pluck().all() as string[];
};

describe('GEDCOM export routes', () => {
  it('downloads GEDCOM 5.5.1 by default, which re-imports', async () => {
    const res = await api.get(`${s.base}/export.ged`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/vnd.familysearch.gedcom; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Test.ged"; filename*=UTF-8''Test.ged`,
    );
    expect(parseGedcom(res.body).header.version).toBe('5.5.1');
    expect(await givenNames(res.body)).toEqual(['Ada', 'Bram', 'Cora', 'Dan', 'Eve']);
  });

  it('downloads GEDCOM 7 and privatizes living people on request', async () => {
    await api.patch(`${s.base}/people/${s.bram}`, { living: 'dead' });
    const res = await api.get(`${s.base}/export.ged?version=7&privatize=true`);
    expect(res.statusCode).toBe(200);
    expect(parseGedcom(res.body).header.version).toBe('7.0');
    expect(res.body).toContain('Bram');
    for (const living of ['Ada', 'Cora', 'Dan', 'Eve', '1941', 'Harlow']) {
      expect(res.body).not.toContain(living);
    }
  });

  it('downloads GEDZIP', async () => {
    const res = await api.get(`${s.base}/export.gdz`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.familysearch.gedcom+zip');
    expect(res.headers['content-disposition']).toContain(`filename="Test.gdz"`);
    const bytes = res.rawPayload;
    expect(readGedzip(bytes).gedcom).toBeDefined();
    expect(await givenNames(bytes)).toEqual(['Ada', 'Bram', 'Cora', 'Dan', 'Eve']);
  });

  it('gives an ASCII fallback file name for any tree name', async () => {
    const base = await createTestTree(api, "Vale & Reed's ü;tree");
    const res = await api.get(`${base}/export.ged`);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Vale _ Reed_s __tree.ged"; filename*=UTF-8''Vale%20%26%20Reed%27s%20%C3%BC%3Btree.ged`,
    );
  });

  it('writes event types the edit API accepts in lower case as GEDCOM tags', async () => {
    await api.post(`${s.base}/people/${s.ada}/events`, { type: 'grad', date_text: '1963' });
    const res = await api.get(`${s.base}/export.ged?version=7`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('1 GRAD\n2 DATE 1963');
  });

  it('reports export warnings in headers the dialog reads', async () => {
    const clean = await api.get(`${s.base}/export.ged`);
    expect(clean.headers['x-oa-export-warning-count']).toBe('0');
    expect(JSON.parse(decodeURIComponent(clean.headers['x-oa-export-warnings'] as string))).toEqual(
      [],
    );
    const tree = await importedTree();
    for (const path of ['export.ged?version=7', 'export.gdz']) {
      const res = await api.get(`${tree}/${path}`);
      expect(res.headers['x-oa-export-warning-count'], path).toBe('1');
      const warnings = JSON.parse(
        decodeURIComponent(res.headers['x-oa-export-warnings'] as string),
      );
      expect(warnings).toEqual([expect.stringContaining('@F99@ is not in the export')]);
    }
  });

  it('rejects unknown versions and options', async () => {
    for (const query of ['version=6', 'privatize=maybe', 'format=json']) {
      const res = await api.get(`${s.base}/export.ged?${query}`);
      expect(res.statusCode, query).toBe(400);
    }
    expect((await api.get('/api/trees/nope/export.ged')).statusCode).toBe(404);
  });
});
