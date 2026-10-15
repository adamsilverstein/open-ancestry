import { describe, expect, it } from 'vitest';
import {
  NotFoundError,
  citationLinks,
  citations,
  eventRoles,
  events,
  families,
  familyChildren,
  media,
  mediaLinks,
  meta,
  names,
  noteLinks,
  notes,
  persons,
  places,
  repositories,
  sources,
  tagLinks,
  tags,
  type ChangeLogRow,
  type TreeStore,
} from './index';
import { memoryTree, seedSmallFamily } from './test/helpers';

function log(store: TreeStore, batchId: string): ChangeLogRow[] {
  return store.db
    .prepare('SELECT * FROM change_log WHERE batch_id = ? ORDER BY seq')
    .all(batchId) as ChangeLogRow[];
}

function count(store: TreeStore, table: string): number {
  return (store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('unit of work', () => {
  it('records every write in change_log under one batch', () => {
    const store = memoryTree();
    const { batchId, result: person } = store.transact('Add Hazel', (tx) =>
      persons.create(tx, { sex: 'F', names: [{ given: 'Hazel', surname: 'Moor' }] }),
    );
    const rows = log(store, batchId);
    expect(rows.map((r) => [r.entity, r.op])).toEqual([
      ['person', 'insert'],
      ['person_name', 'insert'],
    ]);
    expect(rows[0]?.entity_id).toBe(person.id);
    expect(rows[0]?.before_json).toBeNull();
    expect(JSON.parse(rows[0]?.after_json ?? '')).toEqual(persons.get(store, person.id));
    const batch = store.db.prepare('SELECT * FROM change_batch WHERE id = ?').get(batchId);
    expect(batch).toMatchObject({ label: 'Add Hazel', state: 'applied' });
    store.close();
  });

  it('logs before and after images for updates and deletes', () => {
    const store = memoryTree();
    const { result: p } = store.transact('add', (tx) => persons.create(tx, { sex: 'U' }));
    const { batchId: upd } = store.transact('edit', (tx) => persons.update(tx, p.id, { sex: 'M' }));
    const [u] = log(store, upd);
    expect(u?.op).toBe('update');
    expect(JSON.parse(u?.before_json ?? '').sex).toBe('U');
    expect(JSON.parse(u?.after_json ?? '').sex).toBe('M');
    expect(JSON.parse(u?.after_json ?? '').updated_at).not.toBe(
      JSON.parse(u?.before_json ?? '').updated_at,
    );
    const { batchId: del } = store.transact('delete', (tx) => persons.delete(tx, p.id));
    const [d] = log(store, del);
    expect(d?.op).toBe('delete');
    expect(d?.after_json).toBeNull();
    store.close();
  });

  it('rolls back everything, including the log, when the callback throws', () => {
    const store = memoryTree();
    expect(() =>
      store.transact('boom', (tx) => {
        persons.create(tx, {});
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(count(store, 'person')).toBe(0);
    expect(count(store, 'change_log')).toBe(0);
    expect(count(store, 'change_batch')).toBe(0);
    store.close();
  });

  it('drops batches that change nothing', () => {
    const store = memoryTree();
    const { batchId } = store.transact('noop', () => 1);
    expect(
      store.db.prepare('SELECT * FROM change_batch WHERE id = ?').get(batchId),
    ).toBeUndefined();
    store.close();
  });

  it('does not allow nested transactions', () => {
    const store = memoryTree();
    expect(() => store.transact('outer', () => store.transact('inner', () => 1))).toThrow(/nested/);
    store.close();
  });

  it('throws NotFoundError for missing rows', () => {
    const store = memoryTree();
    expect(() => store.transact('x', (tx) => persons.update(tx, 'missing', { sex: 'M' }))).toThrow(
      NotFoundError,
    );
    expect(() => store.transact('x', (tx) => persons.delete(tx, 'missing'))).toThrow(NotFoundError);
    expect(() => store.transact('x', (tx) => tx.delete('place', 'missing'))).toThrow(NotFoundError);
    store.close();
  });

  it('ignores undefined patch fields and leaves updated_at alone on no-op updates', () => {
    const store = memoryTree();
    const { result: p } = store.transact('add', (tx) => persons.create(tx, { sex: 'F' }));
    const { batchId, result } = store.transact('noop', (tx) =>
      persons.update(tx, p.id, { sex: undefined }),
    );
    expect(result).toEqual(p);
    expect(log(store, batchId)).toEqual([]);
    store.close();
  });
});

describe('write allowlists', () => {
  // Untyped (JS or JSON-driven) callers can pass any string; only schema
  // tables and columns may ever reach dynamically built SQL.
  const evil = "sex = 'M' WHERE 1 = 1; DROP TABLE person; --";

  it('refuses tables outside the data model', () => {
    const store = memoryTree();
    const { result: p } = store.transact('add', (tx) => persons.create(tx, {}));
    for (const table of [
      'sqlite_schema',
      'change_log',
      'change_batch',
      'search_doc',
      `person; ${evil}`,
    ]) {
      expect(() => store.transact('x', (tx) => tx.insert(table as 'person', {}))).toThrow(
        /not allowed/,
      );
      expect(() => store.transact('x', (tx) => tx.update(table as 'person', p.id, {}))).toThrow(
        /not allowed/,
      );
      expect(() => store.transact('x', (tx) => tx.delete(table as 'person', p.id))).toThrow(
        /not allowed/,
      );
      expect(() => store.getRow(table as 'person', p.id)).toThrow(/not allowed/);
    }
    expect(count(store, 'person')).toBe(1);
    store.close();
  });

  it('refuses unknown columns and key changes', () => {
    const store = memoryTree();
    const { result: p } = store.transact('add', (tx) => persons.create(tx, {}));
    const { result: q } = store.transact('add', (tx) => persons.create(tx, {}));
    const before = store.db.prepare('SELECT * FROM person ORDER BY id').all();
    expect(() =>
      store.transact('x', (tx) => tx.insert('person', { [evil]: 'M' } as never)),
    ).toThrow(/Unknown column/);
    expect(() =>
      store.transact('x', (tx) => tx.update('person', p.id, { [evil]: 'M' } as never)),
    ).toThrow(/Unknown column/);
    // Re-keying would redirect the write onto another row.
    expect(() =>
      store.transact('x', (tx) => tx.update('person', p.id, { id: q.id } as never)),
    ).toThrow(/key/);
    expect(store.db.prepare('SELECT * FROM person ORDER BY id').all()).toEqual(before);
    expect(count(store, 'change_log')).toBe(2);
    store.close();
  });
});

describe('persons and names', () => {
  it('makes the first name primary and orders names', () => {
    const store = memoryTree();
    const { result: p } = store.transact('add', (tx) =>
      persons.create(tx, {
        names: [
          { given: 'Greer', surname: 'Ashby' },
          { given: 'Greer', surname: 'Thorn', type: 'married' },
        ],
      }),
    );
    const list = names.list(store, p.id);
    expect(list.map((n) => [n.surname, n.is_primary, n.sort_order])).toEqual([
      ['Ashby', 1, 0],
      ['Thorn', 0, 1],
    ]);
    store.close();
  });

  it('adds, updates, re-primaries and deletes names', () => {
    const store = memoryTree();
    const { result: p } = store.transact('add', (tx) => persons.create(tx, {}));
    const { result: first } = store.transact('n1', (tx) =>
      names.add(tx, p.id, { given: 'Fern', surname: 'Oakes' }),
    );
    expect(first.is_primary).toBe(1);
    const { result: second } = store.transact('n2', (tx) =>
      names.add(tx, p.id, { given: 'Fern', surname: 'Lyle', type: 'married' }),
    );
    expect(second).toMatchObject({ is_primary: 0, sort_order: 1 });
    store.transact('primary', (tx) => names.setPrimary(tx, second.id));
    expect(names.list(store, p.id).map((n) => [n.surname, n.is_primary])).toEqual([
      ['Lyle', 1],
      ['Oakes', 0],
    ]);
    store.transact('edit', (tx) => names.update(tx, first.id, { nickname: 'Ferny' }));
    expect(names.get(store, first.id)?.nickname).toBe('Ferny');
    // Deleting the primary name promotes the next one.
    store.transact('del', (tx) => names.delete(tx, second.id));
    expect(names.list(store, p.id).map((n) => [n.surname, n.is_primary])).toEqual([['Oakes', 1]]);
    store.close();
  });

  it('deletes a person with everything that only belonged to them', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    const { result: extra } = store.transact('extras', (tx) => {
      const note = notes.create(tx, { text: 'Kept a forge.' });
      noteLinks.create(tx, { note_id: note.id, owner_type: 'person', owner_id: f.me });
      const tag = tags.create(tx, { name: 'Research', category: 'Status' });
      tagLinks.create(tx, { tag_id: tag.id, owner_type: 'person', owner_id: f.me });
      const pic = media.create(tx, { title: 'Portrait', remote_url: 'https://example.invalid/p' });
      mediaLinks.create(tx, { media_id: pic.id, owner_type: 'person', owner_id: f.me });
      persons.update(tx, f.me, { primary_media_id: pic.id });
      meta.setHomePerson(tx, f.me);
      const shared = events.create(tx, {
        type: 'CENS',
        roles: [{ person_id: f.me }, { person_id: f.sister }],
      });
      return { note, tag, pic, shared };
    });
    store.transact('delete me', (tx) => persons.delete(tx, f.me));
    expect(persons.get(store, f.me)).toBeUndefined();
    expect(names.list(store, f.me)).toEqual([]);
    // Shared census survives with the sister's role; my birth is gone.
    expect(eventRoles.listForEvent(store, extra.shared.id).map((r) => r.person_id)).toEqual([
      f.sister,
    ]);
    expect(count(store, 'event')).toBe(9); // 9 births + census - mine
    // Links owned by me are gone, and so are the note and photo only I had (#226);
    // the tag is shared vocabulary and stays.
    expect(noteLinks.listFor(store, 'person', f.me)).toEqual([]);
    expect(tagLinks.listFor(store, 'person', f.me)).toEqual([]);
    expect(mediaLinks.listFor(store, 'person', f.me)).toEqual([]);
    expect(notes.get(store, extra.note.id)).toBeUndefined();
    expect(media.get(store, extra.pic.id)).toBeUndefined();
    expect(tags.get(store, extra.tag.id)).toBeDefined();
    // My family keeps my spouse and child, my parents' family drops me as a child.
    expect(families.get(store, f.myFamily)).toMatchObject({
      partner1_id: null,
      partner2_id: f.spouse,
    });
    expect(familyChildren.listForFamily(store, f.parentsFamily).map((c) => c.child_id)).toEqual([
      f.sister,
    ]);
    expect(meta.getHomePersonId(store)).toBeNull();
    store.close();
  });

  it('deletes families left with no members when a person is deleted', () => {
    const store = memoryTree();
    const { result } = store.transact('add', (tx) => {
      const a = persons.create(tx, {});
      const fam = families.create(tx, { partner1_id: a.id, relationship_type: 'married' });
      events.create(tx, { type: 'MARR', roles: [{ family_id: fam.id }] });
      return { a, fam };
    });
    store.transact('del', (tx) => persons.delete(tx, result.a.id));
    expect(families.get(store, result.fam.id)).toBeUndefined();
    expect(count(store, 'event')).toBe(0);
    store.close();
  });
});

describe('events', () => {
  it('creates events with roles and updates them', () => {
    const store = memoryTree();
    const { result } = store.transact('add', (tx) => {
      const p = persons.create(tx, {});
      const w = persons.create(tx, {});
      const place = places.create(tx, { name: 'Wexmoor', full_name: 'Wexmoor' });
      const e = events.create(tx, {
        type: 'BAPM',
        date_text: 'ABT 1850',
        date_qualifier: 'about',
        date_sort: 18500701,
        place_id: place.id,
        roles: [{ person_id: p.id }, { person_id: w.id, role: 'witness' }],
      });
      return { p, w, e };
    });
    expect(eventRoles.listForEvent(store, result.e.id).map((r) => r.role)).toEqual([
      'principal',
      'witness',
    ]);
    store.transact('edit', (tx) => events.update(tx, result.e.id, { date_text: '1851' }));
    expect(events.get(store, result.e.id)?.date_text).toBe('1851');
    const { result: role } = store.transact('role', (tx) =>
      eventRoles.create(tx, { event_id: result.e.id, person_id: result.w.id, role: 'godparent' }),
    );
    store.transact('role edit', (tx) => eventRoles.update(tx, role.id, { is_preferred: 0 }));
    store.transact('role del', (tx) => eventRoles.delete(tx, role.id));
    expect(eventRoles.listForPerson(store, result.w.id).map((r) => r.role)).toEqual(['witness']);
    store.transact('del', (tx) => events.delete(tx, result.e.id));
    expect(count(store, 'event_role')).toBe(0);
    store.close();
  });
});

describe('families', () => {
  it('adds, edits and removes children', () => {
    const store = memoryTree();
    const f = seedSmallFamily(store);
    const { result: link } = store.transact('add child', (tx) =>
      familyChildren.create(tx, {
        family_id: f.myFamily,
        child_id: f.grandkid,
        partner1_rel: 'step',
        partner2_rel: 'step',
      }),
    );
    expect(familyChildren.listForChild(store, f.grandkid)).toHaveLength(2);
    store.transact('edit', (tx) => familyChildren.update(tx, link.id, { partner2_rel: 'adopted' }));
    expect(familyChildren.get(store, link.id)?.partner2_rel).toBe('adopted');
    store.transact('remove', (tx) => familyChildren.delete(tx, link.id));
    expect(familyChildren.listForChild(store, f.grandkid)).toHaveLength(1);
    store.transact('edit fam', (tx) =>
      families.update(tx, f.myFamily, { relationship_type: 'partners' }),
    );
    expect(families.listForPartner(store, f.me).map((x) => x.relationship_type)).toEqual([
      'partners',
    ]);
    store.transact('del fam', (tx) => families.delete(tx, f.myFamily));
    expect(familyChildren.listForChild(store, f.kid)).toEqual([]);
    expect(persons.get(store, f.kid)).toBeDefined();
    store.close();
  });
});

describe('parent families of a child', () => {
  it('orders parent sets and keeps exactly one preferred', () => {
    const store = memoryTree();
    const { result: r } = store.transact('add', (tx) => {
      const [a, b, c, d, kid] = [1, 2, 3, 4, 5].map(() => persons.create(tx, {}).id) as [
        string,
        string,
        string,
        string,
        string,
      ];
      const birth = families.create(tx, {
        partner1_id: a,
        partner2_id: b,
        children: [{ child_id: kid }],
      });
      const adoptive = families.create(tx, {
        partner1_id: c,
        partner2_id: d,
        children: [{ child_id: kid, partner1_rel: 'adopted', partner2_rel: 'adopted' }],
      });
      return { kid, birth, adoptive };
    });
    const links = () =>
      familyChildren
        .listForChild(store, r.kid)
        .map((l) => [l.family_id, l.child_order, l.is_preferred]);
    expect(links()).toEqual([
      [r.birth.id, 0, 1],
      [r.adoptive.id, 1, 0],
    ]);
    const adoptiveLink = familyChildren.listForChild(store, r.kid)[1]?.id as string;
    store.transact('prefer', (tx) => familyChildren.setPreferred(tx, adoptiveLink));
    expect(links()).toEqual([
      [r.birth.id, 0, 0],
      [r.adoptive.id, 1, 1],
    ]);
    const birthLink = familyChildren.listForChild(store, r.kid)[0]?.id as string;
    store.transact('prefer via update', (tx) =>
      familyChildren.update(tx, birthLink, { is_preferred: 1, sort_order: 2 }),
    );
    expect(links()).toEqual([
      [r.birth.id, 0, 1],
      [r.adoptive.id, 1, 0],
    ]);
    // Removing the preferred set promotes the next one.
    store.transact('remove', (tx) => familyChildren.delete(tx, birthLink));
    expect(links()).toEqual([[r.adoptive.id, 1, 1]]);
    expect(() => store.transact('x', (tx) => familyChildren.setPreferred(tx, 'missing'))).toThrow(
      NotFoundError,
    );
    store.close();
  });

  it('enforces one preferred parent family per child', () => {
    const store = memoryTree();
    expect(() =>
      store.transact('two', (tx) => {
        const kid = persons.create(tx, {}).id;
        for (let i = 0; i < 2; i++) {
          const fam = families.create(tx, {});
          tx.insert('family_child', { family_id: fam.id, child_id: kid, is_preferred: 1 });
        }
      }),
    ).toThrow(/UNIQUE/);
    store.close();
  });
});

describe('places, sources, citations, media, notes, tags', () => {
  it('supports CRUD with reference cleanup', () => {
    const store = memoryTree();
    const { result: r } = store.transact('add', (tx) => {
      const country = places.create(tx, { name: 'Wexmoor', full_name: 'Wexmoor', type: 'country' });
      const town = places.create(tx, {
        name: 'Brackenford',
        full_name: 'Brackenford, Wexmoor',
        parent_id: country.id,
        latitude: 51.5,
        longitude: -1.25,
      });
      const p = persons.create(tx, {});
      const e = events.create(tx, {
        type: 'RESI',
        place_id: town.id,
        roles: [{ person_id: p.id }],
      });
      const repo = repositories.create(tx, { name: 'Wexmoor Archive' });
      const src = sources.create(tx, { title: 'Parish Register', repository_id: repo.id });
      const cit = citations.create(tx, { source_id: src.id, page: 'p. 12', apid: '1,7602::123' });
      citationLinks.create(tx, { citation_id: cit.id, owner_type: 'event', owner_id: e.id });
      const pic = media.create(tx, { kind: 'document', title: 'Register page' });
      mediaLinks.create(tx, { media_id: pic.id, owner_type: 'citation', owner_id: cit.id });
      const tag = tags.create(tx, { name: 'Verified', color: '#2a7' });
      tagLinks.create(tx, { tag_id: tag.id, owner_type: 'person', owner_id: p.id });
      return { country, town, p, e, repo, src, cit, pic, tag };
    });
    expect(places.get(store, r.town.id)?.latitude).toBe(51.5);
    store.transact('rename', (tx) => places.update(tx, r.town.id, { name: 'Brackenford Parva' }));
    expect(places.get(store, r.town.id)?.name).toBe('Brackenford Parva');
    expect(citationLinks.listFor(store, 'event', r.e.id)).toHaveLength(1);

    store.transact('del country', (tx) => places.delete(tx, r.country.id));
    expect(places.get(store, r.town.id)?.parent_id).toBeNull();
    store.transact('del town', (tx) => places.delete(tx, r.town.id));
    expect(events.get(store, r.e.id)?.place_id).toBeNull();

    store.transact('del repo', (tx) => repositories.delete(tx, r.repo.id));
    expect(sources.get(store, r.src.id)?.repository_id).toBeNull();
    store.transact('del media', (tx) => media.delete(tx, r.pic.id));
    expect(count(store, 'media_link')).toBe(0);
    store.transact('del source', (tx) => sources.delete(tx, r.src.id));
    expect(citations.get(store, r.cit.id)).toBeUndefined();
    expect(count(store, 'citation_link')).toBe(0);
    store.transact('del tag', (tx) => tags.delete(tx, r.tag.id));
    expect(count(store, 'tag_link')).toBe(0);
    store.close();
  });

  it('clears a primary photo when its media is deleted', () => {
    const store = memoryTree();
    const { result } = store.transact('add', (tx) => {
      const pic = media.create(tx, { title: 'p' });
      const p = persons.create(tx, { primary_media_id: pic.id });
      return { pic, p };
    });
    store.transact('del', (tx) => media.delete(tx, result.pic.id));
    expect(persons.get(store, result.p.id)?.primary_media_id).toBeNull();
    store.close();
  });

  it('deletes notes with their links and citations with theirs', () => {
    const store = memoryTree();
    const { result } = store.transact('add', (tx) => {
      const p = persons.create(tx, {});
      const n = notes.create(tx, { text: 'x' });
      noteLinks.create(tx, { note_id: n.id, owner_type: 'person', owner_id: p.id });
      const s = sources.create(tx, { title: 's' });
      const c = citations.create(tx, { source_id: s.id });
      citationLinks.create(tx, { citation_id: c.id, owner_type: 'person', owner_id: p.id });
      return { n, c };
    });
    store.transact('del', (tx) => {
      notes.delete(tx, result.n.id);
      citations.delete(tx, result.c.id);
    });
    expect(count(store, 'note_link') + count(store, 'citation_link')).toBe(0);
    store.close();
  });
});

describe('meta', () => {
  it('stores settings and protects schema_version', () => {
    const store = memoryTree();
    store.transact('name', (tx) => meta.set(tx, 'tree_name', 'Renamed'));
    expect(meta.get(store, 'tree_name')).toBe('Renamed');
    store.transact('unset', (tx) => meta.delete(tx, 'tree_name'));
    expect(meta.get(store, 'tree_name')).toBeUndefined();
    expect(() => store.transact('x', (tx) => meta.set(tx, 'schema_version', '99'))).toThrow(
      /schema_version/,
    );
    expect(() => store.transact('x', (tx) => meta.delete(tx, 'schema_version'))).toThrow(
      /schema_version/,
    );
    expect(() => store.transact('x', (tx) => meta.setHomePerson(tx, 'missing'))).toThrow(
      NotFoundError,
    );
    store.close();
  });
});
