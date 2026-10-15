import {
  citationLinks,
  citations,
  events,
  families,
  familyChildren,
  listBatches,
  names,
  notes,
  openTree,
  persons,
  sources,
  undoLast,
  type TreeStore,
} from '@open-ancestry/db';
import { GedcomSerializeError, parseGedcom } from '@open-ancestry/gedcom';
import { importGedcom } from '@open-ancestry/import';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGedcomExport, exportGedcom } from './index';
import {
  FIXTURES,
  TODAY,
  ged,
  gedcom7Problems,
  domainSnapshot,
  importInto,
  importedSnapshot,
  pid,
  recordText,
  rows,
  value,
} from './test-helpers';

const sample = () => importInto(readFileSync(join(FIXTURES, 'ancestry-sample.ged')));
const quirks = () => importInto(readFileSync(join(FIXTURES, 'gedcom/ancestry-quirks.ged')));

/** raw_record text by xref, for records that should come out verbatim. */
function rawByXref(store: TreeStore): Map<string, string> {
  return new Map(
    rows<{ xref: string; raw_text: string }>(
      store,
      'SELECT xref, raw_text FROM raw_record WHERE xref IS NOT NULL',
    ).map((r) => [r.xref, r.raw_text]),
  );
}

/** Every imported record except `regenerated` comes out exactly as it was read. */
function expectVerbatimExcept(store: TreeStore, out: string, regenerated: string[]) {
  for (const [xref, raw] of rawByXref(store)) {
    if (!regenerated.includes(xref)) expect(recordText(out, xref), xref).toBe(raw);
  }
}

const primaryName = (store: TreeStore, xref: string) =>
  value<string>(
    store,
    'SELECT id FROM person_name WHERE person_id = ? AND is_primary = 1',
    pid(store, xref),
  );

