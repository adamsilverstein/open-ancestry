import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURES,
  citationsOf,
  familyEvents,
  fid,
  importInto,
  notesOf,
  personEvents,
  pid,
  rawText,
  row,
  rows,
  tagsOf,
  value,
  type Imported,
} from './test-helpers';

// Every quirk listed in fixtures/README.md for ancestry-sample.ged.
const bytes = readFileSync(join(FIXTURES, 'ancestry-sample.ged'));
let t: Imported;

beforeAll(async () => {
  t = await importInto(bytes);
});

describe('ancestry-sample.ged: report', () => {
  it('counts records and rows per type', () => {
    expect(t.report.records).toEqual({
      HEAD: 1,
      INDI: 26,
      FAM: 10,
      SOUR: 5,
      REPO: 1,
      OBJE: 2,
      _MTTAG: 2,
      SUBM: 1,
      TRLR: 1,
    });
    expect(t.report.rows).toMatchObject({
      person: 26,
      family: 10,
      source: 5,
      repository: 1,
      media: 2,
      tag: 2,
      raw_record: 49,
    });
    expect(value(t.store, 'SELECT count(*) FROM person')).toBe(26);
  });

  it('reads the Ancestry source system from the header', () => {
    expect(t.report.format).toBe('gedcom-5.5.1');
    expect(t.report.encoding).toBe('utf-8');
    expect(t.report.source).toEqual({
      system: 'Ancestry.com Family Trees',
      name: 'Ancestry.com Member Trees',
      version: '2024.12',
      corp: 'Ancestry.com',
      gedcomVersion: '5.5.1',
      ancestry: { treeName: 'Ashgrove Family Tree', treeId: '200000042', env: 'prd' },
    });
    const batch = row<Record<string, string>>(t.store, 'SELECT * FROM import_batch');
    expect(batch).toMatchObject({
      id: t.report.batchId,
      format: 'gedcom-5.5.1',
      source_software: 'Ancestry.com Family Trees',
      source_version: '2024.12',
      status: 'completed',
      file_sha256: t.report.file.sha256,
    });
    expect(JSON.parse(batch!.counts_json!)).toMatchObject({ records: { INDI: 26 } });
    expect(batch!.finished_at).toBeTruthy();
  });

  it('accounts for every line: only HEAD, SUBM and TRLR are preserved without mapping', () => {
    expect(t.report.lines).toEqual({ total: 475, mapped: 458, preserved: 17 });
    expect(t.report.unmapped).toEqual([]);
    expect(value(t.store, 'SELECT count(*) FROM unmapped_line')).toBe(0);
    expect(t.report.warnings).toEqual([]);
    expect(t.report.warningCount).toBe(0);
  });

  it('stores every record verbatim; concatenated raw text reproduces the file', () => {
    const text = bytes.toString('utf8').replace(/^﻿/, '');
    expect(rawText(t.store)).toBe(text);
    const raws = rows<{ gedcom_tag: string; xref: string | null; owner_type: string | null }>(
      t.store,
      'SELECT gedcom_tag, xref, owner_type FROM raw_record ORDER BY seq',
    );
    expect(raws[0]).toEqual({ gedcom_tag: 'HEAD', xref: null, owner_type: null });
    expect(raws.at(-1)).toEqual({ gedcom_tag: 'TRLR', xref: null, owner_type: null });
    expect(raws.find((r) => r.xref === '@SUBM1@')).toMatchObject({ owner_type: null });
    expect(raws.find((r) => r.xref === '@I1@')).toMatchObject({ owner_type: 'person' });
    expect(raws.find((r) => r.xref === '@T1@')).toMatchObject({ owner_type: 'tag' });
    const i1 = row<{ raw_text: string; owner_id: string }>(
      t.store,
      "SELECT raw_text, owner_id FROM raw_record WHERE xref = '@I1@'",
    );
    expect(i1!.owner_id).toBe(pid(t.store, '@I1@'));
    expect(i1!.raw_text.split('\n')).toHaveLength(24);
  });

  it('uses the first individual as home person (the header names none)', () => {
    expect(t.report.homePersonId).toBe(pid(t.store, '@I1@'));
    expect(t.report.homePersonSource).toBe('first-person');
    expect(value(t.store, "SELECT value FROM meta WHERE key = 'home_person_id'")).toBe(
      pid(t.store, '@I1@'),
    );
  });
});

