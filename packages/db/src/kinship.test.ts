import fc from 'fast-check';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createTree,
  events,
  families,
  familyChildren,
  getRelationship,
  meta,
  notes,
  openTree,
  persons,
  tags,
  type TreeStore,
} from './index';
import { kinshipStats } from './kinship';
import { memoryTree, seedSmallFamily } from './test/helpers';
import { makeTempDir } from '../../../fixtures/temp-dir';

describe('getRelationship (whole tree)', () => {
  it('names blood, spouse and in-law ties anywhere in the tree', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    expect(getRelationship(store, f.grandkid, f.dad).name).toBe('great-granddaughter');
    expect(getRelationship(store, f.spouse, f.me).name).toBe('wife');
    expect(getRelationship(store, f.dad, f.spouse).name).toBe('father-in-law');
    expect(getRelationship(store, f.spouse, f.sister).name).toBe('sister-in-law');
  });

  it('returns a summary for everyone on the paths', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    const r = getRelationship(store, f.sister, f.spouse);
    const ids = r.relationships[0]!.paths[0]!.ids;
    expect([ids[0], ids.at(-2), ids.at(-1)]).toEqual([f.sister, f.me, f.spouse]);
    expect(r.people.map((p) => p.id).sort()).toEqual([...new Set(ids)].sort());
  });

  it('sees edits made after the first lookup', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    expect(getRelationship(store, f.grandpa, f.spouse).name).toBe('grandfather-in-law');
    const stranger = store.transact('add', (tx) => {
      const p = persons.create(tx, { sex: 'F', names: [{ given: 'Odile', surname: 'Marsh' }] });
      families.create(tx, { partner1_id: f.kid, partner2_id: p.id, relationship_type: 'married' });
      return p.id;
    }).result;
    expect(getRelationship(store, stranger, f.me).name).toBe('daughter-in-law');
  });

  it('uses marriage and death dates for step relationships', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    // Nerys's second husband married her after Ivo died; Petra was 40 by then.
    store.transact('remarry', (tx) => {
      const event = (type: string, year: number, role: object) =>
        events.create(tx, {
          type,
          date_text: String(year),
          date_sort: year * 10000 + 701,
          roles: [role],
        });
      event('DEAT', 1999, { person_id: f.dad });
      const second = persons.create(tx, { sex: 'M', names: [{ given: 'Corin', surname: 'Ash' }] });
      const family = families.create(tx, {
        partner1_id: second.id,
        partner2_id: f.mom,
        relationship_type: 'married',
      });
      event('MARR', 2002, { family_id: family.id });
      // A first husband whose marriage ended before Petra was born.
      const first = persons.create(tx, { sex: 'M', names: [{ given: 'Alder', surname: 'Wynn' }] });
      const early = families.create(tx, {
        partner1_id: first.id,
        partner2_id: f.mom,
        relationship_type: 'married',
      });
      event('MARR', 1950, { family_id: early.id });
      event('DIV', 1955, { family_id: early.id });
      return { second: second.id, first: first.id };
    });
    const id = (given: string) =>
      (
        store.stmt('SELECT person_id FROM person_name WHERE given = ?').get(given) as {
          person_id: string;
        }
      ).person_id;
    expect(getRelationship(store, id('Corin'), f.sister).name).toBe('stepfather');
    expect(getRelationship(store, id('Alder'), f.sister).name).toBe('husband of mother');
  });
});

describe('getRelationship depth', () => {
  it('names relatives far past 20 generations', () => {
    const store = memoryTree();
    const line = store.transact('line', (tx) => {
      const ids = Array.from(
        { length: 32 },
        (_, i) => persons.create(tx, { sex: 'M', names: [{ given: `G${i}`, surname: 'Deep' }] }).id,
      );
      for (let i = 1; i < ids.length; i++) {
        families.create(tx, { partner1_id: ids[i]!, children: [{ child_id: ids[i - 1]! }] });
      }
      return ids;
    }).result;
    const r = getRelationship(store, line[25]!, line[0]!);
    expect(r).toMatchObject({ name: '23rd great-grandfather', complete: true });
    expect(getRelationship(store, line[0]!, line[31]!).name).toBe('29th great-grandson');
  });
});

