import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seed, testApi, type Seeded, type TestApi } from './test/helpers';

let api: TestApi;
let s: Seeded;
beforeEach(async () => {
  api = await testApi();
  s = await seed(api);
});
afterEach(() => api.close());

const detail = async (id: string) => (await api.get(`${s.base}/people/${id}`)).json();

describe('people', () => {
  it('creates a person with names and parsed, placed events in one batch', async () => {
    const res = await api.post(`${s.base}/people`, {
      sex: 'M',
      living: 'dead',
      names: [
        { given: 'Finn', surname: 'Vale' },
        { given: 'Finny', surname: 'Vail', type: 'aka' },
      ],
      events: [
        { type: 'birt', date_text: 'ABT 1890', place: 'harlow, essex, england' },
        { type: 'DEAT', date_text: 'sometime in the war' },
      ],
    });
    expect(res.statusCode).toBe(201);
    const { batchId, person } = res.json();
    expect(batchId).toEqual(expect.any(String));
    expect(person).toMatchObject({ given: 'Finn', surname: 'Vale', living: 'dead' });
    const d = await detail(person.id);
    expect(d.names).toHaveLength(2);
    expect(d.names[0].surname_key).toContain('V400');
    const birth = d.events.find((e: { event: { type: string } }) => e.event.type === 'BIRT');
    expect(birth.event).toMatchObject({ date_qualifier: 'about', calendar: null });
    expect(birth.event.date_sort).toBeGreaterThan(18900000);
    // Places are reused case-insensitively.
    expect(birth.place.full_name).toBe('Harlow, Essex, England');
    const death = d.events.find((e: { event: { type: string } }) => e.event.type === 'DEAT');
    expect(death.event).toMatchObject({ date_qualifier: 'text', date_sort: null });
  });

  it('validates the body', async () => {
    for (const body of [
      { sex: 'Q' },
      { living: 'maybe' },
      { names: [{ given: 'x', middle: 'y' }] },
      { events: [{ date_text: '1900' }] },
      { events: [{ type: 'BIRT; DROP TABLE' }] },
      { unknown: true },
    ]) {
      const res = await api.post(`${s.base}/people`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('validation_failed');
    }
  });

  it('updates and deletes a person', async () => {
    const res = await api.patch(`${s.base}/people/${s.eve}`, { sex: 'X', privacy: 'private' });
    expect(res.json().person).toMatchObject({ sex: 'X', privacy: 'private' });
    const noop = await api.patch(`${s.base}/people/${s.eve}`, { sex: 'X' });
    expect(noop.json().batchId).toBeNull();
    expect(
      (await api.patch(`${s.base}/people/${s.eve}`, { primary_media_id: '01NOPE' })).statusCode,
    ).toBe(404);
    expect((await api.patch(`${s.base}/people/01NOPE`, { sex: 'M' })).statusCode).toBe(404);

    const del = await api.del(`${s.base}/people/${s.eve}`);
    expect(del.json().batchId).toEqual(expect.any(String));
    expect((await api.get(`${s.base}/people/${s.eve}`)).statusCode).toBe(404);
    expect((await api.del(`${s.base}/people/${s.eve}`)).statusCode).toBe(404);
  });
});

describe('names', () => {
  it('adds, edits, makes primary and deletes names', async () => {
    const added = await api.post(`${s.base}/people/${s.ada}/names`, {
      type: 'married',
      given: 'Ada',
      surname: 'Reed',
    });
    expect(added.statusCode).toBe(201);
    const name = added.json().name;
    expect(name).toMatchObject({ is_primary: 0, surname_key: expect.stringContaining('R300') });

    const edited = await api.patch(`${s.base}/names/${name.id}`, {
      surname: 'Reid',
      is_primary: true,
    });
    expect(edited.json().name).toMatchObject({ surname: 'Reid', is_primary: 1 });
    expect((await api.get(`${s.base}/people/${s.ada}/summary`)).json().surname).toBe('Reid');

    expect((await api.del(`${s.base}/names/${name.id}`)).statusCode).toBe(200);
    expect((await api.get(`${s.base}/people/${s.ada}/summary`)).json().surname).toBe('Vale');
  });

  it('refuses to delete the last name and 404s unknown ones', async () => {
    const [only] = (await detail(s.eve)).names;
    const res = await api.del(`${s.base}/names/${only.id}`);
    expect(res.statusCode).toBe(409);
    expect((await api.patch(`${s.base}/names/01NOPE`, { given: 'x' })).statusCode).toBe(404);
    expect((await api.post(`${s.base}/people/01NOPE/names`, { given: 'x' })).statusCode).toBe(404);
  });
});

describe('events', () => {
  it('adds, edits and deletes person and family events', async () => {
    const added = await api.post(`${s.base}/people/${s.eve}/events`, {
      type: 'OCCU',
      value: 'Weaver',
      date_text: '1990',
    });
    expect(added.statusCode).toBe(201);
    const event = added.json().event;
    expect(event).toMatchObject({ type: 'OCCU', value: 'Weaver', date_sort: expect.any(Number) });

    const edited = await api.patch(`${s.base}/events/${event.id}`, {
      date_text: '@#DJULIAN@ 1700',
      place: 'Leeds',
    });
    expect(edited.json().event).toMatchObject({ calendar: 'julian', place_id: expect.any(String) });
    const cleared = await api.patch(`${s.base}/events/${event.id}`, {
      date_text: null,
      place: null,
    });
    expect(cleared.json().event).toMatchObject({
      date_text: null,
      date_sort: null,
      place_id: null,
    });

    expect((await api.del(`${s.base}/events/${event.id}`)).statusCode).toBe(200);
    expect((await api.patch(`${s.base}/events/${event.id}`, { value: 'x' })).statusCode).toBe(404);

    const marr = await api.post(`${s.base}/families/${s.marriage}/events`, {
      type: 'MARR',
      date_text: '1962',
    });
    expect(marr.statusCode).toBe(201);
    expect((await api.post(`${s.base}/families/01NOPE/events`, { type: 'MARR' })).statusCode).toBe(
      404,
    );
    expect((await api.post(`${s.base}/people/01NOPE/events`, { type: 'BIRT' })).statusCode).toBe(
      404,
    );
  });
});

describe('relationships', () => {
  it('fills the preferred parent family before creating a new one', async () => {
    const d = await detail(s.ada);
    expect(d.parentFamilies).toHaveLength(1);
    // Both parent slots are filled, so a third parent gets a new family.
    const step = await api.post(`${s.base}/people/${s.ada}/parents`, {
      person: { names: [{ given: 'Gus' }] },
      rel: 'step',
    });
    expect(step.statusCode).toBe(201);
    const after = await detail(s.ada);
    expect(after.parentFamilies).toHaveLength(2);
    expect(after.parentFamilies[1].link.partner1_rel).toBe('step');
  });

  it('adds a parent into a given family slot', async () => {
    const child = (
      await api.post(`${s.base}/people/${s.eve}/children`, {
        person: { names: [{ given: 'Hal' }] },
      })
    ).json();
    // Eve's single-parent family has room for a second parent.
    const res = await api.post(`${s.base}/people/${child.childId}/parents`, {
      personId: s.dan,
      familyId: child.family.id,
      rel: 'adopted',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().family).toMatchObject({ partner1_id: s.eve, partner2_id: s.dan });
    expect((await detail(child.childId)).parentFamilies[0].link.partner2_rel).toBe('adopted');
    const full = await api.post(`${s.base}/people/${child.childId}/parents`, {
      personId: s.ada,
      familyId: child.family.id,
    });
    expect(full.statusCode).toBe(409);
    const notParent = await api.post(`${s.base}/people/${s.ada}/parents`, {
      personId: s.dan,
      familyId: s.marriage,
    });
    expect(notParent.statusCode).toBe(400);
  });

  it('validates the relative', async () => {
    const both = await api.post(`${s.base}/people/${s.ada}/spouses`, {
      personId: s.dan,
      person: {},
    });
    expect(both.statusCode).toBe(400);
    expect((await api.post(`${s.base}/people/${s.ada}/spouses`, {})).statusCode).toBe(400);
    expect(
      (await api.post(`${s.base}/people/${s.ada}/spouses`, { personId: s.ada })).statusCode,
    ).toBe(400);
    expect(
      (await api.post(`${s.base}/people/${s.ada}/children`, { personId: '01NOPE' })).statusCode,
    ).toBe(404);
    expect(
      (await api.post(`${s.base}/people/01NOPE/parents`, { personId: s.ada })).statusCode,
    ).toBe(404);
    expect(
      (await api.post(`${s.base}/people/${s.eve}/parents`, { personId: s.eve })).statusCode,
    ).toBe(400);
  });

  it('adds spouses, children and siblings', async () => {
    const spouse = await api.post(`${s.base}/people/${s.dan}/spouses`, {
      person: { names: [{ given: 'Ivy' }] },
      relationship_type: 'partners',
    });
    expect(spouse.json().family).toMatchObject({
      partner1_id: s.dan,
      relationship_type: 'partners',
      partner1_order: 1,
    });

    const child = await api.post(`${s.base}/people/${s.ada}/children`, {
      familyId: s.marriage,
      personId: s.bram,
      partner1_rel: 'adopted',
      partner2_rel: 'step',
    });
    expect(child.json().link).toMatchObject({
      partner1_rel: 'adopted',
      partner2_rel: 'step',
      sort_order: 1,
    });
    expect(
      (await api.post(`${s.base}/people/${s.eve}/children`, { familyId: s.marriage, person: {} }))
        .statusCode,
    ).toBe(400);
    expect(
      (await api.post(`${s.base}/people/${s.eve}/children`, { familyId: '01NOPE', person: {} }))
        .statusCode,
    ).toBe(404);

    const sibling = await api.post(`${s.base}/people/${s.ada}/siblings`, {
      person: { names: [{ given: 'Jon', surname: 'Vale' }] },
    });
    expect(sibling.statusCode).toBe(201);
    const ada = await detail(s.ada);
    expect(
      ada.parentFamilies[0].siblings.map((x: { person: { given: string } }) => x.person.given),
    ).toEqual(['Jon']);

    // Without parents, siblings share a family with no partners.
    const orphan = await api.post(`${s.base}/people/${s.dan}/siblings`, {
      person: { names: [{ given: 'Kit' }] },
    });
    const kit = await detail(orphan.json().siblingId);
    expect(kit.parentFamilies[0]).toMatchObject({ partner1: null, partner2: null });
    expect(kit.parentFamilies[0].siblings[0].person.id).toBe(s.dan);
  });

  it('edits and deletes families and child links', async () => {
    const edited = await api.patch(`${s.base}/families/${s.marriage}`, {
      relationship_type: 'civil_union',
    });
    expect(edited.json().family.relationship_type).toBe('civil_union');
    expect(
      (await api.patch(`${s.base}/families/${s.marriage}`, { partner2_id: s.ada })).statusCode,
    ).toBe(400);
    expect(
      (
        await api.patch(`${s.base}/families/${s.marriage}`, {
          partner1_id: s.dan,
          partner2_id: s.dan,
        })
      ).statusCode,
    ).toBe(400);
    const swapped = await api.patch(`${s.base}/families/${s.marriage}`, {
      partner1_id: s.dan,
      partner2_id: s.ada,
    });
    expect(swapped.json().family).toMatchObject({ partner1_id: s.dan, partner2_id: s.ada });
    expect(
      (await api.patch(`${s.base}/families/${s.marriage}`, { partner2_id: '01NOPE' })).statusCode,
    ).toBe(404);

    const link = (await detail(s.eve)).parentFamilies[0].link;
    const patched = await api.patch(`${s.base}/family-children/${link.id}`, {
      partner1_rel: 'foster',
      is_preferred: true,
    });
    expect(patched.json().link).toMatchObject({ partner1_rel: 'foster', is_preferred: 1 });
    expect(
      (await api.patch(`${s.base}/family-children/${link.id}`, { is_preferred: false })).statusCode,
    ).toBe(400);
    expect((await api.del(`${s.base}/family-children/${link.id}`)).statusCode).toBe(200);
    expect((await detail(s.eve)).parentFamilies).toEqual([]);

    expect((await api.del(`${s.base}/families/${s.marriage}`)).statusCode).toBe(200);
    expect((await api.get(`${s.base}/families/${s.marriage}`)).statusCode).toBe(404);
    expect(
      (await api.patch(`${s.base}/family-children/${link.id}`, { sort_order: 1 })).statusCode,
    ).toBe(404);
  });
});

describe('notes and tags', () => {
  it('adds, edits and deletes notes', async () => {
    const added = await api.post(`${s.base}/notes`, {
      text: 'Kept bees.',
      owner_type: 'person',
      owner_id: s.ada,
    });
    expect(added.statusCode).toBe(201);
    const note = added.json().note;
    expect((await detail(s.ada)).notes.map((n: { text: string }) => n.text)).toEqual([
      'Kept bees.',
    ]);
    expect(
      (await api.patch(`${s.base}/notes/${note.id}`, { text: 'Kept bees and goats.' })).json().note
        .text,
    ).toBe('Kept bees and goats.');
    expect((await api.del(`${s.base}/notes/${note.id}`)).statusCode).toBe(200);
    expect((await detail(s.ada)).notes).toEqual([]);
    expect(
      (await api.post(`${s.base}/notes`, { text: 'x', owner_type: 'person', owner_id: '01NOPE' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api.post(`${s.base}/notes`, { text: 'x', owner_type: 'meta', owner_id: s.ada }))
        .statusCode,
    ).toBe(400);
    expect((await api.patch(`${s.base}/notes/01NOPE`, { text: 'x' })).statusCode).toBe(404);
  });

  it('manages tags and person tag links', async () => {
    const tag = (await api.post(`${s.base}/tags`, { name: 'DNA match' })).json().tag;
    expect(tag.category).toBe('');
    expect((await api.post(`${s.base}/tags`, { name: 'DNA match' })).json().error).toEqual({
      code: 'conflict',
      message: 'A tag with that name already exists',
    });
    expect((await api.post(`${s.base}/tags`, { name: 'x', color: 'red;}' })).statusCode).toBe(400);
    expect(
      (await api.patch(`${s.base}/tags/${tag.id}`, { color: '#00aa00' })).json().tag.color,
    ).toBe('#00aa00');

    expect((await api.post(`${s.base}/people/${s.ada}/tags`, { tagId: tag.id })).statusCode).toBe(
      201,
    );
    // Tagging again or untagging twice changes nothing, so a retried request is harmless.
    const again = await api.post(`${s.base}/people/${s.ada}/tags`, { tagId: tag.id });
    expect(again.statusCode).toBe(201);
    expect(again.json().batchId).toBeNull();
    expect((await detail(s.ada)).tags.map((t: { name: string }) => t.name)).toEqual(['DNA match']);
    expect((await api.del(`${s.base}/people/${s.ada}/tags/${tag.id}`)).statusCode).toBe(200);
    const twice = await api.del(`${s.base}/people/${s.ada}/tags/${tag.id}`);
    expect(twice.statusCode).toBe(200);
    expect(twice.json().batchId).toBeNull();
    expect((await api.del(`${s.base}/people/01NOPE/tags/${tag.id}`)).statusCode).toBe(404);
    expect((await api.post(`${s.base}/people/${s.ada}/tags`, { tagId: '01NOPE' })).statusCode).toBe(
      404,
    );

    expect((await api.del(`${s.base}/tags/${tag.id}`)).statusCode).toBe(200);
    expect((await api.get(`${s.base}/tags`)).json().items).toEqual([]);
    expect((await api.patch(`${s.base}/tags/${tag.id}`, { name: 'y' })).statusCode).toBe(404);
  });
});

describe('undo, redo and history', () => {
  it('undoes and redoes the latest edit', async () => {
    const created = (await api.post(`${s.base}/people`, { names: [{ given: 'Lea' }] })).json();
    const history = (await api.get(`${s.base}/history?limit=2`)).json();
    expect(history.items[0]).toMatchObject({
      id: created.batchId,
      label: 'Add person: Lea',
      state: 'applied',
    });
    expect(history.items).toHaveLength(2);
    expect(history).toMatchObject({ canUndo: true, canRedo: false });

    const undone = await api.post(`${s.base}/undo`);
    expect(undone.json().batch).toMatchObject({ id: created.batchId, state: 'undone' });
    expect((await api.get(`${s.base}/people/${created.person.id}`)).statusCode).toBe(404);
    expect((await api.get(`${s.base}/history`)).json().canRedo).toBe(true);

    const redone = await api.post(`${s.base}/redo`);
    expect(redone.json().batch).toMatchObject({ id: created.batchId, state: 'applied' });
    expect((await api.get(`${s.base}/people/${created.person.id}`)).statusCode).toBe(200);
    expect((await api.post(`${s.base}/redo`)).json().batch).toBeNull();
  });

  it('returns null when there is nothing to undo', async () => {
    const fresh = '/api/trees/Empty';
    await api.post('/api/trees', { name: 'Empty' });
    expect((await api.post(`${fresh}/undo`)).json()).toEqual({ batch: null });
    expect((await api.get(`${fresh}/history`)).json()).toEqual({
      items: [],
      canUndo: false,
      canRedo: false,
    });
  });
});
