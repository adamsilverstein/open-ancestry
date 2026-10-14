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
  importJsonString,
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
    mediaLinks.create(tx, {
      media_id: m.id,
      owner_type: 'person',
      owner_id: f.me,
      crop_json: '{"x":0.1}',
    });
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
    expect(searchPeople(copy, 'ellis vale').length).toBe(1);
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
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
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
    const committed: unknown = JSON.parse(readFileSync(schemaPath, 'utf8'));
    expect(committed).toEqual(buildJsonSchema(store));
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

  describe('untrusted documents', () => {
    function baseDoc() {
      const store = memoryTree();
      seedSmallFamily(store);
      const doc = exportJson(store);
      store.close();
      return doc;
    }

    /** Imports into a fresh tree, expects a throw, and checks nothing was written. */
    function rejects(doc: unknown, message: RegExp, options?: { maxRows?: number }) {
      const target = memoryTree();
      expect(() => importJson(target, doc, options)).toThrow(message);
      expect(target.db.inTransaction).toBe(false);
      for (const table of ['person', 'person_name', 'family', 'change_log', 'change_batch']) {
        expect(target.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
      expect(target.db.prepare('SELECT key FROM meta').all()).toEqual([{ key: 'schema_version' }]);
      target.close();
    }

    it('rejects SQL in table names without touching the database', () => {
      const doc = baseDoc();
      rejects(
        { ...doc, tables: { ...doc.tables, 'person; DROP TABLE person; --': [] } },
        /Unknown table/,
      );
      rejects({ ...doc, tables: { ...doc.tables, sqlite_schema: [] } }, /Unknown table/);
    });

    it('rejects SQL in column names', () => {
      const doc = baseDoc();
      const person = doc.tables.person[0] as unknown as Record<string, unknown>;
      person["sex) VALUES ('M'); DROP TABLE person; --"] = 'M';
      rejects(doc, /JSON Schema/);
    });

    it('rejects type confusion and bad enums before writing', () => {
      const cases: ((d: ReturnType<typeof baseDoc>) => void)[] = [
        (d) => ((d.tables.person[0] as unknown as Record<string, unknown>).sex = 1),
        (d) => ((d.tables.person[0] as unknown as Record<string, unknown>).living = 'zombie'),
        (d) => ((d.tables.person[0] as unknown as Record<string, unknown>).id = { $gt: '' }),
        (d) => ((d.tables.family_child[0] as unknown as Record<string, unknown>).sort_order = '1'),
        (d) => ((d.tables.person_name[0] as unknown as Record<string, unknown>).is_primary = true),
        (d) => delete (d.tables.event[0] as unknown as Record<string, unknown>).type,
      ];
      for (const mutate of cases) {
        const doc = baseDoc();
        mutate(doc);
        rejects(doc, /JSON Schema/);
      }
    });

    it('rejects malformed envelopes', () => {
      const doc = baseDoc();
      rejects(null, /object/);
      rejects([doc], /object/);
      rejects({ ...doc, tables: [] }, /tables must be an object/);
      rejects({ ...doc, tables: { ...doc.tables, person: {} } }, /must be an array/);
    });

    it('rolls back documents that break foreign keys or CHECKs', () => {
      const doc = baseDoc();
      (doc.tables.person_name[0] as { person_id: string }).person_id = 'NOBODY';
      rejects(doc, /FOREIGN KEY/);
      const media = baseDoc();
      media.tables.media.push({
        ...(Object.fromEntries(
          Object.keys(buildJsonSchemaColumns('media')).map((c) => [c, null]),
        ) as object),
        id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ',
        kind: 'photo',
        local_path: '../../etc/passwd',
        created_at: 'x',
        updated_at: 'x',
      } as never);
      rejects(media, /CHECK/);
    });

    it('rejects change_log rows that undo could abuse', () => {
      const tamper = (patch: Record<string, unknown>) => {
        const doc = baseDoc();
        Object.assign(doc.tables.change_log?.[0] ?? {}, patch);
        return doc;
      };
      rejects(tamper({ entity: 'sqlite_schema' }), /Cannot replay/);
      rejects(tamper({ entity: 'person; DROP TABLE person' }), /Cannot replay/);
      const doc = baseDoc();
      const entry = doc.tables.change_log?.[0] as { after_json: string };
      const image = JSON.parse(entry.after_json) as Record<string, unknown>;
      rejects(tamper({ after_json: JSON.stringify({ ...image, 'x = 1; --': 1 }) }), /columns/);
      rejects(tamper({ after_json: JSON.stringify({ ...image, id: 'OTHER' }) }), /key/);
      rejects(tamper({ after_json: '[1]' }), /object/);
    });

    it('caps rows and bytes', () => {
      const doc = baseDoc();
      rejects(doc, /limit/, { maxRows: 10 });
      const target = memoryTree();
      const text = JSON.stringify(doc);
      expect(() => importJsonString(target, text, { maxBytes: 100 })).toThrow(/limit/);
      importJsonString(target, text);
      expect(persons.list(target)).toHaveLength(9);
      target.close();
    });
  });
});

function buildJsonSchemaColumns(table: string): Record<string, unknown> {
  const store = memoryTree();
  const schema = buildJsonSchema(store) as {
    $defs: Record<string, { properties: Record<string, unknown> }>;
  };
  store.close();
  return schema.$defs[table]?.properties ?? {};
}
