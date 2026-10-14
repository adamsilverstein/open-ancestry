import { Ajv2020 } from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildJsonSchema,
  bulkInsert,
  citationLinks,
  citations,
  exportJson,
  exportJsonString,
  generateSyntheticTree,
  importJson,
  media,
  mediaLinks,
  meta,
  notes,
  noteLinks,
  persons,
  searchPeople,
  sources,
  tags,
  tagLinks,
  undoLast,
} from './index';
import { memoryTree, seedSmallFamily } from './test/helpers';

const schemaPath = join(import.meta.dirname, '..', 'schema', 'oa-json.schema.json');

function richTree() {
  const store = memoryTree();
  bulkInsert(store, generateSyntheticTree({ people: 120, seed: 4 }));
  const f = seedSmallFamily(store);
  store.transact('extras', (tx) => {
    const s = sources.create(tx, { title: 'Register', apid: '1,1::0' });
    const c = citations.create(tx, { source_id: s.id, page: 'p. 1', quality: 3 });
    citationLinks.create(tx, { citation_id: c.id, owner_type: 'person', owner_id: f.me });
    const m = media.create(tx, { local_path: 'photos/me.jpg', width: 640, height: 480 });
    mediaLinks.create(tx, { media_id: m.id, owner_type: 'person', owner_id: f.me, crop_json: '{"x":0.1}' });
    const n = notes.create(tx, { text: 'Line one\nLine "two" ✓' });
    noteLinks.create(tx, { note_id: n.id, owner_type: 'person', owner_id: f.me });
    const t = tags.create(tx, { name: 'Hint', category: 'Research', color: '#123456' });
    tagLinks.create(tx, { tag_id: t.id, owner_type: 'person', owner_id: f.me });
    meta.setHomePerson(tx, f.me);
    meta.set(tx, 'settings', JSON.stringify({ theme: 'dark' }));
  });
  return { store, f };
}

describe('JSON interchange', () => {
  it('round-trips byte-identically through a new database', () => {
    const { store } = richTree();
    const first = exportJsonString(store);
    const copy = memoryTree();
    importJson(copy, JSON.parse(first));
    expect(exportJsonString(copy)).toBe(first);
    // The imported copy is fully functional: search index rebuilt, history undoable.
    expect(searchPeople(copy, 'ellis').length).toBe(1);
    expect(undoLast(copy)?.label).toBe('extras');
    store.close();
    copy.close();
  });

  it('is canonical: tables in fixed order, rows sorted by key', () => {
    const { store } = richTree();
    const doc = exportJson(store);
    expect(doc.format).toBe('open-ancestry');
    expect(Object.keys(doc.tables)).toEqual([...Object.keys(doc.tables)].sort());
    const ids = doc.tables.person.map((p) => p.id);
    expect(ids).toEqual([...ids].sort());
    expect(exportJsonString(store).endsWith('}\n')).toBe(true);
    expect(doc.tables).not.toHaveProperty('search_doc');
    store.close();
  });

  it('can leave out change history', () => {
    const { store } = richTree();
    const doc = exportJson(store, { history: false });
    expect(doc.tables).not.toHaveProperty('change_log');
    expect(doc.tables).not.toHaveProperty('change_batch');
    store.close();
  });

  it('validates against the published JSON Schema', () => {
    const { store } = richTree();
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);
    const doc = exportJson(store);
    expect(validate(doc), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
    // And the schema actually constrains: a bad enum value or missing column fails.
    const bad = structuredClone(doc);
    (bad.tables.person[0] as { sex: string }).sex = 'Q';
    expect(validate(bad)).toBe(false);
    const missing = structuredClone(doc);
    delete (missing.tables.person[0] as Partial<{ living: string }>).living;
    expect(validate(missing)).toBe(false);
    store.close();
  });

  it('keeps the committed JSON Schema in sync with the database', () => {
    const store = memoryTree();
    const committed = readFileSync(schemaPath, 'utf8');
    expect(committed).toBe(`${JSON.stringify(buildJsonSchema(store), null, 2)}\n`);
    store.close();
  });

  it('rejects documents it cannot import', () => {
    const { store } = richTree();
    const doc = exportJson(store);
    expect(() => importJson(store, doc)).toThrow(/empty/);
    const fresh = memoryTree();
    expect(() => importJson(fresh, { ...doc, format: 'other' } as never)).toThrow(/format/);
    expect(() => importJson(fresh, { ...doc, schemaVersion: 999 })).toThrow(/schema version/);
    expect(() =>
      importJson(fresh, { ...doc, tables: { ...doc.tables, bogus: [] } } as never),
    ).toThrow(/bogus/);
    expect(persons.list(fresh)).toEqual([]);
    store.close();
    fresh.close();
  });
});
