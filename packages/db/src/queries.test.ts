import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  citationLinks,
  createTree,
  names,
  openTree,
  undoLast,
  citations,
  events,
  families,
  familyChildren,
  getNeighborhood,
  getPersonDetail,
  getPersonSummaries,
  getPersonSummary,
  listPeople,
  media,
  mediaLinks,
  noteLinks,
  notes,
  persons,
  sources,
  tagLinks,
  tags,
  BIRTH_TYPES,
  DEATH_TYPES,
  bulkInsert,
  generateSyntheticTree,
  type ListPeopleOptions,
  type TreeStore,
} from './index';
import { memoryTree, seedSmallFamily } from './test/helpers';
import { makeTempDir } from '../../../fixtures/temp-dir';

describe('person summaries', () => {
  it('returns primary name and vital events', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    store.transact('death', (tx) =>
      events.create(tx, {
        type: 'DEAT',
        date_text: '3 MAR 1970',
        date_sort: 19700303,
        roles: [{ person_id: f.grandpa }],
      }),
    );
    const s = getPersonSummary(store, f.grandpa);
    expect(s).toMatchObject({
      id: f.grandpa,
      sex: 'M',
      living: 'unknown',
      given: 'Orrin',
      surname: 'Vale',
      birth: { type: 'BIRT', dateText: '1900', dateSort: 19000701, place: 'Brackenford, Wexmoor' },
      death: { type: 'DEAT', dateText: '3 MAR 1970', place: null },
    });
    expect(getPersonSummary(store, 'missing')).toBeNull();
    store.close();
  });

  it('prefers BIRT over CHR and preferred alternates over others', () => {
    const store = memoryTree();
    const { result: id } = store.transact('add', (tx) => {
      const p = persons.create(tx, {});
      events.create(tx, { type: 'CHR', date_text: '1801', roles: [{ person_id: p.id }] });
      events.create(tx, {
        type: 'BIRT',
        date_text: '1799',
        roles: [{ person_id: p.id, is_preferred: 0 }],
      });
      events.create(tx, { type: 'BIRT', date_text: '1800', roles: [{ person_id: p.id }] });
      events.create(tx, { type: 'BURI', date_text: '1870', roles: [{ person_id: p.id }] });
      return p.id;
    });
    const s = getPersonSummary(store, id);
    expect(s?.birth?.dateText).toBe('1800');
    expect(s?.death).toMatchObject({ type: 'BURI', dateText: '1870' });
    expect(s?.given).toBeNull();
    store.close();
  });

  it('returns summaries in request order and skips unknown ids', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    expect(getPersonSummaries(store, [f.kid, 'missing', f.me]).map((s) => s.id)).toEqual([
      f.kid,
      f.me,
    ]);
    expect(getPersonSummaries(store, [])).toEqual([]);
    store.close();
  });

  it('says whether the primary photo has a local file', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    store.transact('photos', (tx) => {
      const local = media.create(tx, { kind: 'photo', local_path: 'photos/a.png' });
      const remote = media.create(tx, { kind: 'photo', remote_url: 'https://www.ancestry.com/x' });
      const missing = media.create(tx, { kind: 'photo' });
      tx.update('person', f.me, { primary_media_id: local.id });
      tx.update('person', f.dad, { primary_media_id: remote.id });
      tx.update('person', f.mom, { primary_media_id: missing.id });
    });
    const local = (id: string) => getPersonSummaries(store, [id])[0]!.primaryPhotoLocal;
    expect([f.me, f.dad, f.mom, f.kid].map(local)).toEqual([true, false, false, false]);
    store.close();
  });

  it('versions the primary photo by its bytes, so a replaced file gets a new URL', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    store.transact('photos', (tx) => {
      const photo = media.create(tx, {
        kind: 'photo',
        local_path: 'photos/a.png',
        sha256: 'c0ffee'.repeat(10) + 'beef',
      });
      tx.update('person', f.me, { primary_media_id: photo.id });
    });
    const version = (id: string) => getPersonSummaries(store, [id])[0]!.primaryPhotoVersion;
    expect(version(f.me)).toBe('c0ffeec0ffeec0ff');
    expect(version(f.kid)).toBeNull();
    store.close();
  });
});

