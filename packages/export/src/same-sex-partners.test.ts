import { describe, expect, it } from 'vitest';
import { buildGedcomExport } from './index';
import { TODAY, ged, importInto, recordText, rows } from './test-helpers';

/*
 * Issue #273: a regenerated 5.5.1 family wrote partner1 as HUSB and partner2
 * as WIFE whatever their sex, so a two-HUSB family came out HUSB + WIFE.
 */

const family = (sex1: string, sex2: string, tags: [string, string]) =>
  ged(
    '0 @I1@ INDI',
    '1 NAME A /B/',
    ...(sex1 ? [`1 SEX ${sex1}`] : []),
    '1 FAMS @F1@',
    '0 @I2@ INDI',
    '1 NAME C /D/',
    ...(sex2 ? [`1 SEX ${sex2}`] : []),
    '1 FAMS @F1@',
    '0 @F1@ FAM',
    `1 ${tags[0]} @I1@`,
    `1 ${tags[1]} @I2@`,
  );

/** The partner lines of @F1@ in a 5.5.1 export regenerated from the database. */
async function partners(text: string): Promise<string[]> {
  const store = await importInto(text);
  // Force the family through the canonical writer, as any edit to it would.
  store.db.exec('DELETE FROM raw_record');
  const out = buildGedcomExport(store, { version: '5.5.1', now: TODAY });
  return recordText(out.text, '@F1@')!
    .split('\n')
    .filter((l) => /^1 (HUSB|WIFE) /.test(l));
}

describe('5.5.1 same-sex couples keep their partner tags (#273)', () => {
  it('does not write a male partner of a two-HUSB family as WIFE', async () => {
    expect(await partners(family('M', 'M', ['HUSB', 'HUSB']))).toEqual([
      '1 HUSB @I1@',
      '1 HUSB @I2@',
    ]);
  });

  it('round-trips a two-WIFE family', async () => {
    expect(await partners(family('F', 'F', ['WIFE', 'WIFE']))).toEqual([
      '1 WIFE @I1@',
      '1 WIFE @I2@',
    ]);
  });

  it('writes a woman listed first as WIFE and a man second as HUSB', async () => {
    expect(await partners(family('F', 'M', ['WIFE', 'HUSB']))).toEqual([
      '1 HUSB @I2@',
      '1 WIFE @I1@',
    ]);
  });

  it("keeps HUSB + WIFE when a partner's sex is unknown", async () => {
    expect(await partners(family('', 'M', ['HUSB', 'WIFE']))).toEqual([
      '1 HUSB @I1@',
      '1 WIFE @I2@',
    ]);
  });

  it("keeps a lone partner's slot tag", async () => {
    const text = ged(
      '0 @I1@ INDI',
      '1 NAME A /B/',
      '1 SEX F',
      '1 FAMS @F1@',
      '0 @F1@ FAM',
      '1 WIFE @I1@',
    );
    expect(await partners(text)).toEqual(['1 WIFE @I1@']);
  });

  it.each([
    ['HUSB + HUSB', 'M', 'M', ['HUSB', 'HUSB']],
    ['WIFE + WIFE', 'F', 'F', ['WIFE', 'WIFE']],
  ] as const)('round-trips %s through export and re-import', async (_, sex1, sex2, tags) => {
    const store = await importInto(family(sex1, sex2, [...tags]));
    store.db.exec('DELETE FROM raw_record');
    const slots = (s: typeof store) =>
      rows<{ p1: string; p2: string }>(
        s,
        `SELECT n1.given AS p1, n2.given AS p2 FROM family f
           JOIN person_name n1 ON n1.person_id = f.partner1_id
           JOIN person_name n2 ON n2.person_id = f.partner2_id`,
      );
    const first = buildGedcomExport(store, { version: '5.5.1', now: TODAY }).text;
    const again = await importInto(first);
    expect(slots(again)).toEqual(slots(store));
    again.db.exec('DELETE FROM raw_record');
    expect(buildGedcomExport(again, { version: '5.5.1', now: TODAY }).text).toBe(first);
  });
});