describe('ancestry-sample.ged: people', () => {
  it('maps names with GIVN/SURN and phonetic surname keys', () => {
    const name = row<Record<string, unknown>>(
      t.store,
      'SELECT * FROM person_name WHERE person_id = ?',
      pid(t.store, '@I1@'),
    );
    expect(name).toMatchObject({
      given: 'Thaddeus',
      surname: 'Ashgrove',
      full_text: 'Thaddeus /Ashgrove/',
      type: 'birth',
      is_primary: 1,
      sort_order: 0,
    });
    expect(String(name!.surname_key)).toMatch(/A226/);
    expect(row(t.store, 'SELECT sex FROM person WHERE id = ?', pid(t.store, '@I1@'))).toEqual({
      sex: 'M',
    });
  });

  it('keeps the second NAME as a married name', () => {
    const names = rows(
      t.store,
      'SELECT given, surname, type, is_primary FROM person_name WHERE person_id = ? ORDER BY sort_order',
      pid(t.store, '@I11@'),
    );
    expect(names).toEqual([
      { given: 'Mabel', surname: 'Corran', type: 'birth', is_primary: 1 },
      { given: 'Mabel', surname: 'Ashgrove', type: 'married', is_primary: 0 },
    ]);
  });

  it('parses free-text and qualified dates, keeping the original text', () => {
    const birth = personEvents(t.store, '@I1@', 'BIRT')[0]!;
    expect(birth).toMatchObject({ date_text: 'Abt. 1842', date_qualifier: 'about' });
    expect(Math.floor(birth.date_sort! / 10000)).toBe(1842);
    expect(personEvents(t.store, '@I2@', 'DEAT')[0]).toMatchObject({
      date_text: 'BEF 1920',
      date_qualifier: 'before',
    });
    const between = personEvents(t.store, '@I4@', 'BIRT')[0]!;
    expect(between.date_qualifier).toBe('between');
    expect(Math.floor(between.date_sort_end! / 10000)).toBe(1872);
    expect(personEvents(t.store, '@I4@', 'DEAT')[0]!.date_qualifier).toBe('after');
    expect(personEvents(t.store, '@I5@', 'BIRT')[0]!.date_qualifier).toBe('calculated');
    expect(personEvents(t.store, '@I6@', 'BIRT')[0]!.date_qualifier).toBe('estimated');
    expect(personEvents(t.store, '@I18@', 'BIRT')[0]!.date_sort).toBe(19250905);
    expect(personEvents(t.store, '@I20@', 'BIRT')[0]!.date_sort).toBe(19600528);
    const decade = personEvents(t.store, '@I26@', 'RESI')[0]!;
    expect(decade.date_text).toBe('2010-2019');
    expect(Math.floor(decade.date_sort_end! / 10000)).toBe(2019);
  });

  it('maps EVEN with TYPE as a custom event, and OCCU with its value', () => {
    const events = personEvents(t.store, '@I1@');
    expect(events.map((e) => e.type)).toEqual(['BIRT', 'EVEN', 'OCCU', 'DEAT']);
    expect(events[1]).toMatchObject({
      custom_type: 'Arrival',
      date_text: '1866',
      place: 'Millbrook, Harlow County, Vermont, USA',
    });
    expect(events[2]).toMatchObject({ value: 'Cooper' });
    expect(events.every((e) => e.is_preferred === 1)).toBe(true);
  });

  it('maps citations with PAGE and _APID to their source and repository', () => {
    const death = personEvents(t.store, '@I1@', 'DEAT')[0]!;
    expect(citationsOf(t.store, 'event', death.id)).toEqual([
      {
        page: 'Find a Grave: Memorial #1000001',
        apid: '1,60525::1000001',
        url: null,
        quality: null,
        date_text: null,
        text: null,
        title: 'U.S., Find a Grave Index, 1600s-Current',
        source_apid: '1,60525::0',
      },
    ]);
    const census = personEvents(t.store, '@I3@', 'RESI')[0]!;
    expect(citationsOf(t.store, 'event', census.id)[0]).toMatchObject({
      apid: '1,7602::50000123',
      url: 'https://www.ancestry.com/search/collections/7602/',
      title: '1900 United States Federal Census',
    });
  });

  it('maps source records with AUTH, PUBL, REPO and _APID', () => {
    expect(
      rows(
        t.store,
        `SELECT s.title, s.author, s.publication, s.apid, r.name AS repo
         FROM source s LEFT JOIN repository r ON r.id = s.repository_id WHERE s.external_id = '@S4@'`,
      ),
    ).toEqual([
      {
        title: 'Ohio, U.S., County Marriage Records, 1774-1993',
        author: 'Ancestry.com',
        publication: 'Lehi, UT, USA: Ancestry.com Operations, Inc.',
        apid: '1,61378::0',
        repo: 'Ancestry.com',
      },
    ]);
  });

  it('attaches the structured census NOTE to the RESI event', () => {
    const resi = personEvents(t.store, '@I12@', 'RESI')[0]!;
    expect(notesOf(t.store, 'event', resi.id)).toEqual([
      'Marital Status: Single; Relation to Head of House: Son',
    ]);
  });

  it('joins CONC mid-word and CONT as a new line in person notes', () => {
    expect(notesOf(t.store, 'person', pid(t.store, '@I6@'))).toEqual([
      'Lavinia kept the family Bible, which records every birth in the Corran line from 1862 onward in her own hand.\nThe Bible later passed to her granddaughter Mabel.',
    ]);
  });

  it('maps _MILT with its note and citation', () => {
    const milt = personEvents(t.store, '@I9@', '_MILT')[0]!;
    expect(milt).toMatchObject({ date_text: '1917' });
    expect(notesOf(t.store, 'event', milt.id)).toEqual(['World War I draft registration']);
    expect(citationsOf(t.store, 'event', milt.id)[0]!.apid).toBe('1,6482::30000456');
  });

  it('maps _MTTAG records and pointers to tags', () => {
    expect(rows(t.store, 'SELECT name, category FROM tag ORDER BY name')).toEqual([
      { name: 'Brick Wall', category: 'Custom' },
      { name: 'Research Complete', category: 'Research Status' },
    ]);
    expect(tagsOf(t.store, 'person', pid(t.store, '@I1@'))).toEqual([
      'Research Status/Research Complete',
    ]);
    expect(tagsOf(t.store, 'person', pid(t.store, '@I9@'))).toEqual(['Custom/Brick Wall']);
  });

  it('links media placeholders with _OID, remote URL and primary photo (_PHOTO / _PRIM)', () => {
    const media = row<Record<string, unknown>>(
      t.store,
      "SELECT * FROM media WHERE external_id = '@O1@'",
    );
    expect(media).toMatchObject({
      kind: 'photo',
      mime: 'image/jpeg',
      local_path: null,
      remote_url:
        'https://mediasvc.ancestry.com/v2/image/namespaces/1093/media/0a1b2c3d-0000-4000-8000-000000000001.jpg?client=Trees',
      ancestry_oid: '0a1b2c3d-0000-4000-8000-000000000001',
      title: 'Thaddeus Ashgrove, about 1900',
    });
    expect(
      value(t.store, 'SELECT primary_media_id FROM person WHERE id = ?', pid(t.store, '@I1@')),
    ).toBe(media!.id);
    expect(
      rows(t.store, 'SELECT owner_type, owner_id FROM media_link WHERE media_id = ?', media!.id),
    ).toEqual([{ owner_type: 'person', owner_id: pid(t.store, '@I1@') }]);
    const mabel = value<string>(
      t.store,
      'SELECT primary_media_id FROM person WHERE id = ?',
      pid(t.store, '@I11@'),
    );
    expect(value(t.store, 'SELECT ancestry_oid FROM media WHERE id = ?', mabel)).toBe(
      '0a1b2c3d-0000-4000-8000-000000000002',
    );
    expect(t.report.media).toEqual({ linked: 0, remote: 2, missing: [], rejected: 0 });
  });

  it('infers living status (no death, born under 100 years ago)', () => {
    const living = rows<{ external_id: string }>(
      t.store,
      "SELECT external_id FROM person WHERE living = 'inferred_living' ORDER BY rowid",
    ).map((r) => r.external_id);
    expect(living.sort()).toEqual(
      ['@I19@', '@I20@', '@I21@', '@I22@', '@I23@', '@I24@', '@I25@', '@I26@'].sort(),
    );
    expect(value(t.store, "SELECT count(*) FROM person WHERE living = 'inferred_dead'")).toBe(18);
    expect(t.report.living).toEqual({ living: 8, deceased: 18 });
  });
});

