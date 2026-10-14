import { describe, expect, it } from 'vitest';
import {
  MAX_SEARCH_LENGTH,
  MAX_SEARCH_WORDS,
  MIN_PREFIX_LENGTH,
  events,
  names,
  persons,
  places,
  rebuildSearchIndex,
  searchPeople,
} from './index';
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
    const exact = searchPeople(store, 'vale 1960');
    expect(exact[0]).toMatchObject({ person: { id: f.me }, match: 'exact' });
    expect(exact.slice(1).every((r) => r.match === 'prefix')).toBe(true);
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

  it('ranks exact matches above prefix matches above sounds-alike matches', () => {
    const store = memoryTree();
    const keys = (word: string) =>
      ({ smith: ['SM0'], smithson: ['SM0S'], smyth: ['SM0'] })[word.toLowerCase()] ?? [];
    const { result } = store.transact('add', (tx) => {
      const add = (given: string, surname: string, key: string) =>
        persons.create(tx, { names: [{ given, surname, surname_key: key }] }).id;
      return {
        smithson: add('Ada', 'Smithson', 'SM0S'),
        smyth: add('Ada', 'Smyth', 'SM0'),
        smith: add('Ada', 'Smith', 'SM0'),
      };
    });
    const found = searchPeople(store, 'ada smith', { phoneticKeys: keys });
    expect(found.map((r) => r.person.id)).toEqual([result.smith, result.smithson, result.smyth]);
    expect(found.map((r) => r.match)).toEqual(['exact', 'prefix', 'phonetic']);
    expect(found[0]!.score).toBeGreaterThan(found[1]!.score);
    expect(found[1]!.score).toBeGreaterThan(found[2]!.score);
    store.close();
  });

  it('applies phonetic keys per word, so other words still have to match', () => {
    const store = memoryTree();
    const keys = (word: string) => (word.toLowerCase() === 'smith' ? ['SM0'] : []);
    const { result } = store.transact('add', (tx) => ({
      ada: persons.create(tx, { names: [{ given: 'Ada', surname: 'Smyth', surname_key: 'SM0' }] })
        .id,
      bea: persons.create(tx, { names: [{ given: 'Bea', surname: 'Smyth', surname_key: 'SM0' }] })
        .id,
    }));
    expect(
      searchPeople(store, 'ada smith', { phoneticKeys: keys }).map((r) => r.person.id),
    ).toEqual([result.ada]);
    store.close();
  });

  it('matches a year within two years, exact years first', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    const born = (id: string) =>
      (
        store.db
          .prepare(
            "SELECT e.date_sort / 10000 AS y FROM event e JOIN event_role r ON r.event_id = e.id WHERE r.person_id = ? AND e.type = 'BIRT'",
          )
          .get(id) as { y: number }
      ).y;
    const year = born(f.me);
    const near = searchPeople(store, `vale ${year + 1}`);
    expect(near.map((r) => r.person.id)).toContain(f.me);
    expect(near.find((r) => r.person.id === f.me)!.match).toBe('prefix');
    expect(searchPeople(store, `vale ${year}`)[0]!.person.id).toBe(f.me);
    expect(searchPeople(store, `vale ${year + 5}`).map((r) => r.person.id)).not.toContain(f.me);
    store.close();
  });

  it('returns each person once across tiers and honors the limit', () => {
    const store = memoryTree();
    seedSmallFamily(store);
    const all = searchPeople(store, 'vale', { phoneticKeys: () => ['VAL'] });
    expect(new Set(all.map((r) => r.person.id)).size).toBe(all.length);
    expect(searchPeople(store, 'va', { limit: 3 })).toHaveLength(3);
    store.close();
  });

  it('normalizes decomposed input and bounds repeated or excess words', () => {
    const store = memoryTree();
    const { result: p } = store.transact('add', (tx) =>
      persons.create(tx, { names: [{ given: 'José', surname: 'Müller' }] }),
    );
    // NFD: "e" + combining acute, "u" + combining diaeresis.
    expect(searchPeople(store, 'Jose\u0301 Mu\u0308ller').map((r) => r.person.id)).toEqual([p.id]);
    // Repeated words count once, so this is just "jose".
    expect(searchPeople(store, 'jose '.repeat(100)).map((r) => r.person.id)).toEqual([p.id]);
    // Only the first MAX_SEARCH_WORDS distinct words are used.
    const many = ['jose', 'muller', ...Array.from({ length: 20 }, (_, i) => `zz${i}`)].join(' ');
    expect(searchPeople(store, many)).toEqual([]);
    expect(MAX_SEARCH_WORDS).toBe(8);
    store.close();
  });

  it('matches a single letter only as a whole word and ignores text past the length cap', () => {
    const store = memoryTree();
    const { result } = store.transact('add', (tx) => ({
      initial: persons.create(tx, { names: [{ given: 'J', surname: 'Pike' }] }).id,
      full: persons.create(tx, { names: [{ given: 'Jory', surname: 'Pike' }] }).id,
    }));
    expect(searchPeople(store, 'j pike').map((r) => r.person.id)).toEqual([result.initial]);
    expect(searchPeople(store, 'jo pike').map((r) => r.person.id)).toEqual([result.full]);
    expect(MIN_PREFIX_LENGTH).toBe(2);
    const padded = `${' '.repeat(MAX_SEARCH_LENGTH)}pike`;
    expect(searchPeople(store, padded)).toEqual([]);
    store.close();
  });
});
