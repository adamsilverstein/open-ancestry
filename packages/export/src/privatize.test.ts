import { isLiving, type LivingStatus, type TreeStore } from '@open-ancestry/db';
import { parseGedcom } from '@open-ancestry/gedcom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportGedcom, exportGedzip } from './index';
import { unzipSync } from 'fflate';
import {
  FIXTURES,
  FIXTURE_FILES,
  TODAY,
  gedcom7Problems,
  ged,
  importInto,
  pid,
  rows,
} from './test-helpers';

/**
 * Strings that belong only to living people: their names, event dates and
 * places, notes, citation pages, media titles and their families' event
 * details. Values shared with someone deceased (a surname, a town) are left
 * out, since those may legitimately appear.
 */
function livingOnlyStrings(store: TreeStore): string[] {
  const living = new Set(
    rows<{ id: string; living: LivingStatus }>(store, 'SELECT id, living FROM person')
      .filter((p) => isLiving(p.living))
      .map((p) => p.id),
  );
  const privateFamilies = new Set(
    rows<{ id: string; partner1_id: string | null; partner2_id: string | null }>(
      store,
      'SELECT id, partner1_id, partner2_id FROM family',
    )
      .filter((f) => living.has(f.partner1_id!) || living.has(f.partner2_id!))
      .map((f) => f.id),
  );
  const ownerIsPrivate = (type: string, id: string) =>
    (type === 'person' && living.has(id)) || (type === 'family' && privateFamilies.has(id));
  const strings = new Map<string, boolean>(); // value -> seen on a non-private owner
  const add = (value: unknown, isPrivate: boolean) => {
    if (typeof value !== 'string' || value.trim().length < 3) return;
    for (const part of value.split(/[^\p{L}\p{N}]+/u)) {
      if (part.length < 4) continue;
      strings.set(part, (strings.get(part) ?? false) || !isPrivate);
    }
  };
  for (const n of rows<Record<string, string>>(store, 'SELECT * FROM person_name')) {
    for (const f of ['given', 'full_text', 'nickname', 'surname'])
      add(n[f], living.has(n.person_id!));
  }
  const eventRows = rows<Record<string, string>>(
    store,
    `SELECT e.*, p.full_name AS place, r.person_id, r.family_id FROM event e
     JOIN event_role r ON r.event_id = e.id LEFT JOIN place p ON p.id = e.place_id`,
  );
  for (const e of eventRows) {
    const isPrivate = ownerIsPrivate(
      e.person_id ? 'person' : 'family',
      e.person_id ?? e.family_id!,
    );
    for (const f of ['date_text', 'place', 'value', 'description', 'age', 'cause', 'custom_type']) {
      add(e[f], isPrivate);
    }
  }
  const linked = (table: string, target: string, column: string, columns: string[]) => {
    for (const r of rows<Record<string, string>>(
      store,
      `SELECT l.owner_type, l.owner_id, t.* FROM ${table} l JOIN ${target} t ON t.id = l.${column}`,
    )) {
      const owner =
        r.owner_type === 'event'
          ? eventRows.find((e) => e.id === r.owner_id)
          : r.owner_type === 'person_name'
            ? {
                person_id: rows<{ person_id: string }>(
                  store,
                  'SELECT person_id FROM person_name WHERE id = ?',
                  r.owner_id,
                )[0]!.person_id,
              }
            : undefined;
      const isPrivate = owner
        ? ownerIsPrivate(owner.person_id ? 'person' : 'family', owner.person_id ?? owner.family_id!)
        : ownerIsPrivate(r.owner_type!, r.owner_id!);
      for (const c of columns) add(r[c], isPrivate);
    }
  };
  linked('note_link', 'note', 'note_id', ['text']);
  linked('citation_link', 'citation', 'citation_id', ['page', 'text', 'apid', 'url', 'date_text']);
  linked('media_link', 'media', 'media_id', ['title', 'remote_url', 'ancestry_oid', 'description']);
  // Every line the importer kept for a record (mapped or not, extension tags included):
  // words in a living person's or private family's record are theirs. Tags, xrefs and
  // bare numbers are left out; every record has those.
  for (const r of rows<Record<string, string>>(
    store,
    "SELECT owner_type, owner_id, raw_text FROM raw_record WHERE owner_type IN ('person', 'family')",
  )) {
    const words = r.raw_text!.split(/[^\p{L}\p{N}]+/u).filter((w) => !/^[A-Z0-9_]*$/.test(w));
    add(words.join(' '), ownerIsPrivate(r.owner_type!, r.owner_id!));
  }
  for (const u of rows<Record<string, string>>(
    store,
    "SELECT owner_type, owner_id, line FROM unmapped_line WHERE owner_type IN ('person', 'family')",
  )) {
    const words = u.line!.split(/[^\p{L}\p{N}]+/u).filter((w) => !/^[A-Z0-9_]*$/.test(w));
    add(words.join(' '), ownerIsPrivate(u.owner_type!, u.owner_id!));
  }
  // Records that are not about anyone in particular may repeat any of these words.
  for (const r of rows<Record<string, string>>(store, 'SELECT * FROM source')) {
    for (const c of ['title', 'author', 'publication', 'abbreviation', 'text', 'apid'])
      add(r[c], false);
  }
  for (const r of rows<{ raw_text: string }>(
    store,
    "SELECT raw_text FROM raw_record WHERE gedcom_tag IN ('HEAD', 'SUBM', 'SOUR', 'REPO')",
  ))
    add(r.raw_text, false);
  return [...strings].filter(([, shared]) => !shared).map(([s]) => s);
}

