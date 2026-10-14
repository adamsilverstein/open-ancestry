import { describe, expect, it } from 'vitest';
import {
  citationLinks,
  citations,
  events,
  families,
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
} from './index';
import { memoryTree, seedSmallFamily } from './test/helpers';

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
});