describe('getRelationship keeps its graph current', () => {
  /** Answer from a throwaway graph built from scratch (lookups inside a transaction do that). */
  const fresh = (store: TreeStore, a: string, b: string) =>
    store.db.transaction(() => getRelationship(store, a, b))();
  const attempt = (edit: () => unknown) => {
    try {
      edit();
    } catch (error) {
      if (!(error instanceof Error) || !/constraint/i.test(error.message)) throw error;
    }
  };
  /** The answer without the person summaries. */
  const names = (r: ReturnType<typeof getRelationship>) => ({
    name: r.name,
    complete: r.complete,
    relationships: r.relationships,
  });

  it('drops nothing for writes that cannot change a relationship', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    getRelationship(store, f.kid, f.dad);
    const before = { ...kinshipStats };
    store.transact('tag', (tx) => tags.create(tx, { name: 'Research' }));
    store.transact('meta', (tx) => meta.setHomePerson(tx, f.me));
    store.transact('note', (tx) => notes.create(tx, { text: 'A note' }));
    expect(getRelationship(store, f.kid, f.dad).name).toBe('grandson');
    expect(kinshipStats).toEqual(before);
  });

  it('drops only what an edit touched and matches a fresh graph', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom('marry', 'child', 'rel', 'sex', 'unlink', 'divorce', 'person'),
            fc.nat(),
            fc.nat(),
          ),
          { minLength: 1, maxLength: 12 },
        ),
        (edits) => {
          const store = memoryTree();
          seedSmallFamily(store);
          const ids = () =>
            (store.stmt('SELECT id FROM person ORDER BY id').all() as { id: string }[]).map(
              (r) => r.id,
            );
          const pick = <T>(list: T[], n: number) => list[n % list.length]!;
          getRelationship(store, ids()[0]!, ids()[1]!);
          for (const [kind, x, y] of edits) {
            // Some random edits break a constraint and roll back; the graph must cope with
            // rows its triggers saw but the database never kept.
            attempt(() =>
              store.transact(kind, (tx) => {
                const people = ids();
                const links = store.stmt('SELECT id FROM family_child ORDER BY id').all() as {
                  id: string;
                }[];
                const fams = store.stmt('SELECT id FROM family ORDER BY id').all() as {
                  id: string;
                }[];
                if (kind === 'marry') {
                  families.create(tx, {
                    partner1_id: pick(people, x),
                    // Never the same person twice.
                    partner2_id: pick(people, x + 1 + (y % (people.length - 1))),
                    relationship_type: 'married',
                  });
                } else if (kind === 'child' && fams.length) {
                  familyChildren.create(tx, {
                    family_id: pick(fams, x).id,
                    child_id: pick(people, y),
                  });
                } else if (kind === 'rel' && links.length) {
                  tx.update('family_child', pick(links, x).id, {
                    partner1_rel: 'step',
                    partner2_rel: 'adopted',
                  });
                } else if (kind === 'sex') {
                  tx.update('person', pick(people, x), { sex: y % 2 ? 'M' : 'F' });
                } else if (kind === 'unlink' && links.length) {
                  familyChildren.delete(tx, pick(links, x).id);
                } else if (kind === 'divorce' && fams.length) {
                  events.create(tx, {
                    type: 'DIV',
                    date_text: '1950',
                    date_sort: 19500701,
                    roles: [{ family_id: pick(fams, x).id }],
                  });
                } else {
                  persons.create(tx, { sex: 'F', names: [{ given: `New${x}`, surname: 'Vale' }] });
                }
              }),
            );
            const people = ids();
            for (let i = 0; i < 6; i++) {
              const a = pick(people, x + i);
              const b = pick(people, y + 2 * i + 1);
              const resets = kinshipStats.resets;
              const got = names(getRelationship(store, a, b));
              // Edits from this connection drop single rows, never everything.
              expect(kinshipStats.resets).toBe(resets);
              const want = names(fresh(store, a, b));
              expect(got).toEqual(want);
            }
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it('reloads after a write from another connection', () => {
    const dir = join(makeTempDir('oa-kin-'), 'k.oatree');
    const store = createTree(dir);
    const f = seedSmallFamily(store);
    expect(getRelationship(store, f.spouse, f.sister).name).toBe('sister-in-law');
    const other = openTree(dir);
    other.transact('remarry', (tx) =>
      families.create(tx, {
        partner1_id: f.sister,
        partner2_id: f.spouse,
        relationship_type: 'married',
      }),
    );
    other.close();
    expect(getRelationship(store, f.spouse, f.sister).name).toBe('wife and also sister-in-law');
    store.close();
  });
});
