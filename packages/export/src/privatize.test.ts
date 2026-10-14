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

describe('privatize living people', { timeout: 30_000 }, () => {
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
