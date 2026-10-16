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
  countPeople,
  searchPeople,
  type TreeStore,
} from './index';
import { bulkInsert, generateSyntheticTree } from './index';
import { refreshSearch } from './search';
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

  it('orders equally good matches by name and counts every match (#280)', () => {
    const store = memoryTree();
    const given = ['Walter', 'Edith', 'Josiah', 'Ruth', 'Daniel', 'Emily', 'Zebulon', 'Ada'];
    store.transact('add', (tx) => {
      for (const g of given) persons.create(tx, { names: [{ given: g, surname: 'Ashgrove' }] });
      persons.create(tx, { names: [{ given: 'Mabel', surname: 'Stone' }] });
    });
    const first = searchPeople(store, 'ashgrove', { limit: 5 }).map((r) => r.person.given);
    expect(first).toEqual(['Ada', 'Daniel', 'Edith', 'Emily', 'Josiah']);
    expect(countPeople(store, 'ashgrove')).toBe(8);
    expect(countPeople(store, 'ashgr')).toBe(8);
    expect(countPeople(store, 'nobody')).toBe(0);
    expect(countPeople(store, '  ')).toBe(0);
    store.close();
  });

  it('puts a whole tied bucket in name order, past the read window (#305)', () => {
    const store = memoryTree();
    // 40 equally good matches added in reverse name order, so the alphabetically
    // first ones are the last added: a window of 15 read in insertion order would miss them.
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const given = Array.from(
      { length: 40 },
      (_, i) => `G${letters[Math.floor(i / 26)]}${letters[i % 26]}`,
    )
      .sort()
      .reverse();
    store.transact('add', (tx) => {
      for (const g of given) persons.create(tx, { names: [{ given: g, surname: 'Kittering' }] });
    });
    const first = searchPeople(store, 'kittering', { limit: 5 }).map((r) => r.person.given);
    expect(first).toEqual([...given].sort().slice(0, 5));
    store.close();
  });

  it('goes by score then id above the tiebreak limit, by name at or below it (#305)', () => {
    const store = memoryTree();
    // Added in reverse name order, so id order and name order differ.
    const given = ['Hugo', 'Gwen', 'Flora', 'Ezra', 'Dora', 'Cyrus', 'Bea', 'Abel'];
    const ids = store.transact('add', (tx) =>
      given.map((g) => persons.create(tx, { names: [{ given: g, surname: 'Ashgrove' }] }).id),
    ).result;
    const givens = (tiebreakMaxMatches: number) =>
      searchPeople(store, 'ashgrove', { limit: 4, tiebreakMaxMatches }).map((r) => r.person.given);
    // 8 matches > 5: plain score order, equal scores by person id (here, the order added).
    const byId = [...ids].sort().map((id) => given[ids.indexOf(id)]);
    expect(givens(5)).toEqual(byId.slice(0, 4));
    // 8 matches <= 8: names.
    expect(givens(8)).toEqual(['Abel', 'Bea', 'Cyrus', 'Dora']);
    expect(countPeople(store, 'ashgrove')).toBe(8);
    store.close();
  });

  it('finds names across common spelling equivalents, both ways (#199)', () => {
    const store = memoryTree();
    const pairs: [stored: string, queries: string[]][] = [
      ['Yılmaz', ['Yilmaz', 'YILMAZ', 'yılmaz']],
      ['Yilmaz', ['Yılmaz']],
      ['Straße', ['Strasse', 'STRASSE', 'straße']],
      ['Strasse', ['Straße', 'STRAẞE']],
      ['כֹּהֵן', ['כהן']],
      ['כהן', ['כֹּהֵן']],
      ['عَلِيّ', ['علي']],
      ['علي', ['عَلِيّ']],
      ["O'Brien", ['OBrien', 'Obrien', 'O’Brien']],
      ['OBrien', ["O'Brien"]],
      ['小明', ['小', '小明']],
      ['İnce', ['ince', 'Ince', 'INCE']],
      ['Ince', ['İnce']],
      ['Işıklar', ['isiklar', 'IŞIKLAR']],
    ];
    const ids = pairs.map(
      ([surname]) =>
        store.transact('add', (tx) => persons.create(tx, { names: [{ given: 'Tester', surname }] }))
          .result.id,
    );
    pairs.forEach(([stored, queries], i) => {
      for (const query of queries) {
        expect(
          searchPeople(store, query).map((r) => r.person.id),
          `${query} -> ${stored}`,
        ).toContain(ids[i]);
      }
    });
    // The part after an apostrophe is still a word of its own.
    const apostrophes = ["O'Brien", 'O’Neill', "D'Angelo"].map(
      (surname) =>
        store.transact('add', (tx) => persons.create(tx, { names: [{ given: 'Apos', surname }] }))
          .result.id,
    );
    expect(searchPeople(store, 'Brien').map((r) => r.person.id)).toContain(apostrophes[0]);
    expect(searchPeople(store, 'Neill').map((r) => r.person.id)).toContain(apostrophes[1]);
    expect(searchPeople(store, 'angelo').map((r) => r.person.id)).toContain(apostrophes[2]);
    expect(searchPeople(store, 'oneill').map((r) => r.person.id)).toContain(apostrophes[1]);
    // The palette's total counts folded spellings too.
    expect(countPeople(store, 'Yilmaz')).toBe(2);
    // A lone Latin letter still only matches exactly (an initial), not every name it starts.
    expect(searchPeople(store, 'Y').map((r) => r.person.id)).toEqual([]);
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

  it('keeps the FTS lookup and the summary queries on indexes (EXPLAIN QUERY PLAN)', () => {
    const store = memoryTree();
    seedSmallFamily(store);
    const recorded = recordQueries(store, () =>
      searchPeople(store, 'vale 1960', { phoneticKeys: () => ['VAL'] }),
    );
    const plans = recorded.map(({ sql, args }) => ({
      sql,
      plan: (
        store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]
      ).map((r) => r.detail),
    }));
    const fts = plans.filter((p) => p.sql.includes('person_search MATCH'));
    expect(fts.length).toBeGreaterThan(0);
    for (const { plan } of fts) {
      // The MATCH is answered by the FTS index, then one rowid lookup per hit.
      expect(
        plan.some((d) => /person_search VIRTUAL TABLE INDEX \d+:M/.test(d)),
        plan.join('; '),
      ).toBe(true);
      expect(plan).toContain('SEARCH d USING INTEGER PRIMARY KEY (rowid=?)');
    }
    // getPersonSummaries: person, person_name, event_role and event via indexes, never a scan.
    const summaries = plans.filter((p) => /FROM person p|event_role r/.test(p.sql));
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    for (const { sql, plan } of summaries) {
      for (const detail of plan) {
        expect(detail, sql).not.toMatch(
          /^SCAN (p|n|r|e|pl|person|person_name|event_role|event|place)\b/,
        );
      }
    }
    store.close();
  });
});

