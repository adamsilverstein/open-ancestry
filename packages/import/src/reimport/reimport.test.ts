import { openMemoryTree, undoLast, type TreeStore } from '@open-ancestry/db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { importGedcom } from '../import';
import { FIXTURES, TODAY, pid, row, rows, value } from '../test-helpers';
import {
  HIGH_CONFIDENCE,
  ReimportStaleError,
  applyReimport,
  closeReimport,
  jaroWinkler,
  prepareReimport,
  type PersonReview,
  type ReimportSession,
  type ReviewChange,
} from './index';

const SAMPLE = readFileSync(join(FIXTURES, 'ancestry-sample.ged'), 'utf8').replace(/^\uFEFF/, '');

/** Ancestry renumbers every xref between exports. */
export function renumber(text: string, offset = 100): string {
  return text.replace(
    /@([A-Z]+)(\d+)@/g,
    (_, prefix: string, n: string) => `@${prefix}${Number(n) + offset}@`,
  );
}

/** Replaces the lines of one record (by xref) with `lines`, or removes it. */
function replaceRecord(text: string, xref: string, lines: string[] | null): string {
  const all = text.split('\n');
  const start = all.findIndex((l) => l.startsWith(`0 ${xref} `));
  let end = start + 1;
  while (end < all.length && !all[end]!.startsWith('0 ')) end++;
  all.splice(start, end - start, ...(lines ?? []));
  return all.join('\n');
}

const recordOf = (text: string, xref: string) => {
  const all = text.split('\n');
  const start = all.findIndex((l) => l.startsWith(`0 ${xref} `));
  let end = start + 1;
  while (end < all.length && !all[end]!.startsWith('0 ')) end++;
  return all.slice(start, end);
};

/**
 * The sample as a later export: renumbered, with Thaddeus's birth refined and a
 * residence added, Josiah's death year changed, a new grandchild, Lily gone,
 * a tag for Mabel and a nickname for Peter.
 */
export function updatedSample(): string {
  let text = SAMPLE;
  text = replaceRecord(
    text,
    '@I1@',
    recordOf(text, '@I1@').flatMap((l) =>
      l === '2 DATE Abt. 1842'
        ? ['2 DATE 12 MAR 1842']
        : l === '1 OCCU Cooper'
          ? [
              l,
              '1 RESI',
              '2 DATE 1900',
              '2 PLAC Millbrook, Harlow County, Vermont, USA',
              '2 SOUR @S1@',
              '3 PAGE Year: 1900; Census Place: Millbrook',
              '3 _APID 1,7602::50000999',
            ]
          : [l],
    ),
  );
  text = replaceRecord(
    text,
    '@I3@',
    recordOf(text, '@I3@').map((l) => (l === '2 DATE 1939' ? '2 DATE 1940' : l)),
  );
  text = replaceRecord(text, '@I11@', [...recordOf(text, '@I11@'), '1 _MTTAG @T1@']);
  text = replaceRecord(text, '@I21@', [
    ...recordOf(text, '@I21@').slice(0, 4),
    '1 NAME Pete /Ashgrove/',
    '2 TYPE aka',
    ...recordOf(text, '@I21@').slice(4),
  ]);
  text = replaceRecord(text, '@I26@', null);
  text = replaceRecord(
    text,
    '@F10@',
    recordOf(text, '@F10@').filter((l) => l !== '1 CHIL @I26@'),
  );
  text = replaceRecord(text, '@F9@', [...recordOf(text, '@F9@'), '1 CHIL @I27@']);
  text = text.replace(
    '0 @F1@ FAM',
    [
      '0 @I27@ INDI',
      '1 NAME Noah /Ashgrove/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1992',
      '1 FAMC @F9@',
      '0 @F1@ FAM',
    ].join('\n'),
  );
  return renumber(text);
}

let store: TreeStore;
let session: ReimportSession | undefined;

beforeEach(async () => {
  if (session) closeReimport(session);
  session = undefined;
  store = openMemoryTree();
  await importGedcom({ bytes: SAMPLE }, store, { today: TODAY });
});

