import { importJsonString, openMemoryTree, openTree } from '@open-ancestry/db';
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
    // Cora (born 1912) is inferred deceased since edits re-run living inference.
    expect(res.body).toContain('Cora');
    for (const living of ['Ada', 'Dan', 'Eve', '1941', 'Harlow']) {
      expect(res.body).not.toContain(living);
    }
  });

  it('names a privatized download neutrally, not after the tree', async () => {
    for (const path of ['export.ged?privatize=true', 'export.gdz?privatize=true']) {
      const res = await api.get(`${s.base}/${path}`);
      const extension = path.includes('.gdz') ? 'gdz' : 'ged';
      expect(res.headers['content-disposition'], path).toBe(
        `attachment; filename="private-tree.${extension}"; filename*=UTF-8''private-tree.${extension}`,
      );
    }
  });

  it('reports how many people a privatized export would hide', async () => {
    const tree = async () => (await api.get(s.base)).json().tree;
    const before = await tree();
    expect(before.livingCount).toBeGreaterThan(0);
    expect(before.privateCount).toBe(0);
    await api.patch(`${s.base}/people/${s.ada}`, { living: 'dead' });
    expect((await tree()).livingCount).toBe(before.livingCount - 1);
    // Marked confidential: hidden like the living, counted separately.
    await api.patch(`${s.base}/people/${s.ada}`, { privacy: 'confidential' });
    expect(await tree()).toMatchObject({ livingCount: before.livingCount - 1, privateCount: 1 });
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

describe('JSON export history (#197)', () => {
  async function deletedNote() {
    const res = await api.post(`${s.base}/notes`, {
      text: 'SECRET-DELETED-NOTE',
      owner_type: 'person',
      owner_id: s.ada,
    });
    const { note } = res.json() as { note: { id: string } };
    await api.del(`${s.base}/notes/${note.id}`);
  }

  it('leaves out the edit history, and so deleted text, with history=0 or false', async () => {
    await deletedNote();
    for (const flag of ['0', 'false']) {
      const res = await api.get(`${s.base}/export.json?history=${flag}`);
      expect(res.statusCode, flag).toBe(200);
      const { tables } = res.json() as { tables: Record<string, unknown> };
      expect(Object.keys(tables), flag).not.toContain('change_batch');
      expect(Object.keys(tables), flag).not.toContain('change_log');
      expect(res.body, flag).not.toContain('SECRET-DELETED-NOTE');
    }
  });

  it('with history=0 also leaves out the imported text and warnings of changed records', async () => {
    const base = await createTestTree(api, 'Secrets');
    const store = openTree(join(api.root, 'Secrets.oatree'));
    await importGedcom(
      {
        bytes: [
          '0 HEAD',
          '1 GEDC',
          '2 VERS 5.5.1',
          '0 @I1@ INDI',
          '1 NAME Odile /Fernsby/',
          '1 NOTE SECRET-INLINE-NOTE',
          '1 NOTE @N1@',
          '1 _CUSTOM SECRET-UNMAPPED',
          '0 @I2@ INDI',
          '1 NAME Bastien /Corlew/',
          '1 NOTE Kept note',
          '0 @N1@ NOTE SECRET-RECORD-NOTE',
          'SECRET-BROKEN-LINE',
          '0 TRLR',
          '',
        ].join('\n'),
      },
      store,
    );
    const odile = store.db
      .prepare("SELECT person_id FROM person_name WHERE given = 'Odile'")
      .pluck()
      .get() as string;
    store.close();
    const detail = (await api.get(`${base}/people/${odile}`)).json() as {
      notes: { id: string }[];
    };
    expect(detail.notes).toHaveLength(2);
    for (const note of detail.notes) await api.del(`${base}/notes/${note.id}`);

    const res = await api.get(`${base}/export.json?history=0`);
    expect(res.statusCode).toBe(200);
    expect(res.body.split('\n').filter((l) => l.includes('SECRET'))).toEqual([]);
    const { tables } = res.json() as {
      tables: { import_batch: { warnings_json: string }[]; raw_record: { raw_text: string }[] };
    };
    expect(tables.import_batch.every((b) => b.warnings_json === '[]')).toBe(true);
    // Untouched records keep their imported text, so a re-export can still copy them.
    expect(tables.raw_record.some((r) => r.raw_text.includes('Bastien'))).toBe(true);
    // The full backup keeps everything.
    expect((await api.get(`${base}/export.json`)).body).toMatch(/SECRET-INLINE-NOTE/);
  });

  it('with history=0 leaves out places, notes and media only deleted records used (#267)', async () => {
    const base = await createTestTree(api, 'Places');
    const store = openTree(join(api.root, 'Places.oatree'));
    await importGedcom(
      {
        bytes: [
          '0 HEAD',
          '1 GEDC',
          '2 VERS 5.5.1',
          '0 @I1@ INDI',
          '1 NAME Odile /Fernsby/',
          '1 BIRT',
          '2 PLAC SECRET-HAMLET, SECRET-PARISH, Kerry',
          '3 NOTE SECRET-PLACE-NOTE',
          '1 NOTE SECRET-PERSON-NOTE',
          '1 OBJE',
          '2 FILE secret/SECRET-PORTRAIT.jpg',
          '2 TITL SECRET-PHOTO-TITLE',
          '0 @I2@ INDI',
          '1 NAME Bastien /Corlew/',
          '1 BIRT',
          '2 PLAC Tralee, Kerry',
          '0 TRLR',
          '',
        ].join('\n'),
      },
      store,
    );
    const odile = store.db
      .prepare("SELECT person_id FROM person_name WHERE given = 'Odile'")
      .pluck()
      .get() as string;
    store.close();
    expect((await api.del(`${base}/people/${odile}`)).statusCode).toBe(200);

    const res = await api.get(`${base}/export.json?history=0`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('SECRET');
    const { tables } = res.json() as { tables: { place: { name: string }[] } };
    // Kerry stays: Tralee, which a remaining event uses, sits under it.
    expect(tables.place.map((p) => p.name).sort()).toEqual(['Kerry', 'Tralee']);
    // Still a whole document: it loads into an empty tree.
    expect(() => importJsonString(openMemoryTree(), res.body)).not.toThrow();
    // The full backup keeps every place, as the history may restore them.
    expect((await api.get(`${base}/export.json`)).body).toContain('SECRET-HAMLET');
  });

  it('keeps the history by default, as a full backup', async () => {
    await deletedNote();
    const res = await api.get(`${s.base}/export.json`);
    const { tables } = res.json() as { tables: Record<string, unknown[]> };
    expect(tables.change_log!.length).toBeGreaterThan(0);
    expect(res.body).toContain('SECRET-DELETED-NOTE');
    expect((await api.get(`${s.base}/export.json?history=nope`)).statusCode).toBe(400);
  });
});

describe('deleting a person whose only pointers were imported text (#245)', () => {
  it('leaves none of their NOTE, OBJE or SOUR records in any export', async () => {
    const base = await createTestTree(api, 'Pointers');
    const store = openTree(join(api.root, 'Pointers.oatree'));
    await importGedcom(
      {
        bytes: [
          '0 HEAD',
          '1 GEDC',
          '2 VERS 5.5.1',
          '0 @I1@ INDI',
          '1 NAME Ozias /Canarydeleted/',
          '1 ASSO @I2@',
          '2 NOTE @N5@',
          '1 _CUSTOM',
          '2 OBJE @O7@',
          '2 SOUR @S9@',
          '0 @I2@ INDI',
          '1 NAME Petra /Keeper/',
          '0 @N5@ NOTE Canarynote',
          '0 @O7@ OBJE',
          '1 FILE photos/canaryphoto.jpg',
          '2 FORM jpg',
          '0 @S9@ SOUR',
          '1 TITL Canarysource',
          '0 TRLR',
          '',
        ].join('\n'),
      },
      store,
    );
    const ozias = store.db
      .prepare("SELECT person_id FROM person_name WHERE given = 'Ozias'")
      .pluck()
      .get() as string;
    store.close();
    expect((await api.del(`${base}/people/${ozias}`)).statusCode).toBe(200);
    for (const url of [
      `${base}/export.ged`,
      `${base}/export.ged?version=7`,
      `${base}/export.json?history=0`,
    ]) {
      const res = await api.get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body.match(/canary\w*/gi) ?? [], url).toEqual([]);
    }
  });
});