/** Whole-word occurrences, so a year does not match inside a record number. */
const leaks = (text: string, secrets: string[]) => {
  const words = new Set(text.split(/[^\p{L}\p{N}]+/u));
  return secrets.filter((s) => words.has(s));
};

const synthetic = ged(
  '0 @I1@ INDI',
  '1 NAME Zephyrine /Quellwater/',
  '1 SEX F',
  '1 BIRT',
  '2 DATE 3 MAR 1990',
  '2 PLAC Livingtown, Secret County',
  '1 OCCU Lighthouse keeper',
  '1 NOTE Zephyrine private diary entry',
  '1 SOUR @S1@',
  '2 PAGE living-only page 77',
  '1 OBJE',
  '2 FILE https://example.com/zephyrine-portrait.jpg',
  '2 TITL Zephyrine portrait',
  '1 _MTTAG @T1@',
  '1 _CUSTOMLIVING kept secret',
  '1 FAMC @F1@',
  '1 FAMS @F2@',
  '0 @I2@ INDI',
  '1 NAME Obadiah /Quellwater/',
  '1 SEX M',
  '1 BIRT',
  '2 DATE 1900',
  '1 DEAT',
  '2 DATE 1970',
  '1 NOTE Obadiah kept bees',
  '1 FAMS @F1@',
  '0 @I3@ INDI',
  '1 NAME Bartholomew /Inkwell/',
  '1 SEX M',
  '1 BIRT',
  '2 DATE 12 DEC 1988',
  '1 FAMS @F2@',
  '0 @F1@ FAM',
  '1 HUSB @I2@',
  '1 CHIL @I1@',
  '0 @F2@ FAM',
  '1 HUSB @I3@',
  '1 WIFE @I1@',
  '1 MARR',
  '2 DATE 14 FEB 2015',
  '2 PLAC Weddingville',
  '1 NOTE Eloped quietly',
  '0 @S1@ SOUR',
  '1 TITL Hidden register',
  '0 @T1@ _MTTAG',
  '1 NAME Living tag',
);

/**
 * Every kind of line a living person (I1) and their family (F2, with a living
 * partner) can have, each carrying a unique canary. I2 is deceased and shares
 * a note record, a media record and an unmapped pointer line with I1.
 */