const person = (review: PersonReview[], name: string) => review.find((p) => p.name === name);
const kinds = (p: PersonReview | undefined) => p?.changes.map((c) => c.kind).sort();
const defaults = (s: ReimportSession) =>
  new Set(
    s.diff.people
      .flatMap((p) => p.changes)
      .filter((c) => c.defaultAccept)
      .map((c) => c.id),
  );

describe('matching', () => {
  it('scores string similarity', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3);
    expect(jaroWinkler('', 'a')).toBe(0);
    expect(jaroWinkler('same', 'same')).toBe(1);
  });

  it('matches every person of a renumbered, unchanged export with high confidence', async () => {
    session = await prepareReimport(store, { bytes: renumber(SAMPLE) }, { today: TODAY });
    expect(session.matches.size).toBe(26);
    for (const m of session.matches.values()) {
      const existing = row<{ external_id: string }>(
        store,
        'SELECT external_id FROM person WHERE id = ?',
        m.existingId,
      )!;
      const incoming = row<{ external_id: string }>(
        session.incoming,
        'SELECT external_id FROM person WHERE id = ?',
        m.incomingId,
      )!;
      expect(incoming.external_id).toBe(
        existing.external_id.replace(/\d+/, (n) => String(Number(n) + 100)),
      );
      expect(m.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE);
    }
    expect(session.diff.counts).toMatchObject({
      changedPeople: 0,
      newPeople: 0,
      missingPeople: 0,
      changes: 0,
    });
  });

  it('tells apart two people with the same name by dates and relatives', async () => {
    const twin = [
      '0 @I90@ INDI',
      '1 NAME Walter /Ashgrove/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1950',
      '0 TRLR',
    ].join('\n');
    session = await prepareReimport(
      store,
      { bytes: renumber(SAMPLE).replace('0 TRLR', twin) },
      { today: TODAY },
    );
    const walter = [...session.matches.values()].find((m) => m.existingId === pid(store, '@I9@'))!;
    expect(
      row(session.incoming, 'SELECT external_id FROM person WHERE id = ?', walter.incomingId),
    ).toEqual({
      external_id: '@I109@',
    });
    expect(
      session.diff.people.filter((p) => p.name === 'Walter Ashgrove').map((p) => p.status),
    ).toEqual(['new']);
    expect(session.diff.people.find((p) => p.status === 'new')?.lifespan).toBe('1950–');
  });
});

