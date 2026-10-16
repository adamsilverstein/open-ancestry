import { openMemoryTree, redoLast, undoLast, type TreeStore } from '@open-ancestry/db';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../../../fixtures/temp-dir';
import { importGedcom } from '../import';
import { FIXTURES, TODAY, ged, pid, row, rows, value } from '../test-helpers';
import {
  HIGH_CONFIDENCE,
  ReimportStaleError,
  applyReimport,
  closeReimport,
  isReimportStale,
  jaroWinkler,
  localHistory,
  prepareReimport,
  refreshReimport,
  reimportFromData,
  reimportData,
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
      for (const c of rows<{ id: string }>(
        tree,
        'SELECT id FROM family_child WHERE child_id = ?',
        other,
      )) {
        tx.delete('family_child', c.id);
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

  it('marks an unmatched record that shares a parent with a merged person, unticked', async () => {
    // A duplicate of Josiah recorded under another name, as a child of the same parents.
    const dup = SAMPLE.replace(
      '0 @I2@ INDI',
      ['0 @I30@ INDI', '1 NAME J. /Smythe/', '1 SEX M', '1 FAMC @F1@', '0 @I2@ INDI'].join('\n'),
    ).replace('1 CHIL @I4@', '1 CHIL @I4@\n1 CHIL @I30@');
    const tree = openMemoryTree();
    await importGedcom({ bytes: dup }, tree, { today: TODAY });
    const keep = mergeLocally(tree, '@I3@', '@I30@');
    const merged = await prepareReimport(tree, { bytes: renumber(dup, 500) }, { today: TODAY });
    try {
      const review = merged.diff.people.find((p) => p.name === 'J. Smythe')!;
      expect(review.status).toBe('new');
      expect(review.changes.map((c) => [c.kind, c.defaultAccept])).toEqual([
        ['possibly-merged', false],
        ['person.new', false],
        ['child.add', true],
      ]);
      expect(review.changes[0]).toMatchObject({
        existingId: keep,
        existingName: 'Josiah Ashgrove',
      });
      // Applying the defaults brings nobody back: the child link needs the unticked person.
      const result = applyReimport(tree, merged, defaults(merged), 'Re-import');
      expect(result.blocked).toHaveLength(1);
      expect(value(tree, "SELECT count(*) FROM person_name WHERE surname = 'Smythe'")).toBe(0);
    } finally {
      closeReimport(merged);
      tree.close();
    }
    // Without a merge, the same stranger is an ordinary new person.
    const plain = await prepareReimport(store, { bytes: renumber(dup, 500) }, { today: TODAY });
    try {
      const review = plain.diff.people.find((p) => p.name === 'J. Smythe')!;
      expect(review.changes.map((c) => c.kind)).toEqual(['person.new', 'child.add']);
      expect(review.changes[0]!.defaultAccept).toBe(true);
    } finally {
      closeReimport(plain);
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
    expect(value(store, "SELECT owner_id FROM raw_record WHERE xref = '@I101@'")).toBe(thaddeus);
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
    // The person row itself is left alone, so an unchanged person stays unchanged.
    expect(value(store, 'SELECT external_id FROM person WHERE id = ?', ids.thaddeus)).toBe('@I1@');
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

describe('review findings (#72)', () => {
  const COUSINS = [
    '0 HEAD',
    '1 GEDC',
    '2 VERS 5.5.1',
    '0 @I1@ INDI',
    '1 NAME Adam /Smith/',
    '1 SEX M',
    '1 FAMS @F1@',
    '0 @I2@ INDI',
    '1 NAME Bert /Smith/',
    '1 SEX M',
    '1 FAMS @F2@',
    '0 @I3@ INDI',
    '1 NAME John /Smith/',
    '1 SEX M',
    '1 BIRT',
    '2 DATE 1900',
    '2 PLAC Ashford',
    '1 DEAT',
    '2 DATE 1970',
    '1 FAMC @F1@',
    '0 @I4@ INDI',
    '1 NAME John /Smith/',
    '1 SEX M',
    '1 BIRT',
    '2 DATE 1900',
    '2 PLAC Ashford',
    '1 DEAT',
    '2 DATE 1970',
    '1 FAMC @F2@',
    '0 @F1@ FAM',
    '1 HUSB @I1@',
    '1 CHIL @I3@',
    '0 @F2@ FAM',
    '1 HUSB @I2@',
    '1 CHIL @I4@',
    '0 TRLR',
    '',
  ].join('\n');

  /** Records in reverse order (Bert's family first), renumbered, and Bert's son now a baker. */
  function reversedCousins(): string {
    const records = COUSINS.split(/\n(?=0 )/);
    const head = records.shift()!;
    const trlr = records.pop()!;
    const body = records
      .reverse()
      .map((r) =>
        r.startsWith('0 @I4@') ? r.replace('1 FAMC @F2@', '1 OCCU Baker\n1 FAMC @F2@') : r,
      );
    return renumber([head, ...body, trlr].join('\n'), 50);
  }

  it('does not swap same-name cousins when the export lists them in reverse', async () => {
    const tree = openMemoryTree();
    await importGedcom({ bytes: COUSINS }, tree, { today: TODAY });
    const adamsJohn = pid(tree, '@I3@');
    const bertsJohn = pid(tree, '@I4@');
    const s2 = await prepareReimport(tree, { bytes: reversedCousins() }, { today: TODAY });
    try {
      const external = (id: string) =>
        value<string>(s2.incoming, 'SELECT external_id FROM person WHERE id = ?', id);
      const byExisting = new Map(
        [...s2.matches.values()].map((m) => [m.existingId, external(m.incomingId)]),
      );
      expect(byExisting.get(adamsJohn)).toBe('@I53@');
      expect(byExisting.get(bertsJohn)).toBe('@I54@');
      const changes = s2.diff.people.flatMap((p) => p.changes.map((c) => [p.existingId, c.kind]));
      expect(changes).toEqual([[bertsJohn, 'fact.add']]);
    } finally {
      closeReimport(s2);
      tree.close();
    }
  });

  it('keeps a match on name alone below bulk acceptance, with its changes unticked', async () => {
    const tree = openMemoryTree();
    await importGedcom({ bytes: ged('0 @I1@ INDI', '1 NAME Mary /Brown/') }, tree, {
      today: TODAY,
    });
    const incoming = ged(
      '0 @I9@ INDI',
      '1 NAME Mary /Brown/',
      '1 BIRT',
      '2 DATE 1990',
      '2 PLAC Elsewhere',
    );
    const s2 = await prepareReimport(tree, { bytes: incoming }, { today: TODAY });
    try {
      const [m] = [...s2.matches.values()];
      expect(m!.confidence).toBeLessThan(HIGH_CONFIDENCE);
      const changes = s2.diff.people.flatMap((p) => p.changes);
      expect(changes.map((c) => [c.kind, c.defaultAccept])).toEqual([['fact.add', false]]);
    } finally {
      closeReimport(s2);
      tree.close();
    }
  });

  it('refuses to apply after an undo or redo since the review', async () => {
    store.transact('Edit', (tx) => tx.update('person', pid(store, '@I2@'), { sex: 'U' }));
    const first = await prepareReimport(store, { bytes: updatedSample() }, { today: TODAY });
    try {
      undoLast(store);
      expect(() => applyReimport(store, first, defaults(first), 'Re-import')).toThrow(
        ReimportStaleError,
      );
    } finally {
      closeReimport(first);
    }
    const second = await prepareReimport(store, { bytes: updatedSample() }, { today: TODAY });
    try {
      redoLast(store);
      expect(() => applyReimport(store, second, defaults(second), 'Re-import')).toThrow(
        ReimportStaleError,
      );
    } finally {
      closeReimport(second);
    }
  });

  it('does not bring back a name the user renamed, unless asked', async () => {
    const name = value<string>(
      store,
      'SELECT id FROM person_name WHERE person_id = ?',
      pid(store, '@I2@'),
    );
    store.transact('Rename', (tx) => tx.update('person_name', name, { given: 'LocalName' }));
    const s2 = await prepareReimport(store, { bytes: renumber(SAMPLE) }, { today: TODAY });
    try {
      // The export still has the name the user changed: nothing to bring back (#185).
      const mercy = s2.diff.people.find((p) => p.existingId === pid(store, '@I2@'));
      expect(mercy?.changes ?? []).toEqual([]);
    } finally {
      closeReimport(s2);
    }
  });

  it('offers a person the user deleted unticked, saying so', async () => {
    const lily = pid(store, '@I26@');
    store.transact('Delete', (tx) => {
      for (const id of rows<{ id: string }>(
        store,
        'SELECT id FROM person_name WHERE person_id = ?',
        lily,
      ))
        tx.delete('person_name', id.id);
      for (const r of rows<{ id: string; event_id: string }>(
        store,
        'SELECT id, event_id FROM event_role WHERE person_id = ?',
        lily,
      )) {
        tx.delete('event_role', r.id);
        tx.delete('event', r.event_id);
      }
      for (const c of rows<{ id: string }>(
        store,
        'SELECT id FROM family_child WHERE child_id = ?',
        lily,
      ))
        tx.delete('family_child', c.id);
      for (const r of rows<{ id: string }>(
        store,
        "SELECT id FROM raw_record WHERE owner_type = 'person' AND owner_id = ?",
        lily,
      ))
        tx.delete('raw_record', r.id);
      tx.delete('person', lily);
    });
    const s2 = await prepareReimport(store, { bytes: renumber(SAMPLE) }, { today: TODAY });
    try {
      const review = s2.diff.people.find((p) => p.name === 'Lily Mosswood')!;
      expect(review.changes.map((c) => [c.kind, c.defaultAccept])).toEqual([
        ['deleted-here', false],
        ['person.new', false],
        ['child.add', true],
      ]);
    } finally {
      closeReimport(s2);
    }
  });

  it('lists partners and parents the export no longer has', async () => {
    const without = renumber(
      replaceRecord(SAMPLE.replace('1 FAMS @F7@\n', ''), '@F7@', null)
        .replace('1 FAMC @F7@\n2 _FREL Step\n2 _MREL Natural\n', '')
        .replace('1 FAMC @F7@\n', ''),
    );
    const s2 = await prepareReimport(store, { bytes: without }, { today: TODAY });
    try {
      const kinds = s2.diff.people.flatMap((p) =>
        p.changes.map((c) => [p.name, c.kind, c.applicable]),
      );
      // Listed once per couple, not on both partners' cards.
      const missing = kinds.filter(([, kind]) => kind === 'family.missing');
      expect(missing).toHaveLength(1);
      expect(['Edith Ashgrove', 'Leopold Hollowell']).toContain(missing[0]![0]);
      expect(missing[0]![2]).toBe(false);
      expect(kinds).toContainEqual(['Iris Hollowell', 'child.missing', false]);
    } finally {
      closeReimport(s2);
    }
  });
});

describe('re-review (#72): what the user deleted stays deleted', () => {
  /**
   * Re-imports the sample (renumbered; unchanged unless `text` says otherwise)
   * and returns one person's changes. Since #185 an export that still has what
   * the user deleted offers nothing: only a changed one asks.
   */
  async function changesFor(xref: string, text = SAMPLE) {
    const id = pid(store, xref);
    const s2 = await prepareReimport(store, { bytes: renumber(text) }, { today: TODAY });
    try {
      return s2.diff.people
        .filter((p) => p.existingId === id)
        .flatMap((p) => p.changes)
        .map((c) => ({
          kind: c.kind,
          conflict: c.conflict,
          defaultAccept: c.defaultAccept,
          fact: c.kind === 'fact.add' ? c.fact.type : undefined,
        }));
    } finally {
      closeReimport(s2);
    }
  }
  const deleted = (kind: string, fact?: string) => ({
    kind,
    conflict: 'local-delete',
    defaultAccept: false,
    fact,
  });
  const eventOf = (personId: string, type: string) =>
    value<string>(
      store,
      'SELECT e.id FROM event e JOIN event_role r ON r.event_id = e.id WHERE r.person_id = ? AND e.type = ?',
      personId,
      type,
    );

  it('a deleted fact', async () => {
    const thaddeus = pid(store, '@I1@');
    const birth = eventOf(thaddeus, 'BIRT');
    store.transact('Delete birth', (tx) => {
      for (const r of rows<{ id: string }>(
        store,
        'SELECT id FROM event_role WHERE event_id = ?',
        birth,
      ))
        tx.delete('event_role', r.id);
      tx.delete('event', birth);
    });
    expect(await changesFor('@I1@')).toEqual([]);
    // Ancestry changed the birth the user deleted: that is a conflict to decide.
    expect(
      await changesFor('@I1@', SAMPLE.replace('2 DATE Abt. 1842', '2 DATE 12 MAR 1842')),
    ).toEqual([deleted('fact.add', 'BIRT')]);
  });

  it('a deleted name', async () => {
    const mercy = pid(store, '@I2@');
    const name = value<string>(store, 'SELECT id FROM person_name WHERE person_id = ?', mercy);
    store.transact('Replace name', (tx) => {
      tx.delete('person_name', name);
      tx.insert('person_name', {
        person_id: mercy,
        given: 'Merry',
        surname: 'Bellweather',
        is_primary: 1,
      } as never);
    });
    expect(await changesFor('@I2@')).toEqual([]);
  });

  it('a deleted citation', async () => {
    const death = eventOf(pid(store, '@I1@'), 'DEAT');
    const link = value<string>(
      store,
      "SELECT id FROM citation_link WHERE owner_type = 'event' AND owner_id = ?",
      death,
    );
    store.transact('Remove source', (tx) => tx.delete('citation_link', link));
    expect(await changesFor('@I1@')).toEqual([]);
  });

  it('a deleted media link', async () => {
    const thaddeus = pid(store, '@I1@');
    store.transact('Remove photo', (tx) => {
      tx.update('person', thaddeus, { primary_media_id: null });
      for (const l of rows<{ id: string }>(
        store,
        "SELECT id FROM media_link WHERE owner_type = 'person' AND owner_id = ?",
        thaddeus,
      ))
        tx.delete('media_link', l.id);
    });
    expect(await changesFor('@I1@')).toEqual([]);
  });

  it('a deleted parent link', async () => {
    const josiah = pid(store, '@I3@');
    const link = value<string>(store, 'SELECT id FROM family_child WHERE child_id = ?', josiah);
    store.transact('Unlink parents', (tx) => tx.delete('family_child', link));
    expect(await changesFor('@I3@')).toEqual([]);
  });

  it('a deleted partnership', async () => {
    const thaddeus = pid(store, '@I1@');
    const family = value<string>(
      store,
      'SELECT id FROM family WHERE partner1_id = ? OR partner2_id = ?',
      thaddeus,
      thaddeus,
    );
    store.transact('Remove partnership', (tx) => {
      for (const r of rows<{ id: string; event_id: string }>(
        store,
        'SELECT id, event_id FROM event_role WHERE family_id = ?',
        family,
      )) {
        tx.delete('event_role', r.id);
        tx.delete('event', r.event_id);
      }
      for (const c of rows<{ id: string }>(
        store,
        'SELECT id FROM family_child WHERE family_id = ?',
        family,
      ))
        tx.delete('family_child', c.id);
      tx.delete('family', family);
    });
    expect(await changesFor('@I1@')).toEqual([]);
    // The children's links to that family were deleted with it.
    expect(await changesFor('@I3@')).toEqual([]);
  });

  it('only offers a deleted person back as "deleted here" when the birth year agrees too', async () => {
    const lily = pid(store, '@I26@');
    const born = value<string>(
      store,
      "SELECT e.date_text FROM event e JOIN event_role r ON r.event_id = e.id WHERE r.person_id = ? AND e.type = 'BIRT'",
      lily,
    );
    store.transact('Delete', (tx) => {
      for (const r of rows<{ id: string; event_id: string }>(
        store,
        'SELECT id, event_id FROM event_role WHERE person_id = ?',
        lily,
      )) {
        tx.delete('event_role', r.id);
        tx.delete('event', r.event_id);
      }
      for (const n of rows<{ id: string }>(
        store,
        'SELECT id FROM person_name WHERE person_id = ?',
        lily,
      ))
        tx.delete('person_name', n.id);
      for (const c of rows<{ id: string }>(
        store,
        'SELECT id FROM family_child WHERE child_id = ?',
        lily,
      ))
        tx.delete('family_child', c.id);
      tx.delete('person', lily);
    });
    const year = /\d{4}/.exec(born)![0];
    const record = recordOf(SAMPLE, '@I26@').join('\n');
    const other = renumber(SAMPLE.replace(record, record.replace(year, String(Number(year) - 40))));
    const s2 = await prepareReimport(store, { bytes: other }, { today: TODAY });
    try {
      const review = s2.diff.people.find((p) => p.name === 'Lily Mosswood')!;
      expect(review.changes.map((c) => c.kind)).not.toContain('deleted-here');
    } finally {
      closeReimport(s2);
    }
  });

  it('does not count a change that only normalizes Unicode as a local edit', async () => {
    const tree = openMemoryTree();
    await importGedcom(
      { bytes: ged('0 @I1@ INDI', '1 NAME René /Aubert/', '1 BIRT', '2 DATE 1900') },
      tree,
      { today: TODAY },
    );
    const name = value<string>(tree, 'SELECT id FROM person_name');
    const given = value<string>(tree, 'SELECT given FROM person_name');
    tree.transact('Normalize', (tx) =>
      tx.update('person_name', name, { given: given.normalize('NFC') }),
    );
    expect(localHistory(tree).renamed.size).toBe(0);
    expect(localHistory(tree).edited.size).toBe(0);
    tree.close();
  });
});

describe('re-review (#72): matching and bookkeeping', () => {
  it('does not pre-tick a pick between indistinguishable twins', async () => {
    const twins = ged(
      '0 @I1@ INDI',
      '1 NAME Adam /Smith/',
      '1 SEX M',
      '1 FAMS @F1@',
      '0 @I2@ INDI',
      '1 NAME Ann /Smith/',
      '1 SEX F',
      '1 FAMS @F1@',
      '0 @I3@ INDI',
      '1 NAME John /Smith/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1900',
      '1 FAMC @F1@',
      '0 @I4@ INDI',
      '1 NAME John /Smith/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1900',
      '1 FAMC @F1@',
      '0 @F1@ FAM',
      '1 HUSB @I1@',
      '1 WIFE @I2@',
      '1 CHIL @I3@',
      '1 CHIL @I4@',
    );
    const tree = openMemoryTree();
    await importGedcom({ bytes: twins }, tree, { today: TODAY });
    const later = twins.replace('1 FAMC @F1@\n0 @I4@', '1 OCCU Baker\n1 FAMC @F1@\n0 @I4@');
    for (const text of [later, renumber(later)]) {
      const s2 = await prepareReimport(tree, { bytes: text }, { today: TODAY });
      try {
        const johns = [...s2.matches.values()].filter((m) =>
          [pid(tree, '@I3@'), pid(tree, '@I4@')].includes(m.existingId),
        );
        expect(johns).toHaveLength(2);
        expect(johns.every((m) => m.confidence < HIGH_CONFIDENCE)).toBe(true);
        const changes = s2.diff.people.flatMap((p) => p.changes);
        expect(changes.map((c) => [c.kind, c.defaultAccept])).toEqual([['fact.add', false]]);
      } finally {
        closeReimport(s2);
      }
    }
    tree.close();
  });

  it('does not pre-tick a pick between cousins whose fathers are identical too', async () => {
    const lines = [
      '0 @I1@ INDI',
      '1 NAME Adam /Smith/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1870',
      '1 FAMS @F1@',
      '0 @I2@ INDI',
      '1 NAME Adam /Smith/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1870',
      '1 FAMS @F2@',
      '0 @I3@ INDI',
      '1 NAME John /Smith/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1900',
      '1 FAMC @F1@',
      '0 @I4@ INDI',
      '1 NAME John /Smith/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1900',
      '1 FAMC @F2@',
      '0 @F1@ FAM',
      '1 HUSB @I1@',
      '1 CHIL @I3@',
      '0 @F2@ FAM',
      '1 HUSB @I2@',
      '1 CHIL @I4@',
    ];
    const cousins = ged(...lines);
    const tree = openMemoryTree();
    await importGedcom({ bytes: cousins }, tree, { today: TODAY });
    const later = cousins.replace(
      '2 DATE 1900\n1 FAMC @F2@',
      '2 DATE 1900\n1 OCCU Baker\n1 FAMC @F2@',
    );
    for (const text of [later, renumber(later)]) {
      const s2 = await prepareReimport(tree, { bytes: text }, { today: TODAY });
      try {
        expect([...s2.matches.values()].every((m) => m.confidence < HIGH_CONFIDENCE)).toBe(true);
        const changes = s2.diff.people.flatMap((p) => p.changes);
        expect(changes.map((c) => [c.kind, c.defaultAccept])).toEqual([['fact.add', false]]);
      } finally {
        closeReimport(s2);
      }
    }
    tree.close();
  });

  it('keeps one stale-record list, for the newest import', async () => {
    const changed = renumber(SAMPLE.replace('2 DATE Abt. 1842', '2 DATE 12 MAR 1842'));
    for (let n = 0; n < 2; n++) {
      const s2 = await prepareReimport(store, { bytes: changed }, { today: TODAY });
      applyReimport(store, s2, new Set(), 'Re-import');
      closeReimport(s2);
    }
    expect(value<number>(store, "SELECT count(*) FROM meta WHERE key LIKE 'export.stale:%'")).toBe(
      1,
    );
  });
});

describe('UX QA (#72): a partner the export dropped', () => {
  /** The sample with Leopold no longer Edith's husband, every xref renumbered. */
  function withoutLeopold(extra = '') {
    const leopold = recordOf(SAMPLE, '@I16@').join('\n');
    return renumber(
      SAMPLE.replace(leopold, leopold.replace('\n1 FAMS @F7@', ''))
        .replace('0 @F7@ FAM\n1 HUSB @I16@\n', '0 @F7@ FAM\n')
        .replace('0 TRLR', `${extra}0 TRLR`),
    );
  }
  const parentFamilies = (xref: string) =>
    value<number>(store, 'SELECT count(*) FROM family_child WHERE child_id = ?', pid(store, xref));

  it('adds no family or parent link, and lists the dropped partnership once', async () => {
    const george = parentFamilies('@I15@');
    const iris = parentFamilies('@I17@');
    const families = value<number>(store, 'SELECT count(*) FROM family');
    const s2 = await prepareReimport(store, { bytes: withoutLeopold() }, { today: TODAY });
    try {
      const changes = s2.diff.people.flatMap((p) => p.changes.map((c) => [p.name, c.kind]));
      expect(changes.filter(([, k]) => k === 'child.add' || k === 'family.add')).toEqual([]);
      expect(changes.filter(([, k]) => k === 'child.missing')).toEqual([]);
      expect(changes.filter(([, k]) => k === 'family.missing')).toEqual([
        ['Edith Ashgrove', 'family.missing'],
      ]);
      applyReimport(store, s2, defaults(s2), 'Re-import');
    } finally {
      closeReimport(s2);
    }
    expect(parentFamilies('@I15@')).toBe(george);
    expect(parentFamilies('@I17@')).toBe(iris);
    expect(value<number>(store, 'SELECT count(*) FROM family')).toBe(families);
  });

  it('offers a new child of that family unticked, joining the existing family', async () => {
    const text = withoutLeopold()
      .replace('0 @F107@ FAM\n', '0 @F107@ FAM\n1 CHIL @I190@\n')
      .replace(
        '0 TRLR',
        '0 @I190@ INDI\n1 NAME Ada /Hollowell/\n1 BIRT\n2 DATE 1932\n1 FAMC @F107@\n0 TRLR',
      );
    const families = value<number>(store, 'SELECT count(*) FROM family');
    const s2 = await prepareReimport(store, { bytes: text }, { today: TODAY });
    try {
      const ada = s2.diff.people.find((p) => p.name === 'Ada Hollowell')!;
      // Not added by default either: with its only parent link unticked it would have no parents.
      expect(ada.changes.map((c) => [c.kind, c.defaultAccept])).toEqual([
        ['person.new', false],
        ['child.add', false],
        ['unlinked-new', false],
      ]);
      expect(ada.changes.at(-1)!.applicable).toBe(false);
      applyReimport(store, s2, new Set(ada.changes.map((c) => c.id)), 'Re-import');
    } finally {
      closeReimport(s2);
    }
    expect(value<number>(store, 'SELECT count(*) FROM family')).toBe(families);
    const adaFamily = value<string>(
      store,
      "SELECT fc.family_id FROM family_child fc JOIN person_name n ON n.person_id = fc.child_id WHERE n.given = 'Ada'",
    );
    expect(adaFamily).toBe(
      value<string>(
        store,
        'SELECT family_id FROM family_child WHERE child_id = ?',
        pid(store, '@I17@'),
      ),
    );
  });
});

describe('UX QA (#72): new people who look like someone in the tree', () => {
  it('offers a near-name record unticked as a possible match, and a stranger as new', async () => {
    const extra = [
      '0 @I90@ INDI',
      '1 NAME Edyth /Ashgrove/',
      '1 SEX F',
      '1 BIRT',
      '2 DATE 1897',
      '0 @I91@ INDI',
      '1 NAME Harold /Ashgrove/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1955',
      '',
    ].join('\n');
    const s2 = await prepareReimport(
      store,
      { bytes: renumber(SAMPLE.replace('0 TRLR', `${extra}0 TRLR`)) },
      { today: TODAY },
    );
    try {
      const of = (name: string) =>
        s2.diff.people
          .find((p) => p.name === name && p.status === 'new')!
          .changes.map((c) => [c.kind, c.defaultAccept]);
      expect(of('Edyth Ashgrove')).toEqual([
        ['possible-match', false],
        ['person.new', false],
      ]);
      const hint = s2.diff.people
        .find((p) => p.name === 'Edyth Ashgrove')!
        .changes.find((c) => c.kind === 'possible-match');
      expect(hint).toMatchObject({ existingName: 'Edith Ashgrove', applicable: false });
      expect(of('Harold Ashgrove')).toEqual([['person.new', true]]);
    } finally {
      closeReimport(s2);
    }
  });
});

describe('trustworthy confidence and reasons (#159)', () => {
  it('is below 100% when a fact differs, and 100% when nothing does', async () => {
    const s2 = await prepareReimport(store, { bytes: renumber(updatedSample()) }, { today: TODAY });
    try {
      const of = (xref: string) =>
        [...s2.matches.values()].find((m) => m.existingId === pid(store, xref))!;
      // Thaddeus: birth refined from Abt. 1842 to 12 MAR 1842.
      expect(of('@I1@').confidence).toBeLessThan(1);
      expect(of('@I1@').confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE);
      expect(of('@I1@').reasons).toContain('different birth date');
      // Mercy: nothing differs.
      expect(of('@I2@').confidence).toBe(1);
    } finally {
      closeReimport(s2);
    }
  });

  it('tells the primary name apart from other names and from a similar one', async () => {
    const thaddeus = pid(store, '@I1@');
    const name = value<string>(store, 'SELECT id FROM person_name WHERE person_id = ?', thaddeus);
    store.transact('Rename', (tx) => {
      tx.update('person_name', name, { given: 'Thad', is_primary: 0, type: 'aka' } as never);
      tx.insert('person_name', {
        person_id: thaddeus,
        given: 'Teddy',
        surname: 'Ashgrove',
        is_primary: 1,
      } as never);
    });
    const mercy = pid(store, '@I2@');
    const mercyName = value<string>(store, 'SELECT id FROM person_name WHERE person_id = ?', mercy);
    store.transact('Rename', (tx) =>
      tx.update('person_name', mercyName, { given: 'Mercey' } as never),
    );
    const s2 = await prepareReimport(store, { bytes: renumber(SAMPLE) }, { today: TODAY });
    try {
      const reasons = (id: string) =>
        [...s2.matches.values()].find((m) => m.existingId === id)!.reasons;
      expect(reasons(mercy)).toContain('similar name (Mercey Bellweather / Mercy Bellweather)');
      expect(reasons(mercy)).not.toContain('same name');
      expect(reasons(pid(store, '@I3@'))).toContain('same name');
      // "Thaddeus" is none of Thaddeus's names now; the closest is the old one, Thad.
      expect(reasons(thaddeus).some((r) => r.startsWith('similar to another name (Thad'))).toBe(
        true,
      );
    } finally {
      closeReimport(s2);
    }
  });

  it('names the closest tree person for a new person, and starts them unticked', async () => {
    const tree = openMemoryTree();
    await importGedcom(
      {
        bytes: ged(
          '0 @I1@ INDI',
          '1 NAME Mary /Brown/',
          '1 SEX F',
          '1 BIRT',
          '2 DATE 1900',
          '2 PLAC Ashford',
          '1 DEAT',
          '2 DATE 1970',
        ),
      },
      tree,
      { today: TODAY },
    );
    const incoming = ged(
      '0 @I1@ INDI',
      '1 NAME Mary /Brown/',
      '1 SEX F',
      '1 BIRT',
      '2 DATE 1900',
      '2 PLAC Ashford',
      '1 DEAT',
      '2 DATE 1970',
      '0 @I2@ INDI',
      '1 NAME Mary /Brown/',
      '1 SEX F',
      '1 BIRT',
      '2 DATE 1904',
      '2 PLAC Elsewhere',
      '1 DEAT',
      '2 DATE 1990',
      '0 @I3@ INDI',
      '1 NAME Quill /Vexbury/',
      '1 BIRT',
      '2 DATE 1950',
    );
    const s2 = await prepareReimport(tree, { bytes: incoming }, { today: TODAY });
    try {
      const fresh = s2.diff.people.filter((p) => p.status === 'new');
      const mary = fresh.find((p) => p.name === 'Mary Brown')!;
      expect(mary.changes.map((c) => [c.kind, c.defaultAccept])).toEqual([
        ['possible-match', false],
        ['person.new', false],
      ]);
      expect(mary.reasons.some((r) => /^closest: Mary Brown, \d+%$/.test(r))).toBe(true);
      const quill = fresh.find((p) => p.name === 'Quill Vexbury')!;
      expect(quill.changes.map((c) => [c.kind, c.defaultAccept])).toEqual([['person.new', true]]);
      expect(quill.reasons).toEqual(['no close match in your tree']);
    } finally {
      closeReimport(s2);
      tree.close();
    }
  });
});

describe('apply reports where new people went (#158)', () => {
  it('maps each added person to their id in the tree', async () => {
    const s2 = await prepareReimport(store, { bytes: updatedSample() }, { today: TODAY });
    try {
      const noah = s2.diff.people.find((p) => p.name === 'Noah Ashgrove')!;
      const result = applyReimport(store, s2, defaults(s2), 'Re-import');
      const id = result.newPeople[noah.incomingId!];
      expect(id).toBeTruthy();
      expect(value(store, 'SELECT given FROM person_name WHERE person_id = ?', id)).toBe('Noah');
    } finally {
      closeReimport(s2);
    }
  });
});

describe('three-way re-import (#185)', () => {
  const josiahDeath = () =>
    value<string>(
      store,
      "SELECT e.date_text FROM event e JOIN event_role r ON r.event_id = e.id WHERE r.person_id = ? AND e.type = 'DEAT'",
      pid(store, '@I3@'),
    );
  const josiahChanges = (s: ReimportSession) =>
    s.diff.people
      .filter((p) => p.existingId === pid(store, '@I3@'))
      .flatMap((p) => p.changes)
      .filter((c) => c.kind === 'fact.change');

  it('follows a later export for a value an earlier re-import set', async () => {
    // First re-import: Josiah's death 1939 -> 1940, accepted.
    const first = await prepareReimport(
      store,
      { bytes: renumber(updatedSample()) },
      { today: TODAY },
    );
    applyReimport(store, first, defaults(first), 'Re-import 1');
    closeReimport(first);
    expect(josiahDeath()).toBe('1940');
    // Second re-import: Ancestry now says 1941. Nobody edited it here.
    // updatedSample() is already renumbered: Josiah is @I103@ there.
    const updated = updatedSample();
    const later = renumber(
      replaceRecord(
        updated,
        '@I103@',
        recordOf(updated, '@I103@').map((l) => (l === '2 DATE 1940' ? '2 DATE 1941' : l)),
      ),
      300,
    );
    const second = await prepareReimport(store, { bytes: later }, { today: TODAY });
    try {
      const [change, ...rest] = josiahChanges(second);
      expect(rest).toEqual([]);
      expect(change).toMatchObject({ defaultAccept: true });
      expect(change!.conflict).toBeUndefined();
      applyReimport(store, second, defaults(second), 'Re-import 2');
    } finally {
      closeReimport(second);
    }
    expect(josiahDeath()).toBe('1941');
  });

  it('offers nothing for a local edit when the export did not change that value', async () => {
    const death = value<string>(
      store,
      "SELECT e.id FROM event e JOIN event_role r ON r.event_id = e.id WHERE r.person_id = ? AND e.type = 'DEAT'",
      pid(store, '@I3@'),
    );
    store.transact('Edit', (tx) => tx.update('event', death, { date_text: '3 MAY 1939' }));
    const s2 = await prepareReimport(store, { bytes: renumber(SAMPLE) }, { today: TODAY });
    try {
      expect(josiahChanges(s2)).toEqual([]);
    } finally {
      closeReimport(s2);
    }
    // When Ancestry changes it too, both differ: a conflict, unticked.
    const s3 = await prepareReimport(store, { bytes: renumber(updatedSample()) }, { today: TODAY });
    try {
      expect(josiahChanges(s3)).toEqual([
        expect.objectContaining({ conflict: 'local-edit', defaultAccept: false }),
      ]);
    } finally {
      closeReimport(s3);
    }
  });

  it('does not count its own applied changes, or an added alternate name, as local edits', async () => {
    const first = await prepareReimport(
      store,
      { bytes: renumber(updatedSample()) },
      { today: TODAY },
    );
    applyReimport(store, first, defaults(first), 'Re-import 1');
    closeReimport(first);
    const mercy = pid(store, '@I2@');
    store.transact('Add aka', (tx) =>
      tx.insert('person_name', {
        person_id: mercy,
        given: 'Mercie',
        surname: 'Bellweather',
        type: 'aka',
        is_primary: 0,
      } as never),
    );
    const history = localHistory(store);
    expect(history.edited.size).toBe(1);
    expect(history.renamed.has(mercy)).toBe(false);
  });
});

describe('three-way re-import, review findings (#224)', () => {
  const pidOf = (xref: string) => pid(store, xref);
  const eventIdOf = (xref: string, type: string) =>
    value<string>(
      store,
      'SELECT e.id FROM event e JOIN event_role r ON r.event_id = e.id WHERE r.person_id = ? AND e.type = ?',
      pidOf(xref),
      type,
    );
  const changesOf = (s: ReimportSession, xref: string) =>
    s.diff.people.filter((p) => p.existingId === pidOf(xref)).flatMap((p) => p.changes);
  /** The sample with one person's record lines rewritten, renumbered. */
  const edited = (xref: string, map: (line: string) => string[] | string, offset = 100) =>
    renumber(
      replaceRecord(
        SAMPLE,
        xref,
        recordOf(SAMPLE, xref).flatMap((l) => map(l)),
      ),
      offset,
    );
  const josiah1940 = (offset = 100) =>
    edited('@I3@', (l) => (l === '2 DATE 1939' ? '2 DATE 1940' : l), offset);

  it('does not offer a declined change again for the same export (P6)', async () => {
    const death = eventIdOf('@I3@', 'DEAT');
    store.transact('Edit', (tx) => tx.update('event', death, { date_text: '3 MAY 1939' }));
    const first = await prepareReimport(store, { bytes: josiah1940() }, { today: TODAY });
    expect(changesOf(first, '@I3@')).toEqual([
      expect.objectContaining({ kind: 'fact.change', conflict: 'local-edit' }),
    ]);
    applyReimport(store, first, new Set(), 'Re-import, declined');
    closeReimport(first);
    const again = await prepareReimport(store, { bytes: josiah1940(200) }, { today: TODAY });
    try {
      expect(changesOf(again, '@I3@')).toEqual([]);
    } finally {
      closeReimport(again);
    }
    // When Ancestry changes it again, both sides differ: a conflict once more.
    const later = edited('@I3@', (l) => (l === '2 DATE 1939' ? '2 DATE 1941' : l), 300);
    const third = await prepareReimport(store, { bytes: later }, { today: TODAY });
    try {
      expect(changesOf(third, '@I3@')).toEqual([
        expect.objectContaining({ kind: 'fact.change', conflict: 'local-edit' }),
      ]);
    } finally {
      closeReimport(third);
    }
  });

  it('is no conflict when the user edited a value back by hand (P8)', async () => {
    const death = eventIdOf('@I3@', 'DEAT');
    store.transact('Edit', (tx) => tx.update('event', death, { date_text: '3 MAY 1939' }));
    store.transact('Edit back', (tx) => tx.update('event', death, { date_text: '1939' }));
    const s2 = await prepareReimport(store, { bytes: josiah1940() }, { today: TODAY });
    try {
      const [change] = changesOf(s2, '@I3@');
      expect(change).toMatchObject({ kind: 'fact.change', defaultAccept: true });
      expect(change!.conflict).toBeUndefined();
    } finally {
      closeReimport(s2);
    }
  });

  it('is no conflict when the user changed another column of the row (P7)', async () => {
    store.transact('Privacy', (tx) => tx.update('person', pidOf('@I3@'), { privacy: 'private' }));
    const s2 = await prepareReimport(
      store,
      { bytes: edited('@I3@', (l) => (l === '1 SEX M' ? '1 SEX F' : l)) },
      { today: TODAY },
    );
    try {
      const [change] = changesOf(s2, '@I3@').filter((c) => c.kind === 'sex');
      // A different sex lowers the match's confidence, but the change is no local-edit conflict.
      expect(change).toMatchObject({ kind: 'sex', after: 'F' });
      expect(change!.conflict).toBeUndefined();
    } finally {
      closeReimport(s2);
    }
  });

  it('brings back a deleted multi-valued fact Ancestry changed as an unticked conflict (P4)', async () => {
    const resi = eventIdOf('@I3@', 'RESI');
    store.transact('Delete residence', (tx) => {
      for (const r of rows<{ id: string }>(
        store,
        'SELECT id FROM event_role WHERE event_id = ?',
        resi,
      ))
        tx.delete('event_role', r.id);
      tx.delete('event', resi);
    });
    let inResi = false;
    const s2 = await prepareReimport(
      store,
      {
        bytes: edited('@I3@', (l) => {
          if (l.startsWith('1 ')) inResi = l === '1 RESI';
          return inResi && l === '2 DATE 1900' ? '2 DATE 1901' : l;
        }),
      },
      { today: TODAY },
    );
    try {
      const resiAdds = changesOf(s2, '@I3@').filter(
        (c) => c.kind === 'fact.add' && c.fact.type === 'RESI',
      );
      expect(resiAdds).toEqual([
        expect.objectContaining({ conflict: 'local-delete', defaultAccept: false }),
      ]);
    } finally {
      closeReimport(s2);
    }
  });

  /** Renames the place of Josiah's death, residence and marriage, as the user. */
  const renameElderford = () => {
    const place = value<string>(
      store,
      'SELECT place_id FROM event WHERE id = ?',
      eventIdOf('@I3@', 'DEAT'),
    );
    store.transact('Rename place', (tx) =>
      tx.update('place', place, { full_name: 'Elderford, Ohio' } as never),
    );
  };

  it('takes only a new name as a renamed place, not new coordinates (#307 review)', async () => {
    const place = value<string>(
      store,
      'SELECT place_id FROM event WHERE id = ?',
      eventIdOf('@I3@', 'DEAT'),
    );
    store.transact('Map it', (tx) =>
      tx.update('place', place, { latitude: 40.1, longitude: -82.9 } as never),
    );
    const s2 = await prepareReimport(store, { bytes: josiah1940() }, { today: TODAY });
    try {
      const [change] = changesOf(s2, '@I3@').filter((c) => c.kind === 'fact.change');
      expect(change).toMatchObject({ defaultAccept: true });
      expect(change!.conflict).toBeUndefined();
      expect(change).not.toHaveProperty('keepPlace');
    } finally {
      closeReimport(s2);
    }
  });

  it('offers nothing for facts whose place the user renamed, if the export kept it', async () => {
    renameElderford();
    const s2 = await prepareReimport(store, { bytes: renumber(SAMPLE) }, { today: TODAY });
    try {
      expect(changesOf(s2, '@I3@').filter((c) => c.kind === 'fact.change')).toEqual([]);
    } finally {
      closeReimport(s2);
    }
  });

  it("offers Ancestry's other change to a fact at a renamed place, keeping the place", async () => {
    renameElderford();
    const death = eventIdOf('@I3@', 'DEAT');
    const place = value<string>(store, 'SELECT place_id FROM event WHERE id = ?', death);
    const s2 = await prepareReimport(store, { bytes: josiah1940() }, { today: TODAY });
    try {
      const changes = changesOf(s2, '@I3@').filter((c) => c.kind === 'fact.change');
      expect(changes).toEqual([
        expect.objectContaining({
          after: expect.objectContaining({ type: 'DEAT', date: '1940' }),
          keepPlace: true,
          defaultAccept: true,
        }),
      ]);
      expect(changes[0]!.conflict).toBeUndefined();
      applyReimport(store, s2, defaults(s2), 'Re-import');
    } finally {
      closeReimport(s2);
    }
    // The date is Ancestry's; the place is still the user's renamed one, not a re-created copy.
    expect(row(store, 'SELECT date_text, place_id FROM event WHERE id = ?', death)).toEqual({
      date_text: '1940',
      place_id: place,
    });
    expect(value(store, "SELECT count(*) FROM place WHERE full_name LIKE 'Elderford, Cask%'")).toBe(
      0,
    );
  });

  it('is a renamed-place conflict when Ancestry moves a fact at a renamed place elsewhere', async () => {
    renameElderford();
    let inDeath = false;
    const moved = edited('@I3@', (l) => {
      if (l.startsWith('1 ')) inDeath = l === '1 DEAT';
      return inDeath && l.startsWith('2 PLAC ')
        ? '2 PLAC Millbrook, Harlow County, Vermont, USA'
        : l;
    });
    const s2 = await prepareReimport(store, { bytes: moved }, { today: TODAY });
    try {
      const changes = changesOf(s2, '@I3@').filter((c) => c.kind === 'fact.change');
      expect(changes).toEqual([
        expect.objectContaining({
          after: expect.objectContaining({
            type: 'DEAT',
            place: 'Millbrook, Harlow County, Vermont, USA',
          }),
          conflict: 'renamed-place',
          defaultAccept: false,
        }),
      ]);
      expect(changes[0]).not.toHaveProperty('keepPlace');
    } finally {
      closeReimport(s2);
    }
  });

  it('adds a name Ancestry added after a rename plainly, if it still has the old name (P5c)', async () => {
    const mercy = pidOf('@I2@');
    const name = value<string>(store, 'SELECT id FROM person_name WHERE person_id = ?', mercy);
    store.transact('Rename', (tx) => tx.update('person_name', name, { given: 'Marcy' }));
    const s2 = await prepareReimport(
      store,
      {
        bytes: edited('@I2@', (l) =>
          l === '2 SURN Bellweather' ? [l, '1 NAME Mercy /Ashgrove/', '2 TYPE married'] : l,
        ),
      },
      { today: TODAY },
    );
    try {
      const [change, ...rest] = changesOf(s2, '@I2@');
      expect(rest).toEqual([]);
      expect(change).toMatchObject({
        kind: 'name.add',
        name: 'Mercy Ashgrove',
        defaultAccept: true,
      });
      expect(change!.conflict).toBeUndefined();
    } finally {
      closeReimport(s2);
    }
  });

  it('brings back a deleted residence whose date and place both changed as a plain addition', async () => {
    // A heuristic: with no shared date, place or value, nothing ties it to the deleted one.
    const resi = eventIdOf('@I3@', 'RESI');
    store.transact('Delete residence', (tx) => {
      for (const r of rows<{ id: string }>(
        store,
        'SELECT id FROM event_role WHERE event_id = ?',
        resi,
      ))
        tx.delete('event_role', r.id);
      tx.delete('event', resi);
    });
    let inResi = false;
    const s2 = await prepareReimport(
      store,
      {
        bytes: edited('@I3@', (l) => {
          if (l.startsWith('1 ')) inResi = l === '1 RESI';
          if (!inResi) return l;
          if (l === '2 DATE 1900') return '2 DATE 1910';
          if (l.startsWith('2 PLAC ')) return '2 PLAC Millbrook, Harlow County, Vermont, USA';
          return l;
        }),
      },
      { today: TODAY },
    );
    try {
      const [add, ...rest] = changesOf(s2, '@I3@').filter(
        (c) => c.kind === 'fact.add' && c.fact.type === 'RESI',
      );
      expect(rest).toEqual([]);
      expect(add).toMatchObject({ defaultAccept: true });
      expect(add!.conflict).toBeUndefined();
    } finally {
      closeReimport(s2);
    }
  });

  const baseImages = () =>
    rows<{ key: string; value: string }>(
      store,
      "SELECT key, value FROM meta WHERE key LIKE 'reimport.base:%'",
    ).map((r) => Object.keys(JSON.parse(r.value) as object).sort());

  it('records no base for changes it applied: the written row is the base', async () => {
    const s2 = await prepareReimport(store, { bytes: josiah1940() }, { today: TODAY });
    expect(changesOf(s2, '@I3@')).toEqual([expect.objectContaining({ kind: 'fact.change' })]);
    applyReimport(store, s2, defaults(s2), 'Re-import');
    closeReimport(s2);
    expect(baseImages()).toEqual([]);
    // The next re-import still follows Ancestry from the applied value.
    const later = edited('@I3@', (l) => (l === '2 DATE 1939' ? '2 DATE 1941' : l), 200);
    const s3 = await prepareReimport(store, { bytes: later }, { today: TODAY });
    try {
      const [change] = changesOf(s3, '@I3@');
      expect(change).toMatchObject({ kind: 'fact.change', defaultAccept: true });
      expect(change!.conflict).toBeUndefined();
    } finally {
      closeReimport(s3);
    }
  });

  it('compares a base with its place as it was, after the user renamed the place (P4)', async () => {
    const first = await prepareReimport(store, { bytes: josiah1940() }, { today: TODAY });
    applyReimport(store, first, defaults(first), 'Re-import');
    closeReimport(first);
    const death = eventIdOf('@I3@', 'DEAT');
    const place = value<string>(store, 'SELECT place_id FROM event WHERE id = ?', death);
    store.transact('Rename place', (tx) =>
      tx.update('place', place, { full_name: 'Elderford, Ohio' } as never),
    );
    store.transact('Edit', (tx) => tx.update('event', death, { date_text: '2 MAY 1940' }));
    const again = await prepareReimport(store, { bytes: josiah1940(200) }, { today: TODAY });
    try {
      // The export still says what it said: the user's date and place name stand.
      const deaths = changesOf(again, '@I3@').filter(
        (c) => c.kind === 'fact.change' && c.after.type === 'DEAT',
      );
      expect(deaths).toEqual([]);
    } finally {
      closeReimport(again);
    }
  });

  it('records the base only for the changes it declined', async () => {
    const death = eventIdOf('@I3@', 'DEAT');
    const s2 = await prepareReimport(
      store,
      {
        bytes: edited('@I3@', (l) =>
          l === '2 DATE 1939' ? '2 DATE 1940' : l === '2 DATE 12 JUN 1868' ? '2 DATE 1868' : l,
        ),
      },
      { today: TODAY },
    );
    const birth = changesOf(s2, '@I3@').find(
      (c) => c.kind === 'fact.change' && c.after.type === 'BIRT',
    )!;
    applyReimport(store, s2, new Set([birth.id]), 'Re-import, death declined');
    closeReimport(s2);
    expect(baseImages()).toEqual([[`event|${death}`]]);
  });
});

describe('name conflict wording (#160)', () => {
  it('gives a name type only when the export states one', async () => {
    const typed = renumber(
      SAMPLE.replace(
        '2 GIVN Mercy\n2 SURN Bellweather\n',
        '2 GIVN Mercy\n2 SURN Bellweather\n1 NAME Mercy /Ashgrove/\n2 TYPE married\n1 NAME Merry /Bellweather/\n',
      ),
    );
    const s2 = await prepareReimport(store, { bytes: typed }, { today: TODAY });
    try {
      const mercy = s2.diff.people.find((p) => p.existingId === pid(store, '@I2@'))!;
      const names = mercy.changes.flatMap((c) =>
        c.kind === 'name.add' ? [[c.name, c.nameType]] : [],
      );
      expect(names).toEqual([
        ['Mercy Ashgrove', 'married'],
        ['Merry Bellweather', null],
      ]);
      // Compare again (#163) keeps them too.
      refreshReimport(store, s2);
      const again = s2.diff.people
        .find((p) => p.existingId === pid(store, '@I2@'))!
        .changes.flatMap((c) => (c.kind === 'name.add' ? [[c.name, c.nameType]] : []));
      expect(again).toEqual(names);
    } finally {
      closeReimport(s2);
    }
  });
});

describe('rename wording only for renames (#201)', () => {
  const mercyChanges = (s: ReimportSession) =>
    s.diff.people
      .filter((p) => p.existingId === pid(store, '@I2@'))
      .flatMap((p) => p.changes)
      .filter((c) => c.kind === 'name.add');
  const withNames = (...lines: string[]) =>
    renumber(
      SAMPLE.replace(
        '2 GIVN Mercy\n2 SURN Bellweather\n',
        ['2 GIVN Mercy', '2 SURN Bellweather', ...lines, ''].join('\n'),
      ),
    );

  it('a name the export adds is a plain addition when the user only added an alternate', async () => {
    const mercy = pid(store, '@I2@');
    store.transact('Add aka', (tx) =>
      tx.insert('person_name', {
        person_id: mercy,
        given: 'Mercie',
        surname: 'Bellweather',
        type: 'aka',
        is_primary: 0,
      } as never),
    );
    const s2 = await prepareReimport(
      store,
      { bytes: withNames('1 NAME Mercy /Ashgrove/', '2 TYPE married') },
      { today: TODAY },
    );
    try {
      expect(mercyChanges(s2)).toEqual([
        expect.objectContaining({
          name: 'Mercy Ashgrove',
          nameType: 'married',
          defaultAccept: true,
        }),
      ]);
      expect(mercyChanges(s2)[0]!.conflict).toBeUndefined();
    } finally {
      closeReimport(s2);
    }
  });

  it('an alternate name the user edited, still in the export, offers nothing', async () => {
    const mercy = pid(store, '@I2@');
    const s1 = await prepareReimport(
      store,
      { bytes: withNames('1 NAME Mercie /Bellweather/') },
      { today: TODAY },
    );
    applyReimport(store, s1, defaults(s1), 'Re-import 1');
    closeReimport(s1);
    const alt = value<string>(
      store,
      "SELECT id FROM person_name WHERE person_id = ? AND given = 'Mercie'",
      mercy,
    );
    store.transact('Edit alt', (tx) => tx.update('person_name', alt, { given: 'Mercia' }));
    const s2 = await prepareReimport(
      store,
      { bytes: renumber(withNames('1 NAME Mercie /Bellweather/'), 400) },
      { today: TODAY },
    );
    try {
      expect(mercyChanges(s2)).toEqual([]);
    } finally {
      closeReimport(s2);
    }
  });

  it('a primary name both sides changed is a conflict that says what it was', async () => {
    const mercy = pid(store, '@I2@');
    const name = value<string>(store, 'SELECT id FROM person_name WHERE person_id = ?', mercy);
    store.transact('Rename', (tx) => tx.update('person_name', name, { given: 'Marcy' }));
    const changed = renumber(
      SAMPLE.replace(
        '1 NAME Mercy /Bellweather/\n2 GIVN Mercy\n',
        '1 NAME Mercey /Bellweather/\n2 GIVN Mercey\n',
      ),
    );
    const s2 = await prepareReimport(store, { bytes: changed }, { today: TODAY });
    try {
      expect(mercyChanges(s2)).toEqual([
        expect.objectContaining({
          name: 'Mercey Bellweather',
          was: 'Mercy Bellweather',
          conflict: 'local-edit',
          defaultAccept: false,
        }),
      ]);
      // Ticked, it is kept as an alternate with no invented type.
      applyReimport(store, s2, new Set(mercyChanges(s2).map((c) => c.id)), 'Re-import');
    } finally {
      closeReimport(s2);
    }
    expect(
      rows(
        store,
        'SELECT given, type, is_primary FROM person_name WHERE person_id = ? ORDER BY sort_order',
        mercy,
      ),
    ).toEqual([
      { given: 'Marcy', type: 'birth', is_primary: 1 },
      { given: 'Mercey', type: 'aka', is_primary: 0 },
    ]);
  });
});

describe('dates compared by meaning (#194)', () => {
  it('offers no change when a date is only written differently', async () => {
    const text = renumber(
      SAMPLE.replace('2 DATE 3 Mar 1846', '2 DATE 03 MAR 1846').replace(
        '2 DATE 12 JUN 1868',
        '2 DATE 12 June 1868',
      ),
    );
    const s2 = await prepareReimport(store, { bytes: text }, { today: TODAY });
    try {
      expect(s2.diff.people.flatMap((p) => p.changes)).toEqual([]);
    } finally {
      closeReimport(s2);
    }
  });
});

describe('three-way with dates by meaning (#224 on #194)', () => {
  it('does not re-offer a value the export only wrote differently', async () => {
    const person = (date: string) =>
      ged('0 @I1@ INDI', '1 NAME Ada /Vale/', '1 SEX F', '1 DEAT', `2 DATE ${date}`);
    const tree = openMemoryTree();
    await importGedcom({ bytes: person('1 JAN 1900') }, tree, { today: TODAY });
    const death = value<string>(tree, "SELECT id FROM event WHERE type = 'DEAT'");
    tree.transact('Edit', (tx) => tx.update('event', death, { date_text: '2 JAN 1900' }));
    const s2 = await prepareReimport(tree, { bytes: person('01 JAN 1900') }, { today: TODAY });
    try {
      // The base said 1 Jan 1900; the export still does, so the user's 2 Jan stands.
      expect(s2.diff.people.flatMap((p) => p.changes)).toEqual([]);
    } finally {
      closeReimport(s2);
      tree.close();
    }
  });
});

describe('comparing again (#163)', () => {
  it('re-diffs against the tree as it is now, with stable change keys', async () => {
    const s2 = await prepareReimport(store, { bytes: updatedSample() }, { today: TODAY });
    try {
      const keys = (s: ReimportSession) =>
        new Map(s.diff.people.flatMap((p) => p.changes.map((c) => [c.key, c])));
      const before = keys(s2);
      expect(new Set([...before.keys()]).size).toBe(before.size);
      expect(isReimportStale(store, s2)).toBe(false);
      const josiah = pid(store, '@I3@');
      const death = value<string>(
        store,
        "SELECT e.id FROM event e JOIN event_role r ON r.event_id = e.id WHERE r.person_id = ? AND e.type = 'DEAT'",
        josiah,
      );
      store.transact('Edit', (tx) => tx.update('event', death, { date_text: '3 MAY 1939' }));
      expect(isReimportStale(store, s2)).toBe(true);
      refreshReimport(store, s2);
      expect(isReimportStale(store, s2)).toBe(false);
      const after = keys(s2);
      // Every change not about the edited death keeps its key.
      for (const [key, c] of before) {
        if (c.kind === 'fact.change' && c.existingEventId === death) continue;
        expect(after.has(key)).toBe(true);
      }
      const edited = [...after.values()].find(
        (c) => c.kind === 'fact.change' && c.existingEventId === death,
      );
      expect(edited).toMatchObject({ conflict: 'local-edit', defaultAccept: false });
      applyReimport(store, s2, new Set(), 'Re-import');
    } finally {
      closeReimport(s2);
    }
  });
});

describe('review of #221: media whose files were missing at import', () => {
  const TWO_MISSING = ged(
    '0 @I1@ INDI',
    '1 NAME Ivo /Canary/',
    '1 OBJE',
    '2 FILE photos/untitled-a.jpg',
    '1 OBJE',
    '2 FILE photos/untitled-b.jpg',
  );
  const files = (tree: TreeStore) =>
    rows<{ line: string }>(
      tree,
      `SELECT u.line FROM unmapped_line u JOIN media m ON m.id = u.owner_id
        WHERE u.owner_type = 'media' ORDER BY u.line`,
    ).map((r) => r.line);

  it('keeps two untitled missing photos apart, each with its own path', async () => {
    const tree = openMemoryTree();
    await importGedcom({ bytes: TWO_MISSING }, tree, { today: TODAY });
    expect(files(tree)).toEqual(['2 FILE photos/untitled-a.jpg', '2 FILE photos/untitled-b.jpg']);

    const again = await prepareReimport(tree, { bytes: renumber(TWO_MISSING) }, { today: TODAY });
    try {
      expect(again.diff.counts).toMatchObject({ newPeople: 0, changes: 0 });
      applyReimport(tree, again, defaults(again), 'Re-import');
    } finally {
      closeReimport(again);
    }
    expect(value(tree, 'SELECT count(*) FROM media')).toBe(2);
    expect(files(tree)).toEqual(['2 FILE photos/untitled-a.jpg', '2 FILE photos/untitled-b.jpg']);
    tree.close();
  });

  it('never merges two incoming media into one existing row', async () => {
    const tree = openMemoryTree();
    // An older tree: one untitled missing photo, keyed by title only.
    await importGedcom(
      {
        bytes: ged('0 @I1@ INDI', '1 NAME Ivo /Canary/', '1 OBJE', '2 FILE photos/untitled-a.jpg'),
      },
      tree,
      { today: TODAY },
    );
    tree.db.prepare("DELETE FROM unmapped_line WHERE owner_type = 'media'").run();
    const again = await prepareReimport(tree, { bytes: renumber(TWO_MISSING) }, { today: TODAY });
    try {
      applyReimport(tree, again, defaults(again), 'Re-import');
    } finally {
      closeReimport(again);
    }
    const lines = rows<{ n: number }>(
      tree,
      `SELECT count(*) AS n FROM unmapped_line WHERE owner_type = 'media' GROUP BY owner_id`,
    );
    expect(lines.every((l) => l.n <= 1)).toBe(true);
    tree.close();
  });
});

describe('dates compared by meaning (#194)', () => {
  it('offers no change when a date is only written differently', async () => {
    const text = renumber(
      SAMPLE.replace('2 DATE 3 Mar 1846', '2 DATE 03 MAR 1846').replace(
        '2 DATE 12 JUN 1868',
        '2 DATE 12 June 1868',
      ),
    );
    const s2 = await prepareReimport(store, { bytes: text }, { today: TODAY });
    try {
      expect(s2.diff.people.flatMap((p) => p.changes)).toEqual([]);
    } finally {
      closeReimport(s2);
    }
  });
});

describe('a compare that can run in a worker (#161)', () => {
  it('keeps the export in a tree on disk, reports phases, and travels as plain data', async () => {
    const root = makeTempDir('oa-reimport-worker-');
    const incomingDir = join(root, 'incoming.oatree');
    const phases: string[] = [];
    const prepared = await prepareReimport(
      store,
      { bytes: updatedSample() },
      { today: TODAY, incomingDir, onProgress: (phase) => phases.push(phase) },
    );
    try {
      expect(existsSync(join(incomingDir, 'tree.sqlite'))).toBe(true);
      expect(phases).toContain('parse');
      expect(phases.at(-1)).toBe('compare');
      expect(phases).not.toContain('done');
      // What a worker posts back: structured-clone-safe data, then reopened on the main thread.
      const data = structuredClone(reimportData(prepared));
      prepared.incoming.close();
      const session = reimportFromData(data);
      expect(session.diff).toEqual(prepared.diff);
      expect([...session.matches]).toEqual([...prepared.matches]);
      applyReimport(store, session, defaults(session), 'Re-import');
      expect(pid(store, '@I1@')).toBeTruthy();
      closeReimport(session);
      // Closing removes the export's tree on disk.
      expect(existsSync(incomingDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('why a new person is new, truthfully (#192 review)', () => {
  const reasonsOf = async (tree: TreeStore, text: string, name: string) => {
    const s2 = await prepareReimport(tree, { bytes: text }, { today: TODAY });
    try {
      return s2.diff.people.find((p) => p.status === 'new' && p.name === name)!.reasons;
    } finally {
      closeReimport(s2);
    }
  };

  it('finds a tree person by an alternate given name', async () => {
    const joseph = [
      '0 @I1@ INDI',
      '1 NAME Joseph /Ashgrove/',
      '1 NAME Joe /Ashgrove/',
      '2 TYPE aka',
      '1 BIRT',
      '2 DATE 1900',
    ];
    const tree = openMemoryTree();
    await importGedcom({ bytes: ged(...joseph) }, tree, { today: TODAY });
    const later = ged(...joseph, '0 @I2@ INDI', '1 NAME Joe /Ashgrove/', '1 BIRT', '2 DATE 1990');
    const reasons = await reasonsOf(tree, later, 'Joe Ashgrove');
    expect(reasons[0]).toMatch(/^closest: Joseph Ashgrove, \d+%$/);
    tree.close();
  });

  it('does not claim nobody has a similar name when people share the surname', async () => {
    const text = renumber(
      SAMPLE.replace('0 TRLR', '0 @I90@ INDI\n1 NAME John /Ashgrove/\n1 BIRT\n2 DATE 2001\n0 TRLR'),
    );
    expect(await reasonsOf(store, text, 'John Ashgrove')).toEqual(['no close match in your tree']);
  });
});

describe('a place the export renamed (#279)', () => {
  const OLD = 'Millbrook, Harlow County, Vermont, USA';
  const NEW = 'Millbrook Falls, Harlow County, Vermont, USA';
  const renamed = () => renumber(SAMPLE.replaceAll(OLD, NEW));

  it('is offered as one place rename covering every fact there', async () => {
    const s2 = await prepareReimport(store, { bytes: renamed() }, { today: TODAY });
    try {
      const changes = s2.diff.people.flatMap((p) => p.changes);
      const atPlace = changes.filter(
        (c) => c.kind === 'fact.change' && c.before.place === OLD && c.after.place === NEW,
      );
      expect(atPlace.length).toBeGreaterThanOrEqual(2);
      expect(s2.diff.exportPlaceRenames).toEqual([
        { key: `${OLD}→${NEW}`, from: OLD, to: NEW, changeIds: atPlace.map((c) => c.id) },
      ]);
      // Each member names its rename, so the review can show them as one item.
      for (const c of atPlace) expect(c).toMatchObject({ exportPlaceRename: `${OLD}→${NEW}` });
      // Accepting them all moves every fact to the new name.
      applyReimport(store, s2, new Set(atPlace.map((c) => c.id)), 'Re-import');
    } finally {
      closeReimport(s2);
    }
    // The place itself was renamed: every fact there follows, a marriage included,
    // and the tree has one row for the town, not two (#307 review).
    expect(value(store, 'SELECT count(*) FROM place WHERE full_name = ?', OLD)).toBe(0);
    expect(value(store, 'SELECT count(*) FROM place WHERE full_name = ?', NEW)).toBe(1);
    expect(
      value(
        store,
        `SELECT count(*) FROM event e JOIN place p ON p.id = e.place_id
           JOIN event_role r ON r.event_id = e.id
          WHERE p.full_name = ? AND r.family_id IS NOT NULL`,
        NEW,
      ),
    ).toBe(1);
    expect(value(store, 'SELECT name FROM place WHERE full_name = ?', NEW)).toBe('Millbrook Falls');
    // One undo puts the old name back.
    undoLast(store);
    expect(value(store, 'SELECT count(*) FROM place WHERE full_name = ?', OLD)).toBe(1);
  });

  it("doesn't count the rename against a match", async () => {
    const same = await prepareReimport(store, { bytes: renumber(SAMPLE) }, { today: TODAY });
    const before = new Map(
      same.diff.people.filter((p) => p.existingId).map((p) => [p.existingId, p.confidence]),
    );
    closeReimport(same);
    const s2 = await prepareReimport(store, { bytes: renamed() }, { today: TODAY });
    try {
      for (const p of s2.diff.people.filter((x) => x.existingId)) {
        expect(p.reasons).not.toContain('different birth place');
        if (before.has(p.existingId)) expect(p.confidence).toBe(before.get(p.existingId));
      }
      // Someone born there is still matched as surely as with the old name.
      const born = s2.diff.people.find((p) => p.existingId === pid(store, '@I3@'))!;
      expect(born.reasons).toContain('same birth place');
    } finally {
      closeReimport(s2);
    }
  });

  it('still finds a rename when one fact went somewhere else, leaving that one alone', async () => {
    const ELDER = 'Elderford, Cask County, Ohio, USA';
    const CITY = 'Elderford City, Cask County, Ohio, USA';
    let first = true;
    const text = renumber(
      SAMPLE.replaceAll(ELDER, () => {
        if (!first) return CITY;
        first = false;
        return 'Brandnew, Cask County, Ohio, USA';
      }),
    );
    const s2 = await prepareReimport(store, { bytes: text }, { today: TODAY });
    try {
      expect(s2.diff.exportPlaceRenames.map((r) => [r.from, r.to])).toEqual([[ELDER, CITY]]);
      // The stray is an ordinary change of its own.
      const stray = s2.diff.people
        .flatMap((p) => p.changes)
        .filter((c) => c.kind === 'fact.change' && c.after.place?.startsWith('Brandnew'));
      expect(stray).toHaveLength(1);
      expect(stray[0]!.exportPlaceRename).toBeUndefined();
    } finally {
      closeReimport(s2);
    }
  });

  /** Applies every place rename the export offers, and nothing else. */
  const applyRenames = async (text: string) => {
    const s2 = await prepareReimport(store, { bytes: text }, { today: TODAY });
    try {
      const ids = s2.diff.exportPlaceRenames.flatMap((r) => r.changeIds);
      expect(ids.length).toBeGreaterThan(0);
      applyReimport(store, s2, new Set(ids), 'Re-import');
    } finally {
      closeReimport(s2);
    }
  };
  const placeId = (name: string) =>
    value<string>(store, 'SELECT id FROM place WHERE full_name = ?', name);

  it('renames the places under it too (#307 review)', async () => {
    const cemetery = `Old Cemetery, ${OLD}`;
    store.transact('Add', (tx) =>
      tx.insert('place', {
        name: 'Old Cemetery',
        full_name: cemetery,
        parent_id: placeId(OLD),
      } as never),
    );
    await applyRenames(renamed());
    expect(value(store, 'SELECT count(*) FROM place WHERE full_name = ?', cemetery)).toBe(0);
    expect(
      value(store, 'SELECT parent_id FROM place WHERE full_name = ?', `Old Cemetery, ${NEW}`),
    ).toBe(placeId(NEW));
  });

  it('merges into a place already named so without losing what the old one had (#307 review)', async () => {
    const old = placeId(OLD);
    store.transact('Prepare', (tx) => {
      tx.update('place', old, { latitude: 43.1, longitude: -72.6 } as never);
      tx.insert('place', {
        name: 'Old Cemetery',
        full_name: `Old Cemetery, ${OLD}`,
        parent_id: old,
      } as never);
      // A place row of the new name nobody uses yet, without coordinates.
      tx.insert('place', { name: 'Millbrook Falls', full_name: NEW } as never);
      const note = tx.insert('note', { text: 'Founded 1790' } as never) as { id: string };
      tx.insert('note_link', { note_id: note.id, owner_type: 'place', owner_id: old } as never);
    });
    await applyRenames(renamed());
    const merged = placeId(NEW);
    expect(value(store, 'SELECT count(*) FROM place WHERE full_name = ?', OLD)).toBe(0);
    expect(row(store, 'SELECT latitude, longitude FROM place WHERE id = ?', merged)).toEqual({
      latitude: 43.1,
      longitude: -72.6,
    });
    expect(
      value(
        store,
        "SELECT count(*) FROM note_link WHERE owner_type = 'place' AND owner_id = ?",
        merged,
      ),
    ).toBe(1);
    expect(
      value(store, 'SELECT parent_id FROM place WHERE full_name = ?', `Old Cemetery, ${NEW}`),
    ).toBe(merged);
  });

  it('moves facts rather than renaming a place whose county changed (#307 review)', async () => {
    const ELDER = 'Elderford, Cask County, Ohio, USA';
    const CO = 'Elderford, Cask Co., Ohio, USA';
    await applyRenames(renumber(SAMPLE.replaceAll(ELDER, CO)));
    // The old place keeps its name and parent; the new one sits under the new county.
    expect(value(store, 'SELECT count(*) FROM place WHERE full_name = ?', ELDER)).toBe(1);
    expect(
      value(
        store,
        'SELECT p.full_name FROM place c JOIN place p ON p.id = c.parent_id WHERE c.full_name = ?',
        CO,
      ),
    ).toBe('Cask Co., Ohio, USA');
  });

  it('leaves a one-off place change as an ordinary change', async () => {
    let first = true;
    const text = renumber(
      SAMPLE.replaceAll(OLD, (m) => {
        if (!first) return m;
        first = false;
        return NEW;
      }),
    );
    const s2 = await prepareReimport(store, { bytes: text }, { today: TODAY });
    try {
      expect(s2.diff.exportPlaceRenames).toEqual([]);
    } finally {
      closeReimport(s2);
    }
  });
});
