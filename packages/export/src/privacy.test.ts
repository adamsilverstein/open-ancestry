import { openTree, treePaths } from '@open-ancestry/db';
import { importGedcom } from '@open-ancestry/import';
import { unzipSync, zipSync } from 'fflate';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGedcomExport, buildGedzipExport } from './index';
import { TODAY, gedcom7Problems, importInto } from './test-helpers';

/*
 * Privatize beyond living people (security review 2026-10-14): records marked
 * private, confidential or locked, name-like xrefs, imported lines pointing at
 * withheld people, files shared with withheld media, and the tree name.
 * Every secret carries "canary" so one search finds any leak.
 */

const lines = [
  '0 HEAD',
  '1 SOUR Ancestry.com Family Trees',
  '2 DATA Canaryfamilyname Family Tree',
  '1 GEDC',
  '2 VERS 5.5.1',
  '1 CHAR UTF-8',
  // Living, with a name-like xref.
  '0 @ZELDAQUIXBY@ INDI',
  '1 NAME Zelda /Canaryquixby/',
  '1 BIRT',
  '2 DATE 1990',
  '1 OBJE @O1@',
  '1 FAMS @F1@',
  // Deceased but confidential.
  '0 @I2@ INDI',
  '1 NAME Conrad /Canaryconfidential/',
  '1 RESN confidential',
  '1 BIRT',
  '2 DATE 1860',
  '2 PLAC Canaryconfidentialtown',
  '1 DEAT',
  '2 DATE 1930',
  '1 NOTE Canaryconfidentialnote',
  '1 FAMS @F1@',
  // Deceased and public, with a private event and an association to the living person.
  '0 @I3@ INDI',
  '1 NAME Petra /Publicwell/',
  '1 BIRT',
  '2 DATE 1850',
  '1 DEAT',
  '2 DATE 1920',
  '1 EVEN Canaryprivateeventvalue',
  '2 TYPE Canaryprivateevent',
  '2 RESN privacy',
  '2 PLAC Canaryprivateplace',
  '1 ASSO @ZELDAQUIXBY@',
  '2 RELA Canarygodchild',
  '1 OBJE @O2@',
  // A confidential family.
  '0 @Mill_Family@ FAM',
  '1 HUSB @I3@',
  '1 RESN confidential',
  '1 MARR',
  '2 DATE 1875',
  '2 PLAC Canaryconfidentialwedding',
  // Locked means "do not edit", not private: this ancestor is exported in full.
  '0 @I4@ INDI',
  '1 NAME Lockedancestor /Oldline/',
  '1 RESN locked',
  '1 BIRT',
  '2 DATE 1801',
  '2 PLAC Lockedtown',
  '1 DEAT',
  '2 DATE 1870',
  '0 @F1@ FAM',
  '1 HUSB @I2@',
  '1 WIFE @ZELDAQUIXBY@',
  // The living person's portrait, and a byte-identical copy linked to the public person.
  '0 @O1@ OBJE',
  '1 FILE photos/canary-zelda-portrait.png',
  '2 FORM png',
  '0 @O2@ OBJE',
  '1 FILE photos/copy.png',
  '2 FORM png',
  '0 TRLR',
  '',
];

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function tree() {
  const root = mkdtempSync(join(tmpdir(), 'oa-privacy-'));
  dirs.push(root);
  const dir = join(root, 'Canaryfamilyname.oatree');
  const archive = zipSync({
    'gedcom.ged': new TextEncoder().encode(lines.join('\n')),
    'photos/canary-zelda-portrait.png': PNG,
    'photos/copy.png': PNG,
  });
  await importGedcom({ gedzip: archive }, { dir }, { today: TODAY });
  return openTree(dir);
}

const canaries = (text: string) => text.match(/canary\w*|zelda\w*|quixby|mill_family/gi) ?? [];