describe('after people were merged in the tree (#70)', () => {
  /** The sample with a duplicate of Thaddeus, as Ancestry trees often have. */
  const withDuplicate = SAMPLE.replace(
    '0 @I2@ INDI',
    [
      '0 @I30@ INDI',
      '1 NAME Thaddeus /Ashgrove/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE Abt. 1842',
      '2 PLAC Hollin Cross, Westmarch, England',
      '0 @I2@ INDI',
    ].join('\n'),
  );

  /** What #70's merge leaves behind: one person, and both records' raw_record pointing at it. */
  function mergeLocally(tree: TreeStore, keepXref: string, otherXref: string) {
    const keep = pid(tree, keepXref);
    const other = pid(tree, otherXref);
    tree.transact('Merge', (tx) => {
      for (const r of rows<{ id: string }>(
        tree,
        "SELECT id FROM raw_record WHERE owner_type = 'person' AND owner_id = ?",
        other,
      )) {
        tx.update('raw_record', r.id, { owner_id: keep });
      }
      for (const n of rows<{ id: string }>(
        tree,
        'SELECT id FROM person_name WHERE person_id = ?',
        other,
      )) {
        tx.delete('person_name', n.id);
      }
      for (const r of rows<{ id: string; event_id: string }>(
        tree,
        'SELECT id, event_id FROM event_role WHERE person_id = ?',
        other,
      )) {
        tx.delete('event_role', r.id);
        tx.delete('event', r.event_id);
      }
      tx.delete('person', other);
    });
    return keep;
  }

  it('maps both exported duplicates onto the merged person instead of adding one back', async () => {
    const tree = openMemoryTree();
    await importGedcom({ bytes: withDuplicate }, tree, { today: TODAY });
    const keep = mergeLocally(tree, '@I1@', '@I30@');
    const merged = await prepareReimport(
      tree,
      { bytes: renumber(withDuplicate) },
      { today: TODAY },
    );
    try {
      expect(merged.diff.counts).toMatchObject({ newPeople: 0, missingPeople: 0 });
      const onto = [...merged.matches.values()].filter((m) => m.existingId === keep);
      expect(onto).toHaveLength(2);
      expect(onto.every((m) => m.reasons.includes('merged in this tree'))).toBe(true);
      const review = merged.diff.people.find((p) => p.existingId === keep)!;
      expect(review.changes.map((c) => c.kind)).toEqual(['merged']);
      expect(review.changes[0]).toMatchObject({
        applicable: false,
        incomingName: 'Thaddeus Ashgrove',
      });
      const accepted = defaults(merged);
      applyReimport(tree, merged, accepted, 'Re-import');
      expect(value(tree, 'SELECT count(*) FROM person')).toBe(26);
    } finally {
      closeReimport(merged);
      tree.close();
    }
  });

  it('offers what a merged duplicate adds, without its conflicting values', async () => {
    const tree = openMemoryTree();
    await importGedcom({ bytes: withDuplicate }, tree, { today: TODAY });
    const keep = mergeLocally(tree, '@I1@', '@I30@');
    const later = renumber(
      withDuplicate.replace(
        '0 @I30@ INDI\n1 NAME Thaddeus /Ashgrove/\n1 SEX M',
        '0 @I30@ INDI\n1 NAME Thaddeus /Ashgrove/\n1 SEX M\n1 OCCU Barrel maker\n1 DEAT\n2 DATE 1912',
      ),
    );
    const merged = await prepareReimport(tree, { bytes: later }, { today: TODAY });
    try {
      expect(merged.diff.counts.newPeople).toBe(0);
      const review = merged.diff.people.find((p) => p.existingId === keep)!;
      const adds = review.changes.filter((c) => c.kind === 'fact.add') as (ReviewChange & {
        kind: 'fact.add';
      })[];
      expect(adds.map((c) => [c.fact.type, c.defaultAccept])).toEqual([
        ['OCCU', true],
        ['DEAT', false],
      ]);
      expect(review.changes.some((c) => c.kind === 'fact.change')).toBe(false);
    } finally {
      closeReimport(merged);
      tree.close();
    }
  });

  it('still folds a weak duplicate after every xref is renumbered, by moved names and _APIDs', async () => {
    // A weaker duplicate: a nickname, no dates, but a census record (_APID) of its own.
    const weak = SAMPLE.replace(
      '0 @I2@ INDI',
      [
        '0 @I30@ INDI',
        '1 NAME Thad /Ashgrove/',
        '1 SEX M',
        '1 SOUR @S1@',
        '2 PAGE Year: 1880; Millbrook',
        '2 _APID 1,7602::70000001',
        '0 @I2@ INDI',
      ].join('\n'),
    );
    const tree = openMemoryTree();
    await importGedcom({ bytes: weak }, tree, { today: TODAY });
    const other = pid(tree, '@I30@');
    const keep = pid(tree, '@I1@');
    // Like #70: the duplicate's name and citation move to the kept person.
    tree.transact('Merge', (tx) => {
      for (const n of rows<{ id: string }>(
        tree,
        'SELECT id FROM person_name WHERE person_id = ?',
        other,
      )) {
        tx.update('person_name', n.id, { person_id: keep, is_primary: 0, sort_order: 5 });
      }
      for (const l of rows<{ id: string }>(
        tree,
        "SELECT id FROM citation_link WHERE owner_type = 'person' AND owner_id = ?",
        other,
      )) {
        tx.update('citation_link', l.id, { owner_id: keep });
      }
      for (const r of rows<{ id: string }>(
        tree,
        "SELECT id FROM raw_record WHERE owner_type = 'person' AND owner_id = ?",
        other,
      )) {
        tx.update('raw_record', r.id, { owner_id: keep });
      }
      tx.delete('person', other);
    });

    const later = renumber(weak, 500);
    const merged = await prepareReimport(tree, { bytes: later }, { today: TODAY });
    try {
      // Every incoming xref is new: none can be looked up in the last import.
      const oldXrefs = new Set(
        rows<{ xref: string }>(tree, 'SELECT xref FROM raw_record WHERE xref IS NOT NULL').map(
          (r) => r.xref,
        ),
      );
      const incomingXrefs = rows<{ external_id: string }>(
        merged.incoming,
        'SELECT external_id FROM person',
      ).map((r) => r.external_id);
      expect(incomingXrefs.some((x) => oldXrefs.has(x))).toBe(false);

      expect(merged.diff.counts.newPeople).toBe(0);
      const onto = [...merged.matches.values()].filter((m) => m.existingId === keep);
      expect(onto).toHaveLength(2);
      const thad = onto.find((m) =>
        rows<{ given: string }>(
          merged.incoming,
          'SELECT given FROM person_name WHERE person_id = ?',
          m.incomingId,
        ).some((n) => n.given === 'Thad'),
      )!;
      expect(thad.reasons).toContain('1 shared Ancestry record');
      expect(thad.reasons).toContain('merged in this tree');
      applyReimport(tree, merged, defaults(merged), 'Re-import');
      expect(
        value(tree, "SELECT count(*) FROM person_name WHERE given IN ('Thad', 'Thaddeus')"),
      ).toBe(2);
      expect(value(tree, 'SELECT count(*) FROM person')).toBe(26);
    } finally {
      closeReimport(merged);
      tree.close();
    }
  });

  it("uses the previous import's xrefs as a hint when Ancestry keeps them", async () => {
    const same = await prepareReimport(store, { bytes: SAMPLE }, { today: TODAY });
    try {
      for (const m of same.matches.values())
        expect(m.reasons).toContain('same xref as the last import');
    } finally {
      closeReimport(same);
    }
  });
});