describe('person detail', () => {
  it('collects names, events with places and citations, families, media, notes and tags', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    const { result: r } = store.transact('extras', (tx) => {
      const src = sources.create(tx, { title: '1900 Census' });
      const cit = citations.create(tx, { source_id: src.id, page: 'Sheet 4', apid: '1,7884::9' });
      const resi = events.create(tx, { type: 'RESI', roles: [{ person_id: f.me }] });
      citationLinks.create(tx, { citation_id: cit.id, owner_type: 'event', owner_id: resi.id });
      citationLinks.create(tx, { citation_id: cit.id, owner_type: 'person', owner_id: f.me });
      const marr = events.create(tx, {
        type: 'MARR',
        date_text: '1985',
        roles: [{ family_id: f.myFamily }],
      });
      const pic = media.create(tx, { title: 'Wedding', remote_url: 'https://example.invalid/w' });
      mediaLinks.create(tx, { media_id: pic.id, owner_type: 'person', owner_id: f.me });
      const note = notes.create(tx, { text: 'Kept bees.' });
      noteLinks.create(tx, { note_id: note.id, owner_type: 'person', owner_id: f.me });
      const tag = tags.create(tx, { name: 'Brick wall', category: 'Research' });
      tagLinks.create(tx, { tag_id: tag.id, owner_type: 'person', owner_id: f.me });
      return { src, cit, resi, marr, pic, note, tag };
    });

    const d = getPersonDetail(store, f.me);
    expect(d).not.toBeNull();
    if (!d) return;
    expect(d.person.id).toBe(f.me);
    expect(d.names.map((n) => n.given)).toEqual(['Ellis']);
    expect(d.events.map((e) => e.event.type).sort()).toEqual(['BIRT', 'RESI']);
    const birth = d.events.find((e) => e.event.type === 'BIRT');
    expect(birth?.place?.full_name).toBe('Brackenford, Wexmoor');
    expect(birth?.role.role).toBe('principal');
    const resi = d.events.find((e) => e.event.id === r.resi.id);
    expect(resi?.citations.map((c) => [c.citation.apid, c.source.title])).toEqual([
      ['1,7884::9', '1900 Census'],
    ]);
    expect(d.citations.map((c) => c.citation.id)).toEqual([r.cit.id]);

    expect(d.parentFamilies).toHaveLength(1);
    expect(d.parentFamilies[0]?.partner1?.given).toBe('Ivo');
    expect(d.parentFamilies[0]?.partner2?.given).toBe('Nerys');
    expect(d.parentFamilies[0]?.link).toMatchObject({ partner1_rel: 'biological' });
    expect(d.parentFamilies[0]?.siblings.map((s) => s.person.given)).toEqual(['Petra']);

    expect(d.partnerFamilies).toHaveLength(1);
    expect(d.partnerFamilies[0]?.partner?.given).toBe('Briony');
    expect(d.partnerFamilies[0]?.children.map((c) => c.person.given)).toEqual(['Quill']);
    expect(d.partnerFamilies[0]?.events.map((e) => e.event.id)).toEqual([r.marr.id]);

    expect(d.media.map((m) => m.media.title)).toEqual(['Wedding']);
    expect(d.notes.map((n) => n.text)).toEqual(['Kept bees.']);
    expect(d.tags.map((t) => t.name)).toEqual(['Brick wall']);
    expect(getPersonDetail(store, 'missing')).toBeNull();
    store.close();
  });
});