describe('privatized exports withhold every marked record', () => {
  it('5.5.1, 7 and GEDZIP carry no canary, in the file or the warnings', async () => {
    const store = await tree();
    // Both photos really are one file in the tree (the importer stores identical bytes once).
    expect(treePaths(store.dir!).media).toBeTruthy();
    for (const version of ['5.5.1', '7'] as const) {
      const out = buildGedcomExport(store, { version, privatizeLiving: true, now: TODAY });
      expect(canaries(out.text), version).toEqual([]);
      expect(canaries(out.warnings.join('\n')), version).toEqual([]);
      expect(out.warnings, version).toContain(
        '@I3@: an imported ASSO line (INDI.ASSO) was not carried over',
      );
      if (version === '7') expect(gedcom7Problems(out.text)).toEqual([]);
      // The deceased public person keeps their own details, and so does a locked one.
      expect(out.text, version).toContain('Petra /Publicwell/');
      expect(out.text, version).toContain('Lockedancestor /Oldline/');
      expect(out.text, version).toContain('Lockedtown');
    }
    const zip = buildGedzipExport(store, { privatizeLiving: true, now: TODAY });
    const files = unzipSync(zip.bytes);
    expect(canaries(Object.keys(files).join('\n'))).toEqual([]);
    expect(canaries(new TextDecoder().decode(files['gedcom.ged']))).toEqual([]);
    expect(canaries(zip.warnings.join('\n'))).toEqual([]);
    store.close();
  });

  it('writes private and confidential people and families like living ones', async () => {
    const store = await tree();
    const out = buildGedcomExport(store, { version: '7', privatizeLiving: true, now: TODAY }).text;
    const records = out.split(/\n(?=0 )/);
    const tags = (record: string) =>
      record
        .split('\n')
        .slice(1)
        .map((l) => l.split(' ').slice(0, 2).join(' '));
    // Conrad (confidential) is "Private" with family links only.
    expect(out).not.toContain('Conrad');
    // Both families (one confidential, one with a living and a confidential partner) keep links only.
    for (const f of records.filter((r) => / FAM$/.test(r.split('\n')[0]!))) {
      expect(
        tags(f).every((t) => /^1 (HUSB|WIFE|CHIL)$/.test(t)),
        f,
      ).toBe(true);
    }
    // Petra is public: her private event goes, the rest stays.
    const petra = records.find((r) => r.includes('Petra'))!;
    expect(tags(petra)).toEqual([
      '1 NAME',
      '2 GIVN',
      '2 SURN',
      '1 BIRT',
      '2 DATE',
      '1 DEAT',
      '2 DATE',
      '1 FAMS',
    ]);
    store.close();
  });

  it('renumbers every xref, so imported ids cannot name anyone', async () => {
    const store = await tree();
    for (const version of ['5.5.1', '7'] as const) {
      const out = buildGedcomExport(store, { version, privatizeLiving: true, now: TODAY }).text;
      const xrefs = [...out.matchAll(/@[^@\s]+@/g)].map((m) => m[0]);
      expect(
        xrefs.every((x) => /^@(I|F|S|R|O|N|T|SUBM)\d+@$/.test(x)),
        xrefs.join(' '),
      ).toBe(true);
      const again = await importInto(out);
      expect(again.db.prepare('SELECT count(*) FROM person').pluck().get()).toBe(4);
    }
    // Without privatize the imported xrefs stay (verbatim records still point at them).
    expect(buildGedcomExport(store, { now: TODAY }).text).toContain('@ZELDAQUIXBY@');
    store.close();
  });

  it('leaves the tree name out of the header', async () => {
    const store = await tree();
    const out = buildGedcomExport(store, { privatizeLiving: true, now: TODAY }).text;
    expect(out).not.toContain('Canaryfamilyname');
    expect(out).toMatch(/^1 SOUR open-ancestry\n2 NAME open-ancestry\n1 DATE/m);
    expect(buildGedcomExport(store, { now: TODAY }).text).toContain('Canaryfamilyname');
    store.close();
  });
});