const canaries = ged(
  '0 @I1@ INDI',
  '1 NAME Canaryone /Canarytwo/',
  '2 GIVN Canaryone',
  '2 NICK Canarynick',
  '2 NOTE Canaryname note',
  '2 _NAMEX Canarynamex',
  '1 SEX F',
  '1 BIRT',
  '2 DATE 3 MAR 1990',
  '2 PLAC Canaryplace, Canary County',
  '3 NOTE Canaryplacenote',
  '2 _EVX Canaryeventext',
  '2 SOUR @S1@',
  '3 PAGE Canarypage',
  '3 _APID 1,999::424242',
  '3 NOTE Canarycitationnote',
  '1 EVEN Canaryevenvalue',
  '2 TYPE Canaryeventype',
  '1 OCCU Canaryjob',
  '1 _MILT',
  '2 DATE 2010',
  '2 PLAC Canarybase',
  '1 RESI',
  '2 ADDR Canaryaddress',
  '1 NOTE Canarynote',
  '2 CONT Canarycont',
  '1 NOTE @N1@',
  '1 SOUR @S2@',
  '1 OBJE',
  '2 FILE https://example.com/canaryinline.jpg',
  '2 TITL Canaryinlinetitle',
  '1 OBJE @O1@',
  '2 _PRIM Y',
  '1 _PHOTO @O1@',
  '1 _MTTAG @T1@',
  '1 _TOPX Canarytopext',
  '2 _NESTED Canarynested',
  '1 ASSO @I2@',
  '2 RELA Canaryrela',
  '1 FAMC @F1@',
  '2 _FREL Adopted',
  '2 NOTE Canaryfamcnote',
  '1 FAMS @F2@',
  '0 @I2@ INDI',
  '1 NAME Elderdead /Elderline/',
  '1 BIRT',
  '2 DATE 1900',
  '1 DEAT',
  '2 DATE 1970',
  '1 NOTE @N1@',
  '1 OBJE @O1@',
  '1 FAMS @F1@',
  '0 @I3@ INDI',
  '1 NAME Canaryspouse /Canaryspousesur/',
  '1 BIRT',
  '2 DATE 1988',
  '1 FAMS @F2@',
  '0 @F1@ FAM',
  '1 HUSB @I2@',
  '1 CHIL @I1@',
  '2 _MREL Adopted',
  '0 @F2@ FAM',
  '1 HUSB @I3@',
  '1 WIFE @I1@',
  '1 MARR',
  '2 DATE 14 FEB 2015',
  '2 PLAC Canarywedding',
  '2 _MARX Canarymarriageext',
  '1 _FAMX Canaryfamext',
  '1 NOTE Canaryfamnote',
  '1 SOUR @S2@',
  '2 PAGE Canaryfampage',
  '1 OBJE @O2@',
  '0 @N1@ NOTE Canarysharednote',
  '0 @S1@ SOUR',
  '1 TITL Ordinary register',
  '0 @S2@ SOUR',
  '1 TITL Canarysource only living',
  '0 @O1@ OBJE',
  '1 FILE https://example.com/canarysharedphoto.jpg',
  '2 TITL Canarysharedtitle',
  '0 @O2@ OBJE',
  '1 FILE https://example.com/canaryfamphoto.jpg',
  '0 @T1@ _MTTAG',
  '1 NAME Canarytag',
);