describe('neighborhood', () => {
  it('returns ancestors up, descendants down, spouses and siblings', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    const n = getNeighborhood(store, f.me, { up: 2, down: 2 });
    expect(n.focusId).toBe(f.me);
    const ids = new Set(n.people.map((p) => p.id));
    for (const id of [
      f.grandpa,
      f.grandma,
      f.dad,
      f.mom,
      f.me,
      f.sister,
      f.spouse,
      f.kid,
      f.grandkid,
    ])
      expect(ids.has(id)).toBe(true);
    expect(n.people).toHaveLength(9);
    expect(n.families.map((x) => x.id).sort()).toEqual(
      [
        f.grandparentsFamily,
        f.parentsFamily,
        f.myFamily,
        n.families.find((x) => x.partner1Id === f.kid)?.id,
      ].sort(),
    );
    expect(n.children).toContainEqual({
      familyId: f.parentsFamily,
      childId: f.me,
      partner1Rel: 'biological',
      partner2Rel: 'biological',
      sortOrder: 0,
      childOrder: 0,
      isPreferred: true,
    });
    expect(n.moreUp).toEqual([]);
    expect(n.moreDown).toEqual([]);
    store.close();
  });

  it('limits generations and reports where more exist', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    const n = getNeighborhood(store, f.me, { up: 1, down: 1, siblings: false });
    const ids = n.people.map((p) => p.id).sort();
    expect(ids).toEqual([f.dad, f.mom, f.me, f.spouse, f.kid].sort());
    expect(n.moreUp).toEqual([f.dad]);
    expect(n.moreDown).toEqual([f.kid]);
    const zero = getNeighborhood(store, f.me, { up: 0, down: 0 });
    expect(zero.people.map((p) => p.id).sort()).toEqual([f.me, f.spouse].sort());
    expect(zero.moreUp).toEqual([f.me]);
    expect(zero.moreDown).toEqual([f.me]);
    store.close();
  });

  it("includes ancestors' siblings down to siblingsDepth", () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    const { result: r } = store.transact('aunt', (tx) => {
      const aunt = persons.create(tx, { names: [{ given: 'Wynne', surname: 'Vale' }] }).id;
      const cousin = persons.create(tx, { names: [{ given: 'Rook', surname: 'Vale' }] }).id;
      familyChildren.create(tx, { family_id: f.grandparentsFamily, child_id: aunt });
      families.create(tx, { partner1_id: aunt, children: [{ child_id: cousin }] });
      return { aunt, cousin };
    });
    const ids = (n: { people: { id: string }[] }) => n.people.map((p) => p.id);

    const two = getNeighborhood(store, f.me, { up: 2, down: 0, siblingsDepth: 2 });
    expect(ids(two)).toEqual(expect.arrayContaining([f.sister, r.aunt]));
    expect(ids(two)).not.toContain(r.cousin);
    expect(two.children).toContainEqual(
      expect.objectContaining({ familyId: f.grandparentsFamily, childId: r.aunt }),
    );
    // The aunt has children that were not fetched.
    expect(two.moreDown).toContain(r.aunt);

    const one = getNeighborhood(store, f.me, { up: 2, down: 0 });
    expect(ids(one)).toContain(f.sister);
    expect(ids(one)).not.toContain(r.aunt);
    expect(getNeighborhood(store, f.me, { up: 2, down: 0, siblingsDepth: 1 })).toEqual(one);

    const none = getNeighborhood(store, f.me, { up: 2, down: 0, siblingsDepth: 0 });
    expect(ids(none)).not.toContain(f.sister);
    expect(getNeighborhood(store, f.me, { up: 2, down: 0, siblings: false })).toEqual(none);

    // Capped at `up`: the grandparents are not fetched, so neither is the aunt.
    const capped = getNeighborhood(store, f.me, { up: 1, down: 0, siblingsDepth: 5 });
    expect(ids(capped)).not.toContain(r.aunt);
    expect(ids(capped)).toContain(f.sister);
    store.close();
  });

  it("includes siblings' partners and half siblings", () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    const { result: r } = store.transact('extend', (tx) => {
      const add = (given: string) => persons.create(tx, { names: [{ given, surname: 'Vale' }] }).id;
      const sisterSpouse = add('Tobin');
      const niece = add('Iris');
      const sisterFamily = families.create(tx, {
        partner1_id: f.sister,
        partner2_id: sisterSpouse,
        children: [{ child_id: niece }],
      }).id;
      // Dad's second family: a step-mother and a half brother.
      const stepMother = add('Odette');
      const halfBrother = add('Pell');
      const second = families.create(tx, {
        partner1_id: f.dad,
        partner2_id: stepMother,
        children: [{ child_id: halfBrother }],
      }).id;
      return { sisterSpouse, niece, sisterFamily, stepMother, halfBrother, second };
    });
    const n = getNeighborhood(store, f.me, { up: 1, down: 0 });
    const ids = n.people.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([r.sisterSpouse, r.stepMother, r.halfBrother]));
    expect(ids).not.toContain(r.niece);
    expect(n.families.map((x) => x.id)).toEqual(expect.arrayContaining([r.sisterFamily, r.second]));
    expect(n.children).toContainEqual(
      expect.objectContaining({ familyId: r.second, childId: r.halfBrother }),
    );
    expect(n.children.some((c) => c.childId === r.niece)).toBe(false);
    expect(n.moreDown).toContain(f.sister);

    const none = getNeighborhood(store, f.me, { up: 1, down: 0, siblingsDepth: 0 });
    for (const id of [r.sisterSpouse, r.stepMother, r.halfBrother])
      expect(none.people.map((p) => p.id)).not.toContain(id);
    store.close();
  });

  it('handles pedigree collapse without duplicates', () => {
    const store = memoryTree();
    // Double first cousins marry: both sets of grandparents are shared.
    const { result: r } = store.transact('collapse', (tx) => {
      const p = () => persons.create(tx, {}).id;
      const [g1, g2, a, b, c, d, x, y, z] = [p(), p(), p(), p(), p(), p(), p(), p(), p()];
      families.create(tx, {
        partner1_id: g1,
        partner2_id: g2,
        children: [{ child_id: a }, { child_id: c }],
      });
      const fab = families.create(tx, {
        partner1_id: a,
        partner2_id: b,
        children: [{ child_id: x }],
      });
      const fcd = families.create(tx, {
        partner1_id: c,
        partner2_id: d,
        children: [{ child_id: y }],
      });
      families.create(tx, { partner1_id: x, partner2_id: y, children: [{ child_id: z }] });
      return { g1, g2, z, fab, fcd };
    });
    const n = getNeighborhood(store, r.z, { up: 3, down: 0 });
    const ids = n.people.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(r.g1);
    expect(n.people).toHaveLength(9);
    store.close();
  });

  it('clamps generations and caps the number of people', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    const negative = getNeighborhood(store, f.me, { up: -5, down: -1 });
    expect(negative.people.map((p) => p.id).sort()).toEqual([f.me, f.spouse].sort());
    const huge = getNeighborhood(store, f.me, { up: 1e9, down: Number.NaN });
    expect(huge.people).toHaveLength(7); // ancestors and siblings; NaN down acts as 0
    expect(huge.truncated).toBe(false);

    const capped = getNeighborhood(store, f.me, { up: 2, down: 2, maxPeople: 3 });
    expect(capped.truncated).toBe(true);
    expect(capped.people).toHaveLength(3);
    expect(capped.people[0]?.id).toBe(f.me);
    const kept = new Set(capped.people.map((p) => p.id));
    for (const fam of capped.families) {
      for (const partner of [fam.partner1Id, fam.partner2Id]) {
        if (partner) expect(kept.has(partner)).toBe(true);
      }
    }
    for (const edge of capped.children) expect(kept.has(edge.childId)).toBe(true);
    store.close();
  });

  it('marks the preferred parent family on child edges', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    const { result: adoptive } = store.transact('adopt', (tx) =>
      families.create(tx, { children: [{ child_id: f.me, partner1_rel: 'adopted' }] }),
    );
    const n = getNeighborhood(store, f.me, { up: 1, down: 0 });
    const mine = n.children.filter((c) => c.childId === f.me);
    expect(mine.map((c) => [c.familyId, c.childOrder, c.isPreferred])).toEqual([
      [f.parentsFamily, 0, true],
      [adoptive.id, 1, false],
    ]);
    store.close();
  });

  it('throws for an unknown focus', () => {
    const store = memoryTree();
    expect(() => getNeighborhood(store, 'missing')).toThrow(/not found/);
    store.close();
  });
});

