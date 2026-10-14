import { describe, expect, it } from 'vitest';
import { importInto, personEvents, rows } from './test-helpers';

const ged7 = (...lines: string[]) =>
  ['0 HEAD', '1 GEDC', '2 VERS 7.0', ...lines, '0 TRLR', ''].join('\n');

describe('GEDCOM 7 phrases', () => {
  it('keeps a DATE PHRASE as the date as written, sorted by the phrase when it parses', async () => {
    const { store, report } = await importInto(
      ged7(
        '0 @I1@ INDI',
        '1 BIRT',
        '2 DATE ABT 1842',
        '3 PHRASE Abt. 1842',
        '1 DEAT',
        '2 DATE',
        '3 PHRASE the winter the river froze',
        '1 BURI',
        '2 DATE 1 JAN 1900',
        '3 PHRASE New Year after the funeral',
        '1 SOUR @S1@',
        '2 DATA',
        '3 DATE 28 MAY 1960',
        '4 PHRASE 05/28/1960',
        '0 @S1@ SOUR',
        '1 TITL Register',
      ),
    );
    const [birth, death, burial] = personEvents(store, '@I1@');
    expect(birth).toMatchObject({ date_text: 'Abt. 1842', date_qualifier: 'about' });
    expect(birth!.date_sort).toBeGreaterThan(18420000);
    expect(death).toMatchObject({
      date_text: 'the winter the river froze',
      date_qualifier: 'text',
      date_sort: null,
    });
    // An unparseable phrase keeps the sort key of the date beside it.
    expect(burial).toMatchObject({
      date_text: 'New Year after the funeral',
      date_qualifier: 'exact',
      date_sort: 19000101,
    });
    expect(rows(store, 'SELECT date_text FROM citation')).toEqual([{ date_text: '05/28/1960' }]);
    expect(report.lines.mapped + report.lines.preserved).toBe(report.lines.total);
    expect(report.unmapped).toEqual([]);
  });

  it('reads AGE and NAME TYPE phrases, and percent-decoded local FILE paths', async () => {
    const { store, report } = await importInto(
      ged7(
        '0 @I1@ INDI',
        '1 NAME Brother Ellis',
        '2 TYPE OTHER',
        '3 PHRASE Religious',
        '1 NAME Ellis /Vale/',
        '2 TYPE OTHER',
        '3 PHRASE Pen name',
        '1 DEAT',
        '2 AGE 25y',
        '3 PHRASE 25',
        '1 BURI',
        '2 AGE',
        '3 PHRASE infant',
        '1 OBJE @O1@',
        '0 @O1@ OBJE',
        '1 FILE photos/odile%20portrait.png',
        '2 FORM image/png',
      ),
    );
    expect(rows(store, 'SELECT type FROM person_name ORDER BY sort_order')).toEqual([
      { type: 'religious' },
      { type: 'other' },
    ]);
    expect(personEvents(store, '@I1@').map((e) => e.age)).toEqual(['25', 'infant']);
    expect(report.media.missing).toEqual([
      { path: 'photos/odile portrait.png', line: 19, xref: '@O1@' },
    ]);
  });

  it('leaves PHRASE alone in GEDCOM 5.5.1, where it is not a standard tag', async () => {
    const { store } = await importInto(
      [
        '0 HEAD',
        '1 GEDC',
        '2 VERS 5.5.1',
        '0 @I1@ INDI',
        '1 BIRT',
        '2 DATE 1842',
        '3 PHRASE Abt. 1842',
        '0 TRLR',
        '',
      ].join('\n'),
    );
    expect(personEvents(store, '@I1@')[0]).toMatchObject({ date_text: '1842' });
  });
});