describe('privatize living people', { timeout: 30_000 }, () => {
  it('writes no line of a living person, in any version, edited or not', async () => {
    const store = await importInto(canaries);
    // Regenerate every record through the edit path too, so merge-back runs everywhere.
    store.transact('Touch', (tx) => {
      for (const { id } of rows<{ id: string }>(store, 'SELECT id FROM person_name'))
        tx.update('person_name', id, { nickname: 'touched' });
      for (const { id } of rows<{ id: string }>(store, 'SELECT id FROM family'))
        tx.update('family', id, { privacy: 'private' });
    });
    const files: [string, string][] = [];
    for (const version of ['5.5.1', '7'] as const) {
      files.push([version, exportGedcom(store, { version, privatizeLiving: true, now: TODAY })]);
    }
    const zip = unzipSync(exportGedzip(store, { privatizeLiving: true, now: TODAY }));
    files.push(['gedzip', new TextDecoder().decode(zip['gedcom.ged'])]);
    for (const [version, out] of files) {
      expect(out.match(/canary\w*|424242|1990|2010|2015/gi) ?? [], version).toEqual([]);
      const doc = parseGedcom(out);
      for (const xref of ['@I1@', '@I3@']) {
        const tags = doc.index.get(xref)!.children.map((c) => c.tag);
        expect(new Set(tags), `${version} ${xref}`).toEqual(
          new Set(tags.filter((t) => ['NAME', 'SEX', 'FAMC', 'FAMS'].includes(t))),
        );
      }
      expect(
        doc.index.get('@F2@')!.children.map((c) => c.tag),
        version,
      ).toEqual(['HUSB', 'WIFE']);
      expect(out, version).toContain('Elderdead');
    }
    // Without privatize every canary is there, so the search above is meaningful.
    const plain = exportGedcom(store, { version: '5.5.1', now: TODAY });
    for (const c of [
      'Canarytopext',
      'Canarynested',
      'Canaryeventext',
      'Canarysharednote',
      'Canaryrela',
    ])
      expect(plain).toContain(c);
  });

  it('replaces living people with "Private" and keeps only their family links', async () => {
    const store = await importInto(synthetic);
    for (const version of ['5.5.1', '7'] as const) {
      const out = exportGedcom(store, { version, privatizeLiving: true, now: TODAY });
      for (const secret of [
        'Zephyrine',
        'Bartholomew',
        'Inkwell',
        '1990',
        '1988',
        'Livingtown',
        'Lighthouse',
        'diary',
        'living-only',
        'portrait',
        'Living tag',
        'kept secret',
        '2015',
        'Weddingville',
        'Eloped',
        'Hidden register',
      ]) {
        expect(out, `${version}: ${secret}`).not.toContain(secret);
      }
      const doc = parseGedcom(out);
      const zeph = doc.index.get('@I1@')!;
      expect(zeph.children.map((c) => `${c.tag} ${c.value ?? c.pointer ?? ''}`.trim())).toEqual([
        'NAME Private',
        'SEX F',
        'FAMC @F1@',
        'FAMS @F2@',
      ]);
      expect(doc.index.get('@F2@')!.children.map((c) => c.tag)).toEqual(['HUSB', 'WIFE']);
      // The home person (here the living first person) is not singled out.
      expect(out).not.toContain('_HOME');
      // The deceased father keeps his details.
      expect(out).toContain('Obadiah kept bees');
      expect(out).toContain('1 NAME Obadiah /Quellwater/');
      if (version === '7') expect(gedcom7Problems(out)).toEqual([]);
    }
  });

  it.each(FIXTURE_FILES)(
    '%s: no living-only value appears anywhere in the output',
    async (file) => {
      const store = await importInto(readFileSync(join(FIXTURES, file)));
      const secrets = livingOnlyStrings(store);
      if (file === 'ancestry-sample.ged') {
        expect(secrets).toEqual(
          expect.arrayContaining(['Margaret', 'Lily', 'Larkspur', 'Brackenridge', '2014', '1983']),
        );
      }
      // Without the option they are written (a CONC can split one across lines).
      if (secrets.length) {
        expect(leaks(exportGedcom(store, { now: TODAY }), secrets).length).toBeGreaterThan(0);
      }
      for (const version of ['5.5.1', '7'] as const) {
        const out = exportGedcom(store, { version, privatizeLiving: true, now: TODAY });
        expect(leaks(out, secrets), version).toEqual([]);
      }
    },
  );

  it('keeps living people as they are without the option', async () => {
    const store = await importInto(synthetic);
    expect(exportGedcom(store, { now: TODAY })).toContain('Zephyrine');
    expect(exportGedcom(store, { version: '7', now: TODAY })).toContain('Zephyrine');
  });

  it('GEDZIP: privatized archives leave out living people and their media', async () => {
    const store = await importInto(synthetic);
    const files = unzipSync(exportGedzip(store, { privatizeLiving: true, now: TODAY }));
    const text = new TextDecoder().decode(files['gedcom.ged']);
    expect(text).not.toContain('Zephyrine');
    expect(text).not.toContain('portrait');
    expect(pid(store, '@I1@')).toBeTruthy();
  });
});