describe('diff', () => {
  beforeEach(async () => {
    session = await prepareReimport(store, { bytes: updatedSample() }, { today: TODAY });
  });

  it('lists changed, new and missing people', () => {
    expect(session!.diff.counts).toMatchObject({
      incoming: 26,
      matched: 25,
      newPeople: 1,
      missingPeople: 1,
    });
    const people = session!.diff.people;
    // The residence's citation travels with the new fact.
    expect(kinds(person(people, 'Thaddeus Ashgrove'))).toEqual(['fact.add', 'fact.change']);
    expect(kinds(person(people, 'Josiah Ashgrove'))).toEqual(['fact.change']);
    expect(kinds(person(people, 'Mabel Corran'))).toEqual(['tag.add']);
    expect(kinds(person(people, 'Peter Ashgrove'))).toEqual(['name.add']);
    expect(kinds(person(people, 'Noah Ashgrove'))).toEqual(['child.add', 'person.new']);
    expect(person(people, 'Lily Mosswood')).toMatchObject({ status: 'missing' });
  });

  it('describes each change with before and after', () => {
    const thaddeus = person(session!.diff.people, 'Thaddeus Ashgrove')!;
    const change = thaddeus.changes.find((c) => c.kind === 'fact.change')!;
    expect(change).toMatchObject({
      before: { type: 'BIRT', date: 'Abt. 1842', place: 'Hollin Cross, Westmarch, England' },
      after: { type: 'BIRT', date: '12 MAR 1842', place: 'Hollin Cross, Westmarch, England' },
      defaultAccept: true,
      applicable: true,
    });
    const residence = thaddeus.changes.find((c) => c.kind === 'fact.add')!;
    expect(residence).toMatchObject({ fact: { type: 'RESI', date: '1900' } });
    expect(thaddeus.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE);
    expect(thaddeus.reasons).toContain('same name');
    const noahChild = person(session!.diff.people, 'Noah Ashgrove')!.changes.find(
      (c) => c.kind === 'child.add',
    )!;
    const noahNew = person(session!.diff.people, 'Noah Ashgrove')!.changes.find(
      (c) => c.kind === 'person.new',
    )!;
    expect(noahChild.requires).toEqual([noahNew.id]);
    const lily = person(session!.diff.people, 'Lily Mosswood')!.changes[0]!;
    expect(lily).toMatchObject({ kind: 'person.missing', applicable: false, defaultAccept: false });
  });

  it('flags a fact the user edited since import, and keeps it unless overridden', async () => {
    const death = value<string>(
      store,
      "SELECT e.id FROM event e JOIN event_role r ON r.event_id = e.id WHERE r.person_id = ? AND e.type = 'DEAT'",
      pid(store, '@I3@'),
    );
    store.transact('Edit death', (tx) => tx.update('event', death, { date_text: '3 MAY 1939' }));
    const edited = await prepareReimport(store, { bytes: updatedSample() }, { today: TODAY });
    try {
      const change = person(edited.diff.people, 'Josiah Ashgrove')!.changes[0]!;
      expect(change).toMatchObject({
        kind: 'fact.change',
        conflict: 'local-edit',
        defaultAccept: false,
      });
      applyReimport(store, edited, defaults(edited), 'Re-import');
      expect(value(store, 'SELECT date_text FROM event WHERE id = ?', death)).toBe('3 MAY 1939');
    } finally {
      closeReimport(edited);
    }
  });
});

