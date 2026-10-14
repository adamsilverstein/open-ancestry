/*
 * Property test: random edit, undo and redo sequences on the sample tree,
 * checked after every step against a stack model of the JSON export.
 * UNDO_RUNS sets the number of sequences (default 25). To replay a CI failure,
 * run with FC_SEED=<seed> FC_PATH=<path> from the failure message.
 */
import { arbDateText } from '@open-ancestry/core/testing/dates';
import {
  events,
  exportJsonString,
  families,
  familyChildren,
  meta,
  names,
  noteLinks,
  notes,
  persons,
  rebuildSearchIndex,
  redoLast,
  undoLast,
  type TreeStore,
} from '@open-ancestry/db';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportGedcom } from './index';
import { FIXTURES, TODAY, importInto } from './test-helpers';

const RUNS = Number(process.env.UNDO_RUNS ?? 25);
const replay = process.env.FC_SEED
  ? { seed: Number(process.env.FC_SEED), path: process.env.FC_PATH, endOnFailure: true }
  : {};
const SAMPLE = readFileSync(join(FIXTURES, 'ancestry-sample.ged'));

/** The whole tree as the JSON interchange writes it, without the history tables. */
const state = (store: TreeStore) => exportJsonString(store, { history: false });

const search = (store: TreeStore) =>
  JSON.stringify(
    store.db
      .prepare(
        `SELECT d.person_id, s.names, s.phonetic, s.places, s.years
         FROM person_search s JOIN search_doc d ON d.doc_id = s.rowid ORDER BY d.person_id`,
      )
      .all(),
  );

const ids = (store: TreeStore, table: string) =>
  store.db.prepare(`SELECT id FROM ${table} ORDER BY id`).pluck().all() as string[];
const pick = <T>(list: T[], n: number) => list[n % list.length]!;

const step = fc.record({
  kind: fc.constantFrom(
    'rename',
    'sex',
    'addEvent',
    'editEvent',
    'deleteEvent',
    'addPerson',
    'deletePerson',
    'addFamily',
    'addChild',
    'deleteFamily',
    'note',
    'home',
    'undo',
    'undo',
    'redo',
    'redo',
    // Several undos then several redos: the order redo replays batches in matters.
    'burst',
    'burst',
  ),
  a: fc.nat(),
  b: fc.nat(),
  date: fc.option(arbDateText, { nil: null }),
  text: fc.oneof(
    fc.string({ maxLength: 8 }),
    fc.constantFrom('Zoë', 'Zoë', 'דוד', '😀', 'Ann "Nan"', ''),
  ),
});
type Step = typeof step extends fc.Arbitrary<infer T> ? T : never;

/** A burst becomes 1-3 undos followed by 1-3 redos; every other step is one action. */
const expand = (steps: Step[]): Step[] =>
  steps.flatMap((s) =>
    s.kind === 'burst'
      ? [
          ...Array.from({ length: (s.a % 3) + 1 }, () => ({ ...s, kind: 'undo' as const })),
          ...Array.from({ length: (s.b % 3) + 1 }, () => ({ ...s, kind: 'redo' as const })),
        ]
      : [s],
  );

