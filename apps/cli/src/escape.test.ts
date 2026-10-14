import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryTree } from '@open-ancestry/db';
import { importGedcom } from '@open-ancestry/import';
import { describe, expect, it } from 'vitest';
import { escapeControls } from './escape';
import { exposureWarning, formatReport, main, run } from './main';

/*
 * Issue #97: text from a GEDCOM (warnings, unmapped lines, media paths, the
 * file name) must not reach the terminal with control characters in it, nor
 * with newlines that would forge report lines.
 */

// C0 (except the report's own newlines), DEL, C1, bidi and invisible format characters.
const RAW_CONTROL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

describe('escapeControls', () => {
  it('makes control, bidi and invisible characters visible, newlines and tabs too', () => {
    expect(escapeControls('a\u001b[31mred\u0007\u009b')).toBe('a\\x1b[31mred\\x07\\x9b');
    expect(escapeControls('right\u202eleft\u061c\u200b\ufeff')).toBe(
      'right\\u202eleft\\u061c\\u200b\\ufeff',
    );
    expect(escapeControls('two\nlines\tand\r')).toBe('two\\nlines\\tand\\r');
    expect(escapeControls('Zoë Ångström 李')).toBe('Zoë Ångström 李');
  });
});

async function evilImport(fileName: string, ged: string) {
  const dir = await mkdtemp(join(tmpdir(), 'oa-escape-'));
  const file = join(dir, fileName);
  await writeFile(file, ged);
  const logs: string[] = [];
  await run(['import', file, '--name', 'Evil', '--library', join(dir, 'lib')], {
    log: (line) => logs.push(line),
    progress: () => {},
  });
  return logs.join('\n');
}

describe('import report on the terminal', () => {
  it('prints no raw control characters from the file', async () => {
    const evil = '\u001b]0;PWNED\u0007\u001b[31mRED\u001b[0m\u202e';
    const out = await evilImport(
      `family\u001b[2Jname.ged`,
      [
        '0 HEAD',
        '1 CHAR UTF-8',
        '0 @I1@ INDI',
        '1 NAME Ada /Vale/',
        `1 _EVIL ${evil}`,
        '1 OBJE',
        `2 FILE \u001b[2J\u001b[Hfake${evil}.jpg`,
        `1 FAMC @F${evil}@`,
        '0 TRLR',
        '',
      ].join('\n'),
    );
    expect(out).toContain('\\x1b');
    expect(out).not.toMatch(RAW_CONTROL);
  });

  it('cannot forge report lines with newlines in the file or its name', async () => {
    const out = await evilImport(
      'family\nPeople         999.ged',
      [
        '0 HEAD',
        '1 CHAR UTF-8',
        '0 @I1@ INDI',
        '1 OBJE',
        '2 FILE photo.jpg',
        '3 CONT ',
        '3 CONT People         999',
        '3 CONT Warnings       none',
        '0 TRLR',
        '',
      ].join('\n'),
    );
    const lines = out.split('\n');
    expect(lines.filter((l) => l.startsWith('People'))).toEqual(['People         1']);
    expect(lines.filter((l) => l.startsWith('Warnings'))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith('Importing ') && l.includes('\\nPeople'))).toBe(true);
  });

  it('prints a normal report exactly as before', async () => {
    const report = await importGedcom(
      {
        bytes: [
          '0 HEAD',
          '1 SOUR Ancestry.com Family Trees',
          '2 VERS 2024.12',
          '1 GEDC',
          '2 VERS 5.5.1',
          '1 CHAR UTF-8',
          '0 @I1@ INDI',
          '1 NAME Ada /Vale/',
          '1 BIRT',
          '2 DATE 1 JAN 1900',
          '2 PLAC Elderford, Ohio',
          '1 _ODD kept as is',
          '1 FAMS @F9@',
          '0 TRLR',
          '',
        ].join('\n'),
        fileName: 'vale.ged',
      },
      openMemoryTree(),
      { today: new Date('2026-10-14T12:00:00Z') },
    );
    report.timings.total = 1234;
    expect(
      formatReport(report, {
        name: 'Vale family',
        dir: '/lib/Vale family.oatree',
        homePerson: 'Ada Vale',
      }),
    ).toMatchInlineSnapshot(`
      "Imported vale.ged into "Vale family" (/lib/Vale family.oatree) in 1.2s

      Source         Ancestry.com Family Trees 2024.12 (gedcom-5.5.1, utf-8)
      People         1
      Families       0
      Events         1
      Places         2
      Sources        0
      Citations      0
      Notes          0
      Media          0 linked, 0 remote, 0 missing, 0 refused (0 records)
      Lines          14 (5 mapped, 9 preserved)
      Living         0 living, 1 deceased
      Home person    Ada Vale
      Warnings       1
        line 13    bad-pointer           FAMS points to @F9@, which does not exist
      Unmapped tags  2
        INDI._ODD                   1      line 12: 1 _ODD kept as is
        INDI.FAMS                   1      line 13: 1 FAMS @F9@"
    `);
  });
});

describe('messages that echo input', () => {
  it('escapes an error message before printing it, and exits 1', async () => {
    const errors: string[] = [];
    const code = await main(
      ['import', '/nowhere/\u001b[2Jx.ged', '--media', '/nope\u001b]0;t\u0007'],
      {
        error: (line) => errors.push(line),
        log: () => {},
      },
    );
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('\\x1b');
    expect(errors.join('\n')).not.toMatch(RAW_CONTROL);
  });

  it('escapes the host echoed in the exposure warning', () => {
    const warning = exposureWarning('evil\u001b[2J\nhost');
    expect(warning).toContain('evil\\x1b[2J\\nhost');
    expect(warning.split('\n').filter((l) => l.includes('WARNING'))).toHaveLength(1);
  });
});