describe('apply', () => {
  beforeEach(async () => {
    session = await prepareReimport(store, { bytes: updatedSample() }, { today: TODAY });
  });

  let ids: { thaddeus: string; thomas: string; susan: string };
  beforeEach(() => {
    // Ids before apply: a re-import moves external_id to the new export's xrefs.
    ids = { thaddeus: pid(store, '@I1@'), thomas: pid(store, '@I20@'), susan: pid(store, '@I22@') };
  });
  const birth = (id: string) =>
    row<{ date_text: string; date_sort: number }>(
      store,
      "SELECT e.date_text, e.date_sort FROM event e JOIN event_role r ON r.event_id = e.id WHERE r.person_id = ? AND e.type = 'BIRT'",
      id,
    );

  it('applies the accepted changes as one undoable batch', () => {
    const before = value<number>(store, 'SELECT count(*) FROM person');
    const result = applyReimport(store, session!, defaults(session!), 'Re-import updated.ged');
    expect(result.blocked).toEqual([]);
    expect(birth(ids.thaddeus)).toEqual({ date_text: '12 MAR 1842', date_sort: 18420312 });
    const thaddeus = ids.thaddeus;
    expect(pid(store, '@I101@')).toBe(thaddeus);
    expect(
      rows(
        store,
        "SELECT e.type, e.date_text FROM event e JOIN event_role r ON r.event_id = e.id WHERE r.person_id = ? AND e.type = 'RESI'",
        thaddeus,
      ),
    ).toEqual([{ type: 'RESI', date_text: '1900' }]);
    expect(
      rows(
        store,
        "SELECT l.owner_type FROM citation c JOIN citation_link l ON l.citation_id = c.id WHERE c.apid = '1,7602::50000999'",
      ),
    ).toEqual([{ owner_type: 'event' }]);
    expect(value(store, 'SELECT count(*) FROM person')).toBe(before + 1);
    const noah = value<string>(store, "SELECT person_id FROM person_name WHERE given = 'Noah'");
    expect(
      row(
        store,
        'SELECT f.partner1_id, f.partner2_id FROM family_child c JOIN family f ON f.id = c.family_id WHERE c.child_id = ?',
        noah,
      ),
    ).toEqual({ partner1_id: ids.thomas, partner2_id: ids.susan });
    expect(value(store, "SELECT count(*) FROM person_name WHERE given = 'Pete'")).toBe(1);
    expect(
      value(
        store,
        "SELECT count(*) FROM tag_link l JOIN tag t ON t.id = l.tag_id WHERE t.name = 'Research Complete'",
      ),
    ).toBe(2);
    // Lily stays: a person missing from the export is listed, never deleted.
    expect(value(store, "SELECT count(*) FROM person_name WHERE given = 'Lily'")).toBe(1);
    // Shared places and sources are reused, not duplicated.
    expect(
      value(
        store,
        "SELECT count(*) FROM place WHERE full_name = 'Millbrook, Harlow County, Vermont, USA'",
      ),
    ).toBe(1);
    expect(
      value(store, "SELECT count(*) FROM source WHERE title = '1900 United States Federal Census'"),
    ).toBe(1);

    const batch = row<{ label: string }>(
      store,
      'SELECT label FROM change_batch WHERE id = ?',
      result.batchId,
    );
    expect(batch?.label).toBe('Re-import updated.ged');
    undoLast(store);
    expect(birth(ids.thaddeus)).toEqual({ date_text: 'Abt. 1842', date_sort: expect.any(Number) });
    expect(value(store, 'SELECT count(*) FROM person')).toBe(before);
    expect(value(store, "SELECT count(*) FROM person_name WHERE given = 'Pete'")).toBe(0);
    expect(value(store, 'SELECT count(*) FROM import_batch')).toBe(1);
  });

  it('applies only what was accepted, and drops changes whose new person was rejected', () => {
    const noah = person(session!.diff.people, 'Noah Ashgrove')!;
    const accepted = defaults(session!);
    accepted.delete(noah.changes.find((c) => c.kind === 'person.new')!.id);
    const thaddeusBirth = person(session!.diff.people, 'Thaddeus Ashgrove')!.changes.find(
      (c) => c.kind === 'fact.change',
    ) as ReviewChange;
    accepted.delete(thaddeusBirth.id);
    const result = applyReimport(store, session!, accepted, 'Re-import');
    expect(result.blocked).toEqual([noah.changes.find((c) => c.kind === 'child.add')!.id]);
    expect(birth(ids.thaddeus)!.date_text).toBe('Abt. 1842');
    expect(value(store, "SELECT count(*) FROM person_name WHERE given = 'Noah'")).toBe(0);
  });

  it('keeps the new export whole in raw_record under its own import batch', () => {
    applyReimport(store, session!, defaults(session!), 'Re-import');
    const batches = rows<{ id: string }>(
      store,
      'SELECT id FROM import_batch ORDER BY started_at, id',
    );
    expect(batches).toHaveLength(2);
    const text = rows<{ raw_text: string }>(
      store,
      'SELECT raw_text FROM raw_record WHERE import_batch_id = ? ORDER BY seq',
      batches[1]!.id,
    )
      .map((r) => `${r.raw_text}\n`)
      .join('');
    expect(text).toBe(updatedSample());
    // Records point at the rows they became: a matched person keeps its id.
    expect(
      value(
        store,
        "SELECT owner_id FROM raw_record WHERE import_batch_id = ? AND xref = '@I101@'",
        batches[1]!.id,
      ),
    ).toBe(ids.thaddeus);
    expect(value(store, 'SELECT external_id FROM person WHERE id = ?', ids.thaddeus)).toBe(
      '@I101@',
    );
  });

  it('refuses to apply when the tree changed after the review', () => {
    store.transact('Unrelated edit', (tx) => tx.insert('person', {}));
    expect(() => applyReimport(store, session!, defaults(session!), 'Re-import')).toThrow(
      ReimportStaleError,
    );
  });

  it('a second, unchanged re-import finds nothing to do', async () => {
    applyReimport(store, session!, defaults(session!), 'Re-import');
    const again = await prepareReimport(store, { bytes: updatedSample() }, { today: TODAY });
    try {
      expect(again.diff.counts).toMatchObject({ newPeople: 0, changes: 0 });
      // Lily is still missing from the export, and still in the tree.
      expect(again.diff.counts.missingPeople).toBe(1);
    } finally {
      closeReimport(again);
    }
  });
});
