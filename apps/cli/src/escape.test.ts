import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escapeControls } from './escape';
import { run } from './main';

/*
 * Issue #97: text from a GEDCOM (warnings, unmapped lines, media paths, the
 * file name) must not reach the terminal with control characters in it.
 */

// Anything but tab and newline in C0, DEL, C1, and bidi controls.
const RAW_CONTROL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

describe('escapeControls', () => {
  it('makes control characters visible and keeps ordinary text, tabs and newlines', () => {
    expect(escapeControls('a\u001b[31mred\u0007\u009b')).toBe('a\\x1b[31mred\\x07\\x9b');
    expect(escapeControls('right‮left')).toBe('right\\u202eleft');
    expect(escapeControls('Zoë\tÅngström\nnext')).toBe('Zoë\tÅngström\nnext');
  });
});

describe('import report on the terminal', () => {
  it('prints no raw control characters from the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-escape-'));
    const evil = '\u001b]0;PWNED\u0007\u001b[31mRED\u001b[0m';
    const ged = [
      '0 HEAD',
      '1 CHAR UTF-8',
      `0 @I1@ INDI`,
      '1 NAME Ada /Vale/',
      `1 _EVIL ${evil}`,
      `1 OBJE`,
      `2 FILE \u001b[2J\u001b[Hfake${evil}.jpg`,
      `1 FAMC @F${evil}@`,
      '0 TRLR',
      '',
    ].join('\n');
    const file = join(dir, `family\u001b[2Jname.ged`);
    await writeFile(file, ged);
    const logs: string[] = [];
    await run(['import', file, '--name', 'Evil', '--library', join(dir, 'lib')], {
      log: (line) => logs.push(line),
      progress: () => {},
    });
    const out = logs.join('\n');
    expect(out).toContain('\\x1b');
    expect(out).not.toMatch(RAW_CONTROL);
  });
});
