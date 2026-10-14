import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  UndoConflictError,
  exportJsonString,
  families,
  familyChildren,
  events,
  listBatches,
  names,
  notes,
  noteLinks,
  persons,
  places,
  rebuildSearchIndex,
  redo,
  redoLast,
  searchPeople,
  tags,
  tagLinks,
  undo,
  undoLast,
  type TreeStore,
  type Tx,
} from './index';
import { memoryTree, seedSmallFamily } from './test/helpers';

/** Every user-data table (change history excluded) as canonical JSON. */
function snapshot(store: TreeStore): string {
  return exportJsonString(store, { history: false });
}

/** Search index content, for checking undo keeps FTS in sync. */
function searchIndex(store: TreeStore): unknown[] {
  return store.db
    .prepare(
      `SELECT d.person_id, s.names, s.phonetic, s.places, s.years
       FROM search_doc d JOIN person_search s ON s.rowid = d.rowid ORDER BY d.person_id`,
    )
    .all();
}

describe('undo / redo', () => {
  it('undoes and redoes a batch', () => {
    const store = memoryTree();
    const before = snapshot(store);
    const { batchId, result: p } = store.transact('add', (tx) =>
      persons.create(tx, { names: [{ given: 'Linnea', surname: 'Crane' }] }),
    );
    const after = snapshot(store);
    undo(store, batchId);
    expect(snapshot(store)).toBe(before);
    expect(persons.get(store, p.id)).toBeUndefined();
    expect(searchPeople(store, 'Linnea')).toEqual([]);
    redo(store, batchId);
    expect(snapshot(store)).toBe(after);
    expect(searchPeople(store, 'Linnea').map((r) => r.person.id)).toEqual([p.id]);
    store.close();
  });

  it('undoLast / redoLast walk the history like an editor', () => {
    const store = memoryTree();
    const s0 = snapshot(store);
    store.transact('one', (tx) => persons.create(tx, {}));
    const s1 = snapshot(store);
    store.transact('two', (tx) => persons.create(tx, {}));
    const s2 = snapshot(store);
    expect(undoLast(store)?.label).toBe('two');
    expect(snapshot(store)).toBe(s1);
    expect(undoLast(store)?.label).toBe('one');
    expect(snapshot(store)).toBe(s0);
    expect(undoLast(store)).toBeNull();
    expect(redoLast(store)?.label).toBe('one');
    expect(redoLast(store)?.label).toBe('two');
    expect(snapshot(store)).toBe(s2);
    expect(redoLast(store)).toBeNull();
    store.close();
  });

  it('a new edit discards the redo stack', () => {
    const store = memoryTree();
    const { batchId } = store.transact('one', (tx) => persons.create(tx, {}));
    undo(store, batchId);
    store.transact('two', (tx) => persons.create(tx, {}));
    expect(redoLast(store)).toBeNull();
    expect(() => redo(store, batchId)).toThrow(/superseded/);
    expect(listBatches(store).map((b) => [b.label, b.state])).toEqual([
      ['two', 'applied'],
      ['one', 'superseded'],
    ]);
    store.close();
  });

  it('refuses to undo a batch whose rows changed later, leaving data untouched', () => {
    const store = memoryTree();
    const { batchId, result: p } = store.transact('add', (tx) => persons.create(tx, { sex: 'F' }));
    store.transact('edit', (tx) => persons.update(tx, p.id, { sex: 'M' }));
    const before = snapshot(store);
    expect(() => undo(store, batchId)).toThrow(UndoConflictError);
    expect(snapshot(store)).toBe(before);
    store.close();
  });

  it('reports rows still referenced by later edits as a conflict, not a raw FK error', () => {
    const store = memoryTree();
    const { batchId, result: p } = store.transact('add', (tx) => persons.create(tx, {}));
    store.transact('family', (tx) => families.create(tx, { partner1_id: p.id }));
    const before = snapshot(store);
    expect(() => undo(store, batchId)).toThrow(UndoConflictError);
    expect(() => undo(store, batchId)).toThrow(/later edits still depend/);
    expect(store.db.inTransaction).toBe(false);
    expect(snapshot(store)).toBe(before);
    expect(listBatches(store).find((b) => b.id === batchId)?.state).toBe('applied');
    store.close();
  });

  it('refuses invalid state transitions', () => {
    const store = memoryTree();
    const { batchId } = store.transact('add', (tx) => persons.create(tx, {}));
    expect(() => redo(store, batchId)).toThrow(/applied/);
    undo(store, batchId);
    expect(() => undo(store, batchId)).toThrow(/undone/);
    expect(() => undo(store, 'missing')).toThrow(/not found/);
    store.close();
  });

  it('only replays rows of known tables (change_log may come from an imported file)', () => {
    const store = memoryTree();
    const { batchId } = store.transact('add', (tx) => persons.create(tx, {}));
    store.db
      .prepare("UPDATE change_log SET entity = 'sqlite_schema' WHERE batch_id = ?")
      .run(batchId);
    expect(() => undo(store, batchId)).toThrow(/Cannot replay sqlite_schema/);
    store.close();
  });

  it('refuses tampered change_log rows without changing data', () => {
    const tampered = (sql: string, ...params: unknown[]) => {
      const store = memoryTree();
      store.transact('other', (tx) => persons.create(tx, { sex: 'F' }));
      const { batchId } = store.transact('add', (tx) => persons.create(tx, { sex: 'M' }));
      store.db.prepare(sql).run(...params, batchId);
      const before = snapshot(store);
      return { store, batchId, before };
    };
    const cases: [string, unknown[], RegExp][] = [
      [
        'UPDATE change_log SET entity = ? WHERE batch_id = ?',
        ['person; DROP TABLE person'],
        /Cannot replay/,
      ],
      // Redirect the write at another row by changing the key inside the image.
      [
        "UPDATE change_log SET after_json = json_set(after_json, '$.id', (SELECT id FROM person ORDER BY id LIMIT 1)) WHERE batch_id = ?",
        [],
        /key does not match/,
      ],
      [
        "UPDATE change_log SET after_json = json_remove(after_json, '$.created_at') WHERE batch_id = ?",
        [],
        /missing created_at/,
      ],
      ['UPDATE change_log SET schema_version = 99 WHERE batch_id = ?', [], /newer/],
      [
        "UPDATE change_log SET after_json = json_set(after_json, '$.sex', json('{}')) WHERE batch_id = ?",
        [],
        /values/,
      ],
      ["UPDATE change_log SET after_json = 'not json' WHERE batch_id = ?", [], /not JSON/],
    ];
    for (const [sql, params, message] of cases) {
      const { store, batchId, before } = tampered(sql, ...params);
      expect(() => undo(store, batchId)).toThrow(message);
      expect(snapshot(store)).toBe(before);
      expect(listBatches(store).find((b) => b.id === batchId)?.state).toBe('applied');
      store.close();
    }
  });

  it('ignores unknown keys in a logged image, so they never reach SQL', () => {
    const store = memoryTree();
    const { batchId, result: p } = store.transact('add', (tx) => persons.create(tx, { sex: 'M' }));
    store.db
      .prepare(
        `UPDATE change_log SET after_json = json_set(after_json, '$."sex = ''F'' --"', 1) WHERE batch_id = ?`,
      )
      .run(batchId);
    undo(store, batchId);
    expect(persons.get(store, p.id)).toBeUndefined();
    store.close();
  });

  it('restores a cascading person delete exactly', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    const before = snapshot(store);
    const index = searchIndex(store);
    const { batchId } = store.transact('delete', (tx) => persons.delete(tx, f.dad));
    undo(store, batchId);
    expect(snapshot(store)).toBe(before);
    expect(searchIndex(store)).toEqual(index);
    store.close();
  });

  // Random edit scripts against a seeded tree. After applying them, undoing every
  // batch newest-first must reproduce each earlier snapshot byte for byte, and
  // redoing them oldest-first must reproduce each later one.
  it('undo/redo of any batch sequence restores exact prior states (property)', () => {
    type Op = (tx: Tx, ids: Ids) => void;
    interface Ids {
      people: string[];
      families: string[];
      names: string[];
      events: string[];
      places: string[];
      notes: string[];
      tags: string[];
    }
    const pick = (list: string[], n: number) => list[n % list.length];

    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc
        .record({ given: fc.string({ maxLength: 8 }), sex: fc.constantFrom('M', 'F', 'U') })
        .map(({ given, sex }): Op => (tx, ids) => {
          const p = persons.create(tx, { sex: sex as 'M', names: [{ given, surname: 'Rook' }] });
          ids.people.push(p.id);
        }),
      fc.nat().map((n): Op => (tx, ids) => {
        const id = pick(ids.people, n);
        if (!id || !persons.get(tx.store, id)) return;
        persons.delete(tx, id);
      }),
      fc.tuple(fc.nat(), fc.string({ maxLength: 8 })).map(([n, surname]): Op => (tx, ids) => {
        const id = pick(ids.people, n);
        if (!id || !persons.get(tx.store, id)) return;
        ids.names.push(names.add(tx, id, { surname, type: 'aka' }).id);
      }),
      fc.tuple(fc.nat(), fc.string({ maxLength: 8 })).map(([n, given]): Op => (tx, ids) => {
        const id = pick(ids.names, n);
        if (!id || !names.get(tx.store, id)) return;
        if (n % 3 === 0) names.setPrimary(tx, id);
        else if (n % 3 === 1) names.update(tx, id, { given });
        else names.delete(tx, id);
      }),
      fc.tuple(fc.nat(), fc.nat(), fc.nat()).map(([a, b, c]): Op => (tx, ids) => {
        const live = ids.people.filter((id) => persons.get(tx.store, id));
        const p1 = pick(live, a);
        const p2 = pick(live, b);
        const child = pick(live, c);
        if (!p1 || !p2 || !child || p1 === p2 || child === p1 || child === p2) return;
        const fam = families.create(tx, {
          partner1_id: p1,
          partner2_id: p2,
          children: [{ child_id: child, partner1_rel: 'adopted' }],
        });
        ids.families.push(fam.id);
      }),
      fc.nat().map((n): Op => (tx, ids) => {
        const id = pick(ids.families, n);
        if (!id || !families.get(tx.store, id)) return;
        if (n % 2) families.delete(tx, id);
        else families.update(tx, id, { relationship_type: 'partners' });
      }),
      fc.tuple(fc.nat(), fc.nat()).map(([n, m]): Op => (tx, ids) => {
        const fam = pick(ids.families, n);
        const child = pick(ids.people, m);
        if (!fam || !child || !families.get(tx.store, fam) || !persons.get(tx.store, child)) return;
        const existing = familyChildren
          .listForFamily(tx.store, fam)
          .find((c) => c.child_id === child);
        if (existing) familyChildren.delete(tx, existing.id);
        else familyChildren.create(tx, { family_id: fam, child_id: child });
      }),
      fc
        .tuple(fc.nat(), fc.integer({ min: 1500, max: 2025 }), fc.nat())
        .map(([n, year, pl]): Op => (tx, ids) => {
          const id = pick(ids.people, n);
          if (!id || !persons.get(tx.store, id)) return;
          const place_id = pick(ids.places, pl);
          const e = events.create(tx, {
            type: n % 2 ? 'BIRT' : 'DEAT',
            date_sort: year * 10000 + 101,
            date_text: String(year),
            place_id: place_id && places.get(tx.store, place_id) ? place_id : null,
            roles: [{ person_id: id }],
          });
          ids.events.push(e.id);
        }),
      fc.tuple(fc.nat(), fc.integer({ min: 1500, max: 2025 })).map(([n, year]): Op => (tx, ids) => {
        const id = pick(ids.events, n);
        if (!id || !events.get(tx.store, id)) return;
        if (n % 2) events.delete(tx, id);
        else events.update(tx, id, { date_sort: year * 10000 + 101 });
      }),
      fc.tuple(fc.nat(), fc.string({ maxLength: 10 })).map(([n, name]): Op => (tx, ids) => {
        const id = pick(ids.places, n);
        if (n % 3 === 0 || !id || !places.get(tx.store, id)) {
          ids.places.push(places.create(tx, { name, full_name: `${name}, Wexmoor` }).id);
        } else if (n % 3 === 1) {
          places.update(tx, id, { full_name: `${name}, Fenmark` });
        } else {
          places.delete(tx, id);
        }
      }),
      fc.tuple(fc.nat(), fc.nat()).map(([n, m]): Op => (tx, ids) => {
        const person = pick(ids.people, n);
        if (!person || !persons.get(tx.store, person)) return;
        const note = notes.create(tx, { text: `note ${m}` });
        noteLinks.create(tx, { note_id: note.id, owner_type: 'person', owner_id: person });
        ids.notes.push(note.id);
        const tag = pick(ids.tags, m);
        if (tag && tags.get(tx.store, tag)) {
          const already = tagLinks
            .listFor(tx.store, 'person', person)
            .some((l) => l.tag_id === tag);
          if (!already)
            tagLinks.create(tx, { tag_id: tag, owner_type: 'person', owner_id: person });
        } else {
          ids.tags.push(tags.create(tx, { name: `t${m}`, category: String(m % 3) }).id);
        }
      }),
    );

    fc.assert(
      fc.property(
        fc.array(fc.array(opArb, { minLength: 1, maxLength: 4 }), { maxLength: 12 }),
        (script) => {
          const store = memoryTree();
          const f = seedSmallFamily(store);
          const ids: Ids = {
            people: Object.values(f).filter((id) => persons.get(store, id)),
            families: [f.parentsFamily, f.grandparentsFamily, f.myFamily],
            names: [],
            events: [],
            places: [],
            notes: [],
            tags: [],
          };
          const snapshots = [snapshot(store)];
          const indexes = [searchIndex(store)];
          const batches: string[] = [];
          for (const ops of script) {
            const { batchId } = store.transact('step', (tx) => {
              for (const op of ops) op(tx, ids);
            });
            if (store.db.prepare('SELECT 1 FROM change_batch WHERE id = ?').get(batchId)) {
              batches.push(batchId);
              snapshots.push(snapshot(store));
              indexes.push(searchIndex(store));
            }
          }
          for (let i = batches.length - 1; i >= 0; i--) {
            undo(store, batches[i] as string);
            expect(snapshot(store)).toBe(snapshots[i]);
            expect(searchIndex(store)).toEqual(indexes[i]);
          }
          for (let i = 0; i < batches.length; i++) {
            redo(store, batches[i] as string);
            expect(snapshot(store)).toBe(snapshots[i + 1]);
            expect(searchIndex(store)).toEqual(indexes[i + 1]);
          }
          // The incrementally maintained index must equal a from-scratch rebuild.
          const incremental = searchIndex(store);
          rebuildSearchIndex(store);
          expect(searchIndex(store)).toEqual(incremental);
          store.close();
        },
      ),
      { numRuns: 60 },
    );
    // Each run builds a SQLite tree and replays up to 48 edits; about 0.7s
    // alone, but over the 5s default when the whole suite runs in parallel.
  }, 30_000);
});
