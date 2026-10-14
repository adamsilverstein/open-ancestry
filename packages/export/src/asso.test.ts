import { describe, expect, it } from 'vitest';
import { buildGedcomExport } from './index';
import { TODAY, ged, gedcom7Problems, importInto, recordText } from './test-helpers';

const assoTree = ged(
  '0 @I1@ INDI',
  '1 NAME Odile /Fernsby/',
  '1 ASSO @I2@',
  '2 RELA Godfather',
  '0 @I2@ INDI',
  '1 NAME Bastien /Corlew/',
  '0 @I3@ INDI',
  '1 NAME Mirelle /Fernsby/',
  '1 ASSO @I2@',
  '2 RELA Lodge brother',
  '1 ASSO @I1@',
);

describe('associations (ASSO)', () => {
  it('writes 5.5.1 RELA as a GEDCOM 7 ROLE with the text as PHRASE', async () => {
    const store = await importInto(assoTree);
    const out = buildGedcomExport(store, { version: '7', now: TODAY });
    expect(out.warnings).toEqual([]);
    expect(gedcom7Problems(out.text)).toEqual([]);
    expect(recordText(out.text, '@I1@')).toContain('1 ASSO @I2@\n2 ROLE GODP\n3 PHRASE Godfather');
    const mirelle = recordText(out.text, '@I3@')!;
    expect(mirelle).toContain('1 ASSO @I2@\n2 ROLE OTHER\n3 PHRASE Lodge brother');
    // GEDCOM 7 requires a ROLE; an ASSO without RELA gets OTHER.
    expect(mirelle).toContain('1 ASSO @I1@\n2 ROLE OTHER');
  });

  it('round-trips through GEDCOM 7 back to the same 5.5.1 RELA', async () => {
    const store = await importInto(assoTree);
    const seven = buildGedcomExport(store, { version: '7', now: TODAY }).text;
    const back = buildGedcomExport(await importInto(seven), { version: '5.5.1', now: TODAY });
    expect(back.warnings).toEqual([]);
    expect(recordText(back.text, '@I1@')).toContain('1 ASSO @I2@\n2 RELA Godfather');
    const mirelle = recordText(back.text, '@I3@')!;
    expect(mirelle).toContain('1 ASSO @I2@\n2 RELA Lodge brother');
    expect(mirelle).toMatch(/1 ASSO @I1@(?!\n2 RELA)/);
    // And to GEDCOM 7 again, unchanged.
    const again = buildGedcomExport(await importInto(back.text), { version: '7', now: TODAY });
    expect(recordText(again.text, '@I1@')).toBe(recordText(seven, '@I1@'));
    expect(recordText(again.text, '@I3@')).toBe(recordText(seven, '@I3@'));
  });

  it('keeps a repeated association and repeated contact lines as they were', async () => {
    const store = await importInto(
      ged(
        '0 @I1@ INDI',
        '1 NAME Odile /Fernsby/',
        '1 ASSO @I2@',
        '1 ASSO @I2@',
        '0 @I2@ INDI',
        '1 NAME Bastien /Corlew/',
        '0 @R1@ REPO',
        '1 NAME County archive',
        '1 EMAIL a@archive.example',
        '1 EMAIL b@archive.example',
        '1 PHON 555-0100',
        '1 PHON 555-0101',
        '1 WWW https://a.example',
        '1 WWW https://b.example',
      ),
    );
    store.db.exec("DELETE FROM raw_record WHERE gedcom_tag IN ('HEAD', 'TRLR')");
    for (const version of ['5.5.1', '7'] as const) {
      // Regenerate every record (no verbatim copy) so the merge-back path runs.
      const out = buildGedcomExport(store, { version, now: TODAY, includeMedia: false });
      expect(out.warnings, version).toEqual([]);
      expect(recordText(out.text, '@I1@')!.match(/^1 ASSO @I2@$/gm), version).toHaveLength(2);
      const repo = recordText(out.text, '@R1@')!;
      for (const line of ['b@archive.example', '555-0101', 'https://b.example']) {
        expect(repo, `${version} ${line}`).toContain(line);
      }
    }
  });
});
