import { describe, expect, it } from 'vitest';
import { events, names, persons, places, rebuildSearchIndex, searchPeople } from './index';
import { memoryTree, seedSmallFamily } from './test/helpers';

describe('searchPeople', () => {
  it('finds people by any name variant with prefix matching', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    store.transact('aka', (tx) =>
      names.add(tx, f.sister, { given: 'Petra', surname: 'Larch', type: 'married' }),
    );
    expect(searchPeople(store, 'petra').map((r) => r.person.id)).toEqual([f.sister]);
    expect(searchPeople(store, 'Lar').map((r) => r.person.id)).toEqual([f.sister]);
    expect(searchPeople(store, 'ellis vale').map((r) => r.person.id)).toEqual([f.me]);
    expect(searchPeople(store, 'vale').length).toBe(6);
    expect(searchPeople(store, 'vale', { limit: 2 }).length).toBe(2);
    store.close();
  });

  it('ignores diacritics and FTS syntax in the query', () => {
    const store = memoryTree();
    const { result: p } = store.transact('add', (tx) =>
      persons.create(tx, { names: [{ given: 'Zoë', surname: 'Ångström' }] }),
    );
    expect(searchPeople(store, 'zoe angstrom').map((r) => r.person.id)).toEqual([p.id]);
    expect(searchPeople(store, 'zoe" ( * -').map((r) => r.person.id)).toEqual([p.id]);
    expect(searchPeople(store, '  ')).toEqual([]);
    store.close();
  });

  it('matches places and years', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    expect(searchPeople(store, 'brackenford').length).toBe(9);
    expect(searchPeople(store, 'vale 1960').map((r) => r.person.id)).toEqual([f.me]);
    store.close();
  });

  it('matches caller-supplied phonetic surname keys', () => {
    const store = memoryTree();
    const { result: p } = store.transact('add', (tx) =>
      persons.create(tx, { names: [{ given: 'Ada', surname: 'Smythe', surname_key: 'SM0' }] }),
    );
    expect(searchPeople(store, 'smith')).toEqual([]);
    expect(searchPeople(store, 'smith', { phoneticKeys: ['SM0'] }).map((r) => r.person.id)).toEqual(
      [p.id],
    );
    store.close();
  });

  it('ranks name matches above place matches', () => {
    const store = memoryTree();
    const { result } = store.transact('add', (tx) => {
      const town = places.create(tx, { name: 'Marigold', full_name: 'Marigold, Fenmark' });
      const named = persons.create(tx, { names: [{ given: 'Marigold', surname: 'Pike' }] });
      const placed = persons.create(tx, { names: [{ given: 'Oriel', surname: 'Pike' }] });
      events.create(tx, { type: 'BIRT', place_id: town.id, roles: [{ person_id: placed.id }] });
      return { named, placed };
    });
    expect(searchPeople(store, 'marigold').map((r) => r.person.id)).toEqual([
      result.named.id,
      result.placed.id,
    ]);
    store.close();
  });

  it('stays in sync with edits to names, events and places', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    const placeId = (store.db.prepare('SELECT id FROM place').get() as { id: string }).id;
    store.transact('rename place', (tx) => places.update(tx, placeId, { full_name: 'Thornbury' }));
    expect(searchPeople(store, 'thornbury').length).toBe(9);
    expect(searchPeople(store, 'brackenford')).toEqual([]);
    const nameId = names.list(store, f.kid)[0]?.id as string;
    store.transact('rename', (tx) => names.update(tx, nameId, { given: 'Kester' }));
    expect(searchPeople(store, 'kester').map((r) => r.person.id)).toEqual([f.kid]);
    store.transact('delete', (tx) => persons.delete(tx, f.kid));
    expect(searchPeople(store, 'kester')).toEqual([]);
    const before = store.db.prepare('SELECT * FROM person_search ORDER BY rowid').all();
    rebuildSearchIndex(store);
    expect(store.db.prepare('SELECT count(*) AS n FROM person_search').get()).toEqual({
      n: before.length,
    });
    store.close();
  });
});
