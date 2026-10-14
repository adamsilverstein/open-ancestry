import { describe, expect, it } from 'vitest';
import { events, families, getRelationship, persons } from './index';
import { memoryTree, seedSmallFamily } from './test/helpers';

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