/** Runs `fn` and returns every SQL statement it ran through the store, with its arguments. */
function recordQueries(store: TreeStore, fn: () => unknown): { sql: string; args: unknown[] }[] {
  const seen: { sql: string; args: unknown[] }[] = [];
  const original = store.stmt.bind(store);
  store.stmt = (sql: string) => {
    const statement = original(sql);
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (key === 'all' || key === 'get' || key === 'iterate') {
          return (...args: unknown[]) => {
            seen.push({ sql, args });
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  try {
    fn();
  } finally {
    store.stmt = original;
  }
  return seen;
}

describe('full search rebuild', () => {
  it('builds the same documents as per-person refreshes', () => {
    const store = memoryTree();
    bulkInsert(store, generateSyntheticTree({ people: 300, seed: 11 }));
    seedSmallFamily(store);
    store.transact('edge cases', (tx) => {
      persons.create(tx, {}); // no names, no events
      persons.create(tx, { names: [{ given: 'Ada' }, { surname: 'Lyle', type: 'aka' }] });
      // Names the spelling fold changes (#199): the set-wise rebuild must fold them too.
      for (const surname of ['Yılmaz', 'Straße', "O'Brien"]) {
        persons.create(tx, { names: [{ given: 'Fold', surname }] });
      }
    });
    const docs = () =>
      store.db
        .prepare(
          `SELECT d.person_id, s.names, s.phonetic, s.places, s.years
           FROM search_doc d JOIN person_search s ON s.rowid = d.doc_id ORDER BY d.person_id`,
        )
        .all();
    rebuildSearchIndex(store);
    const rebuilt = docs();
    const ids = (store.db.prepare('SELECT id FROM person').all() as { id: string }[]).map(
      (r) => r.id,
    );
    store.db.transaction(() => refreshSearch(store, ids))();
    expect(rebuilt).toEqual(docs());
    expect(rebuilt).toHaveLength(ids.length);
    store.close();
  });

  it('folds spellings when a bulk load rebuilds the index', () => {
    const store = memoryTree();
    const data = generateSyntheticTree({ people: 20, seed: 3 });
    const target = data.person_name[0]!;
    target.surname = 'Yılmaz';
    bulkInsert(store, data);
    expect(searchPeople(store, 'Yilmaz').map((r) => r.person.id)).toContain(target.person_id);
    rebuildSearchIndex(store);
    expect(searchPeople(store, 'Yilmaz').map((r) => r.person.id)).toContain(target.person_id);
    store.close();
  });
});