describe('listPeople', () => {
  it('sorts, filters and paginates', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    const bySurname = listPeople(store, { sort: 'surname' });
    expect(bySurname.total).toBe(9);
    expect(bySurname.items.map((p) => p.surname)).toEqual([
      'Fenn',
      'Holt',
      'Reed',
      'Vale',
      'Vale',
      'Vale',
      'Vale',
      'Vale',
      'Vale',
    ]);
    // Same surname falls back to given name.
    expect(bySurname.items.slice(3).map((p) => p.given)).toEqual([
      'Ellis',
      'Ivo',
      'Juniper',
      'Orrin',
      'Petra',
      'Quill',
    ]);
    const byBirthDesc = listPeople(store, { sort: 'birth', direction: 'desc', limit: 2 });
    expect(byBirthDesc.items.map((p) => p.given)).toEqual(['Juniper', 'Quill']);
    expect(byBirthDesc.total).toBe(9);
    const page2 = listPeople(store, { sort: 'given', limit: 3, offset: 3 });
    expect(page2.items.map((p) => p.given)).toEqual(['Juniper', 'Nerys', 'Orrin']);
    expect(listPeople(store, { sex: 'F' }).total).toBe(5);
    // Untyped callers sending an unknown sort get the default order, not an SQL error.
    expect(listPeople(store, { sort: 'bogus' as 'surname' }).items[0]?.surname).toBe('Fenn');
    // A prototype key is not a sort either (#267): the default, not a crash.
    for (const sort of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(listPeople(store, { sort: sort as 'surname' }).items[0]?.surname, sort).toBe('Fenn');
    }

    store.transact('tag', (tx) => {
      const t = tags.create(tx, { name: 'Line A' });
      tagLinks.create(tx, { tag_id: t.id, owner_type: 'person', owner_id: f.kid });
      persons.update(tx, f.grandpa, { living: 'dead' });
      events.create(tx, { type: 'DEAT', date_sort: 19600101, roles: [{ person_id: f.grandma }] });
    });
    const tagId = tags.list(store)[0]?.id;
    expect(listPeople(store, { tagId }).items.map((p) => p.given)).toEqual(['Quill']);
    expect(listPeople(store, { living: ['dead'] }).items.map((p) => p.given)).toEqual(['Orrin']);
    expect(listPeople(store, { sort: 'death' }).items[0]?.given).toBe('Tamsin');
    store.close();
  });

  it('orders exactly as the SQL definition, for every sort, direction and filter (#114)', () => {
    // The people list order, as one SQL query (what listPeople computed before #114).
    const oracle = (
      store: TreeStore,
      sort: 'surname' | 'given' | 'birth' | 'death',
      dir: 'ASC' | 'DESC',
      where: string,
    ): string[] => {
      const types = sort === 'birth' ? BIRTH_TYPES : DEATH_TYPES;
      const vital = `LEFT JOIN (SELECT r.person_id, min(e.date_sort) AS k FROM event_role r
        JOIN event e ON e.id = r.event_id
        WHERE r.role = 'principal' AND e.type IN (${types.map((t) => `'${t}'`).join(', ')})
          AND e.date_sort IS NOT NULL GROUP BY r.person_id) v ON v.person_id = p.id`;
      const key = {
        surname: `n.surname IS NULL, n.surname COLLATE NOCASE ${dir}, n.given COLLATE NOCASE ${dir}`,
        given: `n.given IS NULL, n.given COLLATE NOCASE ${dir}, n.surname COLLATE NOCASE ${dir}`,
        birth: `v.k IS NULL, v.k ${dir}`,
        death: `v.k IS NULL, v.k ${dir}`,
      }[sort];
      return store.db
        .prepare(
          `SELECT p.id FROM person p LEFT JOIN person_name n ON n.person_id = p.id AND n.is_primary = 1
           ${vital} ${where} ORDER BY ${key}, p.id`,
        )
        .pluck()
        .all() as string[];
    };
    const store = memoryTree();
    bulkInsert(store, generateSyntheticTree({ people: 1500, seed: 11 }));
    // Ties and edge cases the generator rarely makes: case-only differences, missing
    // names and parts, equal dates, several birth events, non-principal roles.
    store.transact('edges', (tx) => {
      const add = (given: string | null, surname: string | null, born?: number) => {
        const p = persons.create(tx, { sex: 'F' });
        if (given !== null || surname !== null) {
          names.create(tx, { person_id: p.id, given, surname, is_primary: 1 });
        }
        if (born)
          events.create(tx, { type: 'BIRT', date_sort: born, roles: [{ person_id: p.id }] });
        return p;
      };
      add('ada', 'vale', 18500101);
      add('Ada', 'Vale', 18500101);
      add('ADA', 'vale', 18500101);
      add(null, 'Vale');
      add('Zed', null, 19000101);
      add(null, null);
      add('Émile', 'Ørsted', 17990101);
      const twice = add('Twice', 'Born', 19100101);
      events.create(tx, { type: 'CHR', date_sort: 19090101, roles: [{ person_id: twice.id }] });
      const witness = add('Wit', 'Ness');
      events.create(tx, {
        type: 'BIRT',
        date_sort: 16000101,
        roles: [{ person_id: witness.id, role: 'witness' }],
      });
      persons.create(tx, {});
    });
    const { result: tagId } = store.transact('tag', (tx) => {
      const t = tags.create(tx, { name: 'Line' });
      for (const id of listPeople(store, { limit: 40 }).items.map((p) => p.id)) {
        tagLinks.create(tx, { tag_id: t.id, owner_type: 'person', owner_id: id });
      }
      return t.id;
    });
    const filters: [ListPeopleOptions, string][] = [
      [{}, ''],
      [{ sex: 'M' }, "WHERE p.sex = 'M'"],
      [{ living: ['dead', 'inferred_dead'] }, "WHERE p.living IN ('dead', 'inferred_dead')"],
      [
        { tagId },
        `WHERE EXISTS (SELECT 1 FROM tag_link t WHERE t.tag_id = '${tagId}' AND t.owner_type = 'person' AND t.owner_id = p.id)`,
      ],
    ];
    for (const sort of ['surname', 'given', 'birth', 'death'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        for (const [options, where] of filters) {
          const label = JSON.stringify({ sort, direction, ...options });
          const all = listPeople(store, { sort, direction, ...options, limit: 100_000 });
          expect(
            all.items.map((p) => p.id),
            label,
          ).toEqual(oracle(store, sort, direction === 'asc' ? 'ASC' : 'DESC', where));
        }
      }
    }
    store.close();
  });

  it('reflects edits, undo and other connections between pages', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    const order = () => listPeople(store, { sort: 'given' }).items.map((p) => p.given);
    expect(order()[0]).toBe('Briony');
    const nameId = names.list(store, f.kid)[0]!.id;
    store.transact('rename', (tx) => names.update(tx, nameId, { given: 'Aster' }));
    expect(order()[0]).toBe('Aster');
    undoLast(store);
    expect(order()[0]).toBe('Briony');
    store.transact('birth', (tx) =>
      events.create(tx, { type: 'BIRT', date_sort: 10000101, roles: [{ person_id: f.kid }] }),
    );
    expect(listPeople(store, { sort: 'birth', limit: 1 }).items[0]?.given).toBe('Quill');
    store.close();
  });

  it('sees writes made through another connection to the same tree', () => {
    const dir = join(makeTempDir('oa-list-'), 'a.oatree');
    const store = createTree(dir);
    seedSmallFamily(store);
    expect(listPeople(store, { sort: 'given' }).total).toBe(9);
    const other = openTree(dir);
    other.transact('add', (tx) => persons.create(tx, { names: [{ given: 'Aaron' }] }));
    other.close();
    const after = listPeople(store, { sort: 'given' });
    expect(after.total).toBe(10);
    expect(after.items[0]?.given).toBe('Aaron');
    store.close();
  });

  it('does not cache an order read inside a transaction that rolls back', () => {
    const store = memoryTree();
    seedSmallFamily(store);
    expect(listPeople(store).total).toBe(9);
    store.db.exec('BEGIN');
    store.db
      .prepare("INSERT INTO person (id, created_at, updated_at) VALUES ('01TEMP', 'x', 'x')")
      .run();
    expect(listPeople(store).total).toBe(10);
    store.db.exec('ROLLBACK');
    expect(listPeople(store).total).toBe(9);
    store.close();
  });
});