/** Applies one step; returns what happened. Undo and redo report `none` when there was nothing to do. */
function run(store: TreeStore, s: Step): 'edit' | 'undo' | 'redo' | 'none' {
  const people = ids(store, 'person');
  const eventIds = ids(store, 'event');
  const familyIds = ids(store, 'family');
  const nameIds = ids(store, 'person_name');
  const edit = (fn: Parameters<TreeStore['transact']>[1]) => {
    store.transact(s.kind, fn);
    return 'edit' as const;
  };
  switch (s.kind) {
    case 'rename':
      return edit((tx) => names.update(tx, pick(nameIds, s.a), { given: s.text || null }));
    case 'sex':
      return edit((tx) =>
        persons.update(tx, pick(people, s.a), { sex: pick(['M', 'F', 'X', 'U'] as const, s.b) }),
      );
    case 'addEvent':
      return edit((tx) =>
        events.create(tx, {
          type: 'OCCU',
          value: s.text || null,
          roles: [{ person_id: pick(people, s.a), role: 'principal' }],
        }),
      );
    case 'editEvent':
      if (!eventIds.length) return 'none';
      return edit((tx) => events.update(tx, pick(eventIds, s.a), { date_text: s.date }));
    case 'deleteEvent':
      if (!eventIds.length) return 'none';
      return edit((tx) => events.delete(tx, pick(eventIds, s.a)));
    case 'addPerson':
      return edit((tx) =>
        persons.create(tx, { names: [{ given: s.text || 'X', surname: 'Q', is_primary: 1 }] }),
      );
    case 'deletePerson':
      if (people.length < 3) return 'none';
      return edit((tx) => persons.delete(tx, pick(people, s.a)));
    case 'addFamily': {
      const [p1, p2] = [pick(people, s.a), pick(people, s.b)];
      if (p1 === p2) return 'none';
      return edit((tx) => families.create(tx, { partner1_id: p1, partner2_id: p2 }));
    }
    case 'addChild': {
      if (!familyIds.length) return 'none';
      const [family, child] = [pick(familyIds, s.a), pick(people, s.b)];
      const linked = store.db
        .prepare('SELECT 1 FROM family_child WHERE family_id = ? AND child_id = ?')
        .get(family, child);
      if (linked) return 'none';
      return edit((tx) => familyChildren.create(tx, { family_id: family, child_id: child }));
    }
    case 'deleteFamily':
      if (!familyIds.length) return 'none';
      return edit((tx) => families.delete(tx, pick(familyIds, s.a)));
    case 'note':
      return edit((tx) => {
        const n = notes.create(tx, { text: s.text || 'note' });
        noteLinks.create(tx, { note_id: n.id, owner_type: 'person', owner_id: pick(people, s.a) });
      });
    case 'home':
      return edit((tx) => meta.setHomePerson(tx, pick(people, s.a)));
    case 'undo':
      return undoLast(store) ? 'undo' : 'none';
    case 'redo':
      return redoLast(store) ? 'redo' : 'none';
  }
  return 'none';
}

describe('property: edit, undo and redo', { timeout: 300_000 }, () => {
  it('match a stack model in the JSON export, keep search consistent, and undo back to the imported export', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 30 }), async (steps) => {
        const store = await importInto(SAMPLE);
        const initialJson = state(store);
        const initialGedcom = exportGedcom(store, { now: TODAY });
        const undoStack: string[] = [];
        const redoStack: string[] = [];
        const batches = () =>
          store.db.prepare('SELECT count(*) FROM change_batch').pluck().get() as number;
        for (const s of expand(steps)) {
          const before = state(store);
          const count = batches();
          const kind = run(store, s);
          const after = state(store);
          if (kind === 'edit' && batches() > count) {
            // A new batch, even one that changed nothing visible, clears the redo stack.
            undoStack.push(before);
            redoStack.length = 0;
          } else if (kind === 'none' && s.kind === 'undo') {
            expect(undoStack).toHaveLength(0);
          } else if (kind === 'none' && s.kind === 'redo') {
            expect(redoStack).toHaveLength(0);
          } else if (kind === 'undo') {
            expect(after).toBe(undoStack.pop());
            redoStack.push(before);
          } else if (kind === 'redo') {
            expect(after).toBe(redoStack.pop());
            undoStack.push(before);
          }
          const indexed = search(store);
          rebuildSearchIndex(store);
          expect(search(store)).toBe(indexed);
          expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        }
        while (undoLast(store));
        expect(state(store)).toBe(initialJson);
        expect(exportGedcom(store, { now: TODAY })).toBe(initialGedcom);
        store.close();
      }),
      { numRuns: RUNS, ...replay },
    );
  });
});
