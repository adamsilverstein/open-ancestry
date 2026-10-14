import {
  citationLinks,
  citations,
  events,
  families,
  familyChildren,
  names,
  notes,
  persons,
  sources,
  undoLast,
  type TreeStore,
} from '@open-ancestry/db';
import { GedcomSerializeError, parseGedcom } from '@open-ancestry/gedcom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGedcomExport, exportGedcom } from './index';
import {
  FIXTURES,
  TODAY,
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

  it('surfaces serializer errors instead of writing broken GEDCOM', async () => {
    const store = await sample();
    store.transact('Bad type', (tx) =>
      events.create(tx, {
        type: 'NOT A TAG',
        roles: [{ person_id: pid(store, '@I1@') }],
      }),
    );
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