describe('ancestry-sample.ged: places', () => {
  it('splits PLAC into a deduplicated hierarchy', () => {
    const leaf = row<{ id: string; name: string; parent_id: string }>(
      t.store,
      "SELECT * FROM place WHERE full_name = 'Elderford, Cask County, Ohio, USA'",
    )!;
    expect(leaf.name).toBe('Elderford');
    const chain: string[] = [];
    let id: string | null = leaf.id;
    while (id) {
      const p: { full_name: string; parent_id: string | null } = row(
        t.store,
        'SELECT full_name, parent_id FROM place WHERE id = ?',
        id,
      )!;
      chain.push(p.full_name);
      id = p.parent_id;
    }
    expect(chain).toEqual([
      'Elderford, Cask County, Ohio, USA',
      'Cask County, Ohio, USA',
      'Ohio, USA',
      'USA',
    ]);
    expect(
      value(
        t.store,
        "SELECT count(*) FROM place WHERE full_name = 'Elderford, Cask County, Ohio, USA'",
      ),
    ).toBe(1);
    // 11 distinct PLAC strings; shared upper levels (USA, Ohio, ...) appear once.
    expect(value(t.store, 'SELECT count(*) FROM place WHERE full_name = name')).toBe(4);
  });
});

describe('ancestry-sample.ged: families', () => {
  it('maps HUSB/WIFE and marriage events', () => {
    const f1 = row(
      t.store,
      "SELECT partner1_id, partner2_id, relationship_type FROM family WHERE external_id = '@F1@'",
    );
    expect(f1).toEqual({
      partner1_id: pid(t.store, '@I1@'),
      partner2_id: pid(t.store, '@I2@'),
      relationship_type: 'married',
    });
    expect(familyEvents(t.store, '@F1@', 'MARR')[0]).toMatchObject({
      date_text: 'ABT 1867',
      place: 'Millbrook, Harlow County, Vermont, USA',
    });
  });

  it('deduplicates MARR on INDI against the FAM marriage', () => {
    expect(personEvents(t.store, '@I3@', 'MARR')).toEqual([]);
    const marr = familyEvents(t.store, '@F3@', 'MARR');
    expect(marr).toHaveLength(1);
    expect(citationsOf(t.store, 'event', marr[0]!.id)[0]!.apid).toBe('1,61378::20000321');
    expect(value(t.store, "SELECT count(*) FROM event WHERE type = 'MARR'")).toBe(10);
  });

  it('orders a person with two spouses by FAMS', () => {
    const edith = pid(t.store, '@I10@');
    expect(
      rows(
        t.store,
        'SELECT external_id, partner2_order FROM family WHERE partner2_id = ? ORDER BY partner2_order',
        edith,
      ),
    ).toEqual([
      { external_id: '@F6@', partner2_order: 0 },
      { external_id: '@F7@', partner2_order: 1 },
    ]);
  });

  it('keeps two parent sets with step and natural relationships', () => {
    expect(
      rows(
        t.store,
        `SELECT f.external_id AS fam, c.partner1_rel, c.partner2_rel, c.child_order, c.is_preferred
         FROM family_child c JOIN family f ON f.id = c.family_id WHERE c.child_id = ? ORDER BY c.child_order`,
        pid(t.store, '@I15@'),
      ),
    ).toEqual([
      {
        fam: '@F6@',
        partner1_rel: 'biological',
        partner2_rel: 'biological',
        child_order: 0,
        is_preferred: 1,
      },
      {
        fam: '@F7@',
        partner1_rel: 'step',
        partner2_rel: 'biological',
        child_order: 1,
        is_preferred: 0,
      },
    ]);
  });

  it('marks an adopted child and keeps the ADOP event', () => {
    expect(
      row(
        t.store,
        'SELECT partner1_rel, partner2_rel FROM family_child WHERE child_id = ?',
        pid(t.store, '@I21@'),
      ),
    ).toEqual({ partner1_rel: 'adopted', partner2_rel: 'adopted' });
    expect(personEvents(t.store, '@I21@', 'ADOP')[0]).toMatchObject({ date_text: '1964' });
  });

  it('orders children by CHIL', () => {
    expect(
      rows<{ external_id: string }>(
        t.store,
        `SELECT p.external_id FROM family_child c JOIN person p ON p.id = c.child_id
         WHERE c.family_id = ? ORDER BY c.sort_order`,
        fid(t.store, '@F8@'),
      ).map((r) => r.external_id),
    ).toEqual(['@I19@', '@I20@', '@I21@']);
  });

  it('handles pedigree collapse: double first cousins share grandparents without cycle warnings', () => {
    const grandparents = (child: string) =>
      rows<{ p: string }>(
        t.store,
        `SELECT f.partner1_id AS p FROM family_child c JOIN family f ON f.id = c.family_id WHERE c.child_id = ?
         UNION SELECT f.partner2_id FROM family_child c JOIN family f ON f.id = c.family_id WHERE c.child_id = ?`,
        child,
        child,
      ).map((r) => r.p);
    const walterParents = grandparents(pid(t.store, '@I9@'));
    const mabelParents = grandparents(pid(t.store, '@I11@'));
    const greatGrandparents = (parents: string[]) => new Set(parents.flatMap(grandparents));
    const shared = [...greatGrandparents(walterParents)].filter((p) =>
      greatGrandparents(mabelParents).has(p),
    );
    expect(shared.sort()).toEqual(
      [
        pid(t.store, '@I1@'),
        pid(t.store, '@I2@'),
        pid(t.store, '@I5@'),
        pid(t.store, '@I6@'),
      ].sort(),
    );
    expect(t.report.warnings.filter((w) => w.code === 'relationship-cycle')).toEqual([]);
  });
});