describe('edited records', () => {
  it('regenerates only the edited person; everything else is verbatim', async () => {
    const store = await sample();
    store.transact('Rename Thaddeus', (tx) =>
      names.update(tx, primaryName(store, '@I1@'), { given: 'Thad', full_text: 'Thad /Ashgrove/' }),
    );
    const out = buildGedcomExport(store, { version: '5.5.1', now: TODAY });
    expectVerbatimExcept(store, out.text, ['@I1@']);
    expect(out.stats.generated).toBe(1);
    const thad = recordText(out.text, '@I1@')!;
    expect(thad).not.toBe(rawByXref(store).get('@I1@'));
    expect(thad).toContain('1 NAME Thad /Ashgrove/\n2 GIVN Thad\n2 SURN Ashgrove');
    // Ancestry tags survive regeneration.
    expect(thad).toContain('3 _APID 1,60525::1000001');
    expect(thad).toContain('1 _PHOTO @O1@');
    expect(thad).toContain('1 _MTTAG @T1@');
    expect(thad).toContain('1 FAMS @F1@');
    const again = await importInto(out.text);
    expect(importedSnapshot(again)).toEqual(
      domainSnapshot(store, (_table, id) => out.xrefs.get(id)!),
    );
  });

  it('writes an edited name from its columns, not the imported NAME line', async () => {
    const store = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 NAME Thaddeus /Ashgrove/',
        '2 GIVN Thaddeus',
        '2 SURN Ashgrove',
        '2 _NAMEX kept extension',
        '1 SEX M',
      ),
    );
    // The edit API changes the parts and leaves full_text as imported.
    store.transact('Rename', (tx) =>
      names.update(tx, primaryName(store, '@I1@'), { given: 'Theo', surname: 'Ashby' }),
    );
    for (const version of ['5.5.1', '7'] as const) {
      const out = buildGedcomExport(store, { version, now: TODAY });
      const record = recordText(out.text, '@I1@')!;
      expect(record).toContain('1 NAME Theo /Ashby/\n2 GIVN Theo\n2 SURN Ashby');
      expect(record).toContain('2 _NAMEX kept extension');
      expect(record).not.toMatch(/Thaddeus|Ashgrove/);
      expect(out.warnings).toEqual([]);
      const again = await importInto(out.text);
      expect(rows(again, 'SELECT given, surname, full_text FROM person_name')).toEqual([
        { given: 'Theo', surname: 'Ashby', full_text: 'Theo /Ashby/' },
      ]);
    }
    // A nickname edit alone keeps the imported text, with the quoted nickname replaced.
    store.transact('Nickname', (tx) =>
      names.update(tx, primaryName(store, '@I1@'), {
        given: 'Thaddeus',
        surname: 'Ashgrove',
      }),
    );
    store.transact('Retype', (tx) =>
      names.update(tx, primaryName(store, '@I1@'), {
        full_text: 'Thaddeus "Tad"  /Ashgrove/',
        nickname: 'Tad',
      }),
    );
    store.transact('Nick', (tx) =>
      names.update(tx, primaryName(store, '@I1@'), { nickname: 'Taddy' }),
    );
    const nicked = exportGedcom(store, { now: TODAY });
    expect(nicked).toContain('1 NAME Thaddeus "Taddy"  /Ashgrove/\n2 GIVN Thaddeus\n2 NICK Taddy');
    expect(rows(await importInto(nicked), 'SELECT nickname, full_text FROM person_name')).toEqual([
      { nickname: 'Taddy', full_text: 'Thaddeus "Taddy"  /Ashgrove/' },
    ]);
    // Setting the text itself makes it current again.
    store.transact('Retype', (tx) =>
      names.update(tx, primaryName(store, '@I1@'), { full_text: 'Theo "Ted" /Ashby/' }),
    );
    expect(exportGedcom(store, { now: TODAY })).toContain('1 NAME Theo "Ted" /Ashby/');
  });

  it.each([
    ['"', '"'],
    ['“', '”'],
    ['(', ')'],
  ])('never keeps an old %snickname%s in the NAME text', async (open, close) => {
    const written = (nick: string) => `${open}${nick}${close}`;
    const store = await importInto(
      ged('0 @I1@ INDI', `1 NAME Ann ${written('Nan')} /Ash/`, '2 NICK Nan'),
    );
    const id = primaryName(store, '@I1@');
    const nameLine = async (nickname: string | null) => {
      store.transact('Nick', (tx) => names.update(tx, id, { nickname }));
      const out = buildGedcomExport(store, { version: '5.5.1', now: TODAY }).text;
      const again = await importInto(out);
      return {
        line: recordText(out, '@I1@')!.split('\n')[1],
        nickname: rows(again, 'SELECT nickname FROM person_name')[0]!.nickname,
      };
    };
    expect(await nameLine('Tad')).toEqual({
      line: `1 NAME Ann ${written('Tad')} /Ash/`,
      nickname: 'Tad',
    });
    // Cleared: the marks go too.
    expect(await nameLine(null)).toEqual({ line: '1 NAME Ann /Ash/', nickname: null });
    // The stored text still has the imported nickname, so a new one takes its place.
    expect(await nameLine('Annie')).toEqual({
      line: `1 NAME Ann ${written('Annie')} /Ash/`,
      nickname: 'Annie',
    });
    const v7 = buildGedcomExport(store, { version: '7', now: TODAY }).text;
    expect(recordText(v7, '@I1@')).toContain(`1 NAME Ann ${written('Annie')} /Ash/`);
    expect(v7).not.toMatch(/Nan|Tad/);
  });

  it.each<[string, string | null, string, string | null]>([
    // [imported NAME, nickname edit, exported NAME, re-imported nickname]
    ['Dr. Ann "Nan" /Ash/ Jr.', 'Tad', 'Dr. Ann "Tad" /Ash/ Jr.', 'Tad'],
    ['Ann (Nan) /Ash/', 'Tad', 'Ann (Tad) /Ash/', 'Tad'],
    ['Ann (Nan) /Ash/', null, 'Ann /Ash/', null],
    ['Ann "Nan" /Ash/ "the elder"', 'Tad', 'Ann "Tad" /Ash/ "the elder"', 'Tad'],
    ['Ann "Nan" /Ash/', 'Big "J"', 'Ann (Big "J") /Ash/', 'Big "J"'],
  ])('%j with nickname %j exports %j', async (imported, nickname, exported, reread) => {
    const store = await importInto(ged('0 @I1@ INDI', `1 NAME ${imported}`, '2 NICK Nan'));
    store.transact('Nick', (tx) => names.update(tx, primaryName(store, '@I1@'), { nickname }));
    for (const version of ['5.5.1', '7'] as const) {
      const out = exportGedcom(store, { version, now: TODAY });
      expect(recordText(out, '@I1@')!.split('\n')[1], version).toBe(`1 NAME ${exported}`);
      expect(rows(await importInto(out), 'SELECT nickname FROM person_name'), version).toEqual([
        { nickname: reread },
      ]);
    }
  });

  it('leaves quoted text that is not the nickname alone', async () => {
    const store = await importInto(ged('0 @I1@ INDI', '1 NAME Ann /Ash/ "the elder"'));
    store.transact('Nick', (tx) =>
      names.update(tx, primaryName(store, '@I1@'), { nickname: 'Tad' }),
    );
    const out = exportGedcom(store, { now: TODAY });
    expect(recordText(out, '@I1@')).toContain('1 NAME Ann /Ash/ "the elder"\n');
    expect(recordText(out, '@I1@')).toContain('2 NICK Tad');
  });

  it('an edited event regenerates its owner only', async () => {
    const store = await sample();
    const birth = value<string>(
      store,
      "SELECT e.id FROM event e JOIN event_role r ON r.event_id = e.id WHERE r.person_id = ? AND e.type = 'BIRT'",
      pid(store, '@I3@'),
    );
    store.transact('Edit birth', (tx) => events.update(tx, birth, { date_text: '13 JUN 1868' }));
    const out = exportGedcom(store, { version: '5.5.1', now: TODAY });
    expectVerbatimExcept(store, out, ['@I3@']);
    expect(recordText(out, '@I3@')).toContain('2 DATE 13 JUN 1868');
  });

  it('a living-status change alone keeps the record verbatim', async () => {
    const store = await sample();
    store.transact('Mark living', (tx) =>
      persons.update(tx, pid(store, '@I26@'), { living: 'living' }),
    );
    const out = exportGedcom(store, { version: '5.5.1', now: TODAY });
    expectVerbatimExcept(store, out, []);
  });

  it('an edit that only changes the Unicode form keeps the record verbatim', async () => {
    const nfd = (t: string) => t.normalize('NFD');
    const store = await importInto(
      ged('0 @I1@ INDI', `1 NAME ${nfd('José /Müller/')}`, '0 @I2@ INDI', '1 NAME Ann /Ash/'),
    );
    // Stored NFD (as before #99), then rewritten NFC by a logged edit.
    store.db
      .prepare('UPDATE person_name SET given = ?, surname = ? WHERE given = ?')
      .run(nfd('José'), nfd('Müller'), 'José'.normalize('NFC'));
    store.transact('Normalize', (tx) =>
      names.update(tx, primaryName(store, '@I1@'), { given: 'José'.normalize('NFC') }),
    );
    expect(listBatches(store)).toHaveLength(1);
    expectVerbatimExcept(store, exportGedcom(store, { version: '5.5.1', now: TODAY }), []);
  });

  it('upgrading a tree with NFD text keeps the export byte-identical and History empty', async () => {
    const nfd = (t: string) => t.normalize('NFD');
    const dir = join(mkdtempSync(join(tmpdir(), 'oa-nfc-export-')), 'nfd.oatree');
    try {
      await importGedcom(
        {
          bytes: ged(
            '0 @I1@ INDI',
            `1 NAME ${nfd('José /Müller/')}`,
            '1 BIRT',
            `2 PLAC ${nfd('Zürich, Schweiz')}`,
            '0 @I2@ INDI',
            '1 NAME Ann /Ash/',
          ),
        },
        { dir },
        { today: TODAY },
      );
      // Put the tree back the way an import before #99 stored it, at schema version 2.
      let store = openTree(dir);
      for (const [table, column] of [
        ['person_name', 'given'],
        ['person_name', 'surname'],
        ['person_name', 'full_text'],
        ['place', 'name'],
        ['place', 'full_name'],
      ] as const) {
        for (const r of rows<{ id: string; v: string }>(
          store,
          `SELECT id, ${column} AS v FROM ${table}`,
        )) {
          store.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(nfd(r.v), r.id);
        }
      }
      // Tables later versions add go too, so reopening runs their migrations again.
      store.db.exec('DROP TABLE person_alias; DROP TABLE person_sort');
      store.db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
      const before = exportGedcom(store, { version: '5.5.1', now: TODAY });
      store.close();

      store = openTree(dir);
      expect(value(store, "SELECT value FROM meta WHERE key = 'schema_version'")).toBe(
        String(store.schemaVersion),
      );
      expect(value(store, 'SELECT full_name FROM place WHERE parent_id IS NOT NULL')).toBe(
        'Zürich, Schweiz'.normalize('NFC'),
      );
      expect(exportGedcom(store, { version: '5.5.1', now: TODAY })).toBe(before);
      expect(listBatches(store)).toEqual([]);
      store.close();
    } finally {
      rmSync(dirname(dir), { recursive: true, force: true });
    }
  });

  it('undoing the edit makes the record verbatim again', async () => {
    const store = await sample();
    store.transact('Rename', (tx) =>
      names.update(tx, primaryName(store, '@I2@'), { given: 'Mercedes' }),
    );
    undoLast(store);
    expectVerbatimExcept(store, exportGedcom(store, { now: TODAY }), []);
  });

  it('a changed child relationship regenerates the child and the family', async () => {
    const store = await sample();
    const link = value<string>(
      store,
      'SELECT id FROM family_child WHERE child_id = ?',
      pid(store, '@I19@'),
    );
    store.transact('Adopted', (tx) =>
      familyChildren.update(tx, link, { partner1_rel: 'adopted', partner2_rel: 'adopted' }),
    );
    const out = exportGedcom(store, { now: TODAY });
    expectVerbatimExcept(store, out, ['@I19@', '@F8@']);
    expect(recordText(out, '@I19@')).toContain('1 FAMC @F8@\n2 _FREL Adopted\n2 _MREL Adopted');
  });

  it('merges unmapped Ancestry lines back into a regenerated record', async () => {
    const store = await quirks();
    store.transact('Rename', (tx) =>
      names.update(tx, primaryName(store, '@I1@'), {
        given: 'Robin',
        full_text: 'Robin /Thistlewood/',
      }),
    );
    const out = exportGedcom(store, { now: TODAY });
    const wren = recordText(out, '@I1@')!;
    expect(wren).toContain('1 NAME Robin /Thistlewood/');
    // The unmapped _LONG line comes back, split with CONC at 255 characters.
    expect(
      parseGedcom(out)
        .index.get('@I1@')!
        .children.find((c) => c.tag === '_LONG')?.value,
    ).toBe('Lorem ipsum dolor sit amet '.repeat(20).trimEnd());
    expect(Math.max(...wren.split('\n').map((l) => l.length))).toBeLessThanOrEqual(255);
    expect(wren).toContain('2 _APID 1,7602::12345');
  });

  it('gives new records fresh xrefs that every pointer resolves to', async () => {
    const store = await sample();
    const { result: child } = store.transact('Add child', (tx) => {
      const person = persons.create(tx, {
        sex: 'F',
        names: [{ given: 'Nova', surname: 'Mosswood', full_text: 'Nova /Mosswood/' }],
      });
      const family = value<string>(store, "SELECT id FROM family WHERE external_id = '@F10@'");
      familyChildren.create(tx, { family_id: family, child_id: person.id });
      const note = notes.create(tx, { text: 'Added in the app' });
      tx.insert('note_link', { note_id: note.id, owner_type: 'person', owner_id: person.id });
      const source = value<string>(store, "SELECT id FROM source WHERE external_id = '@S5@'");
      const citation = citations.create(tx, { source_id: source, page: 'p. 9', apid: '1,2442::1' });
      citationLinks.create(tx, {
        citation_id: citation.id,
        owner_type: 'person',
        owner_id: person.id,
      });
      return person;
    });
    const out = buildGedcomExport(store, { now: TODAY });
    const xref = out.xrefs.get(child.id)!;
    expect(xref).toBe('@I27@');
    expectVerbatimExcept(store, out.text, ['@F10@']);
    const nova = recordText(out.text, xref)!;
    expect(nova).toContain('1 FAMC @F10@');
    expect(nova).toContain('1 NOTE Added in the app');
    expect(nova).toContain('1 SOUR @S5@\n2 PAGE p. 9\n2 _APID 1,2442::1');
    expect(recordText(out.text, '@F10@')).toContain(`1 CHIL ${xref}`);
    const doc = parseGedcom(out.text);
    expect(danglingPointers(doc)).toEqual([]);
  });

  it('a deleted person leaves no record and no pointer behind', async () => {
    const store = await sample();
    store.transact('Delete', (tx) => persons.delete(tx, pid(store, '@I24@')));
    const out = exportGedcom(store, { now: TODAY });
    expect(out).not.toContain('@I24@');
    expect(danglingPointers(parseGedcom(out))).toEqual([]);
    expectVerbatimExcept(store, out, ['@F9@']);
  });

  it('a deleted family is dropped and its members regenerated', async () => {
    const store = await sample();
    store.transact('Delete', (tx) =>
      families.delete(
        tx,
        value<string>(store, "SELECT id FROM family WHERE external_id = '@F10@'"),
      ),
    );
    const out = exportGedcom(store, { now: TODAY });
    expect(out).not.toContain('@F10@');
    expect(danglingPointers(parseGedcom(out))).toEqual([]);
  });

  it('still exports records nothing points at', async () => {
    const store = await sample();
    store.transact('Orphans', (tx) => {
      tx.insert('repository', { name: 'County archive' });
      sources.create(tx, { title: 'Unused parish register' });
      notes.create(tx, { text: 'A note about nothing yet' });
      tx.insert('tag', { name: 'To research', category: 'Custom' });
    });
    for (const version of ['5.5.1', '7'] as const) {
      const out = exportGedcom(store, { version, now: TODAY });
      expect(out).toMatch(/^0 @R2@ REPO\n1 NAME County archive$/m);
      expect(out).toMatch(/^0 @S6@ SOUR\n1 TITL Unused parish register$/m);
      expect(out).toMatch(/^0 @N1@ S?NOTE A note about nothing yet$/m);
      expect(out).toMatch(/^0 @T3@ _MTTAG\n1 NAME To research\n1 _MTCAT Custom$/m);
    }
  });

  it('leaves media out when asked', async () => {
    const store = await sample();
    for (const version of ['5.5.1', '7'] as const) {
      const out = exportGedcom(store, { version, includeMedia: false, now: TODAY });
      expect(out).not.toMatch(/OBJE|_PHOTO|_OID/);
      expect(out).toContain('_APID');
    }
  });

  it('puts nested unmapped lines back under the structure they came from', async () => {
    const store = await sample();
    store.transact('Renames', (tx) => {
      names.update(tx, primaryName(store, '@I21@'), { given: 'Pete' });
      names.update(tx, primaryName(store, '@I1@'), { given: 'Thad' });
    });
    for (const version of ['5.5.1', '7'] as const) {
      const out = buildGedcomExport(store, { version, now: TODAY });
      expect(out.warnings, version).toEqual([]);
      expect(recordText(out.text, '@I21@')).toContain(
        '1 ADOP\n2 DATE 1964\n2 FAMC @F8@\n3 ADOP BOTH',
      );
      expect(recordText(out.text, '@I1@')).toContain('1 OBJE @O1@\n2 _PRIM Y\n1 _PHOTO @O1@');
      if (version === '7') expect(gedcom7Problems(out.text)).toEqual([]);
    }
  });

  it('reports every imported line a regenerated record cannot carry over', async () => {
    const store = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 NAME Odile /Fernsby/',
        '1 BIRT',
        '2 DATE 1801',
        '2 _SRC parish copy',
        '1 FAMS @F99@',
        '1 _SKYPEID odile.f',
        '1 OBJE @O1@',
        '0 @O1@ OBJE',
        '1 FILE photos/odile portrait.jpg',
        '2 FORM jpg',
      ),
    );
    // While the birth exists, its extension line goes back under it, in place.
    store.transact('Rename', (tx) =>
      names.update(tx, primaryName(store, '@I1@'), {
        given: 'Odette',
        full_text: 'Odette /Fernsby/',
      }),
    );
    const renamed = buildGedcomExport(store, { now: TODAY });
    expect(renamed.warnings).toEqual([
      expect.stringMatching(/^@I1@: "FAMS @F99@" \(INDI\.FAMS\) .*@F99@ is not in the export/),
    ]);
    expect(recordText(renamed.text, '@I1@')).toContain(
      '1 BIRT\n2 DATE 1801\n2 _SRC parish copy\n1 _SKYPEID odile.f',
    );
    const birth = value<string>(store, "SELECT id FROM event WHERE type = 'BIRT'");
    store.transact('Delete birth', (tx) => events.delete(tx, birth));
    const out = buildGedcomExport(store, { version: '7', now: TODAY });
    expect(out.warnings).toEqual([
      expect.stringMatching(/^@I1@: "_SRC parish copy" \(INDI\.BIRT\._SRC\) .*gone/),
      expect.stringMatching(/^@I1@: "FAMS @F99@" \(INDI\.FAMS\) .*@F99@ is not in the export/),
    ]);
    expect(out.text).not.toContain('parish copy');
    expect(recordText(out.text, '@I1@')).toContain('1 _SKYPEID odile.f');
    // A media path that did not resolve stays in FILE (percent-encoded in GEDCOM 7).
    expect(recordText(out.text, '@O1@')).toContain('1 FILE photos/odile%20portrait.jpg');
    expect(gedcom7Problems(out.text)).toEqual([]);
  });

  it('warns instead of writing a 5.5.1-only tag into GEDCOM 7', async () => {
    const store = await importInto(readFileSync(join(FIXTURES, 'gedcom/malformed.ged')));
    const out = buildGedcomExport(store, { version: '7', now: TODAY });
    expect(out.warnings).toContainEqual(expect.stringContaining('CONC is not a GEDCOM 7 tag'));
    expect(gedcom7Problems(out.text)).toEqual([]);
  });

  it('writes an event type that is not a GEDCOM tag as EVEN with TYPE', async () => {
    const store = await sample();
    store.transact('Custom', (tx) => {
      for (const type of ['Graduation', 'grad', '_DNA'])
        events.create(tx, { type, date_text: '1990', roles: [{ person_id: pid(store, '@I1@') }] });
    });
    for (const version of ['5.5.1', '7'] as const) {
      const thad = recordText(exportGedcom(store, { version, now: TODAY }), '@I1@')!;
      expect(thad).toContain('1 EVEN\n2 TYPE Graduation\n2 DATE 1990');
      expect(thad).toContain('1 GRAD\n2 DATE 1990');
      expect(thad).toContain('1 _DNA\n2 DATE 1990');
      expect(thad).not.toMatch(/^1 GRADUATION/m);
    }
  });

  it('surfaces serializer errors instead of writing broken GEDCOM', async () => {
    const store = await sample();
    // An imported HEAD whose text closes the record early cannot take the GEDC lines an export adds.
    store.db
      .prepare("UPDATE raw_record SET raw_text = ? WHERE gedcom_tag = 'HEAD'")
      .run('0 HEAD\n1 CHAR ANSEL\n0 @I2@');
    expect(() => exportGedcom(store, { now: TODAY })).toThrow(GedcomSerializeError);
  });
});

function danglingPointers(doc: ReturnType<typeof parseGedcom>): string[] {
  const out: string[] = [];
  const visit = (n: (typeof doc.records)[number]) => {
    if (n.pointer && n.pointer !== '@VOID@' && !doc.index.has(n.pointer)) out.push(n.pointer);
    n.children.forEach(visit);
  };
  doc.records.forEach(visit);
  return out;
}
