import { describe, expect, it, vi } from 'vitest';
import { LineSplitter } from './tokenizer';
import { parseGedcom, parseGedcomStream, subtreeLines } from './parser';
import type { GedcomNode, ParseResult } from './types';

const ged = (...lines: string[]) => lines.join('\n') + '\n';
const codes = (r: ParseResult) => r.warnings.map((w) => w.code);
const find = (node: GedcomNode | undefined, ...tags: string[]): GedcomNode | undefined =>
  tags.reduce<GedcomNode | undefined>((n, t) => n?.children.find((c) => c.tag === t), node);

const minimal = ged(
  '0 HEAD',
  '1 GEDC',
  '2 VERS 5.5.1',
  '0 @I1@ INDI',
  '1 NAME Ann /Ash/',
  '0 TRLR',
);

describe('parseGedcom: record tree', () => {
  it('builds records with children, xrefs, pointers and line numbers', () => {
    const result = parseGedcom(
      ged(
        '0 HEAD',
        '1 GEDC',
        '2 VERS 5.5.1',
        '0 @I1@ INDI',
        '1 NAME Ann /Ash/',
        '2 GIVN Ann',
        '1 FAMS @F1@',
        '0 @F1@ FAM',
        '1 WIFE @I1@',
        '0 TRLR',
      ),
    );
    expect(result.records.map((r) => r.tag)).toEqual(['HEAD', 'INDI', 'FAM', 'TRLR']);
    const indi = result.index.get('@I1@');
    expect(indi).toMatchObject({ level: 0, xref: '@I1@', tag: 'INDI', line: 4 });
    expect(find(indi, 'NAME')).toMatchObject({ value: 'Ann /Ash/', line: 5 });
    expect(find(indi, 'NAME', 'GIVN')).toMatchObject({ value: 'Ann', line: 6 });
    expect(find(indi, 'FAMS')).toMatchObject({ pointer: '@F1@', line: 7 });
    expect(find(indi, 'FAMS')?.value).toBeUndefined();
    expect(result.index.get('@F1@')?.tag).toBe('FAM');
    expect(result.warnings).toEqual([]);
  });

  it('accepts a string as input', () => {
    expect(parseGedcom(minimal).records).toHaveLength(3);
  });

  it('parses CRLF, CR and mixed line endings identically', () => {
    const lf = parseGedcom(minimal).records;
    expect(parseGedcom(minimal.replaceAll('\n', '\r\n')).records).toEqual(lf);
    expect(parseGedcom(minimal.replaceAll('\n', '\r')).records).toEqual(lf);
  });

  it('accepts leading whitespace and lines over 255 characters', () => {
    const long = 'word '.repeat(200);
    const result = parseGedcom(ged('0 HEAD', '  0 @I1@ INDI', `    1 NOTE ${long}`, '0 TRLR'));
    expect(find(result.index.get('@I1@'), 'NOTE')?.value).toBe(long);
    expect(result.warnings).toEqual([]);
  });

  it('reads a pointer written with extra spaces around it as a pointer', () => {
    const r = parseGedcom(ged('0 @I1@ INDI', '1 ASSO  @I2@ ', '2 RELA Friend', '1 FAMS\t@F1@'));
    const indi = r.records[0]!;
    expect(indi.children[0]).toMatchObject({ tag: 'ASSO', pointer: '@I2@' });
    expect(indi.children[0]!.value).toBeUndefined();
    expect(indi.children[1]).toMatchObject({ tag: 'FAMS', pointer: '@F1@' });
  });

  it('parses @VOID@ and keeps @#D calendar escapes as text', () => {
    const result = parseGedcom(
      ged('0 HEAD', '0 @F1@ FAM', '1 HUSB @VOID@', '1 MARR', '2 DATE @#DJULIAN@ 1700', '0 TRLR'),
    );
    const fam = result.index.get('@F1@');
    expect(find(fam, 'HUSB')?.pointer).toBe('@VOID@');
    expect(find(fam, 'MARR', 'DATE')?.value).toBe('@#DJULIAN@ 1700');
  });
});

describe('parseGedcom: CONC and CONT', () => {
  it('merges CONC without a separator and CONT with a newline', () => {
    const result = parseGedcom(
      ged(
        '0 HEAD',
        '0 @I1@ INDI',
        '1 NOTE Lavinia kept the Bible from 18',
        '2 CONC 62 onward.',
        '2 CONT It passed to Mabel.',
        '2 CONT',
        '2 CONC  End.',
        '1 SEX F',
        '0 TRLR',
      ),
    );
    const note = find(result.index.get('@I1@'), 'NOTE');
    expect(note?.value).toBe(
      'Lavinia kept the Bible from 1862 onward.\nIt passed to Mabel.\n End.',
    );
    expect(note?.children).toEqual([]);
    expect(note?.continuations?.map((c) => [c.tag, c.line])).toEqual([
      ['CONC', 4],
      ['CONT', 5],
      ['CONT', 6],
      ['CONC', 7],
    ]);
    expect(find(result.index.get('@I1@'), 'SEX')?.line).toBe(8);
    expect(result.lines).toMatchObject({ total: 9, nodes: 5, continuations: 4 });
  });

  it('keeps CONC after other children as a normal child with a warning', () => {
    const result = parseGedcom(
      ged('0 HEAD', '0 @N1@ NOTE start', '1 SOUR @S1@', '1 CONC late', '0 TRLR'),
    );
    const note = result.index.get('@N1@');
    expect(note?.value).toBe('start');
    expect(note?.children.map((c) => c.tag)).toEqual(['SOUR', 'CONC']);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'misplaced-continuation', line: 4 }),
    );
  });

  it('merges continuations into pointer nodes without losing the pointer', () => {
    const result = parseGedcom(ged('0 HEAD', '0 @I1@ INDI', '1 NOTE @N1@', '2 CONT x', '0 TRLR'));
    expect(find(result.index.get('@I1@'), 'NOTE')).toMatchObject({ pointer: '@N1@', value: '\nx' });
  });
});

describe('parseGedcom: Ancestry broken lines', () => {
  it('treats bare text lines as CONT of the previous line (python-gedcom quirk)', () => {
    const result = parseGedcom(
      ged(
        '0 HEAD',
        '0 @I1@ INDI',
        '1 NOTE First line',
        'second line written without CONT',
        '',
        '1850 was a hard year',
        '1 SEX F',
        '0 TRLR',
      ),
    );
    const note = find(result.index.get('@I1@'), 'NOTE');
    expect(note?.value).toBe(
      'First line\nsecond line written without CONT\n\n1850 was a hard year',
    );
    expect(note?.continuations?.every((c) => c.broken && c.tag === 'CONT')).toBe(true);
    expect(result.warnings.filter((w) => w.code === 'broken-line').map((w) => w.line)).toEqual([
      4, 5, 6,
    ]);
    expect(result.lines).toMatchObject({ total: 8, continuations: 3, blank: 0 });
  });

  it('counts blank lines that are not followed by broken text as blank', () => {
    const result = parseGedcom('0 HEAD\n\n0 @I1@ INDI\n\n\n0 TRLR\n\n');
    expect(result.lines).toEqual({
      total: 7,
      nodes: 3,
      continuations: 0,
      blank: 4,
      skipped: 0,
      detached: 0,
    });
    expect(result.warnings).toEqual([]);
  });
});

describe('parseGedcom: escapes', () => {
  it('decodes every @@ in GEDCOM 5.5.1 and keeps the raw value', () => {
    const result = parseGedcom(ged('0 HEAD', '0 @I1@ INDI', '1 EMAIL ann@@example.com', '0 TRLR'));
    expect(find(result.index.get('@I1@'), 'EMAIL')).toMatchObject({
      value: 'ann@example.com',
      rawValue: 'ann@@example.com',
    });
  });

  it('leaves a lone @ (a common 5.5.1 violation) alone', () => {
    const result = parseGedcom(ged('0 HEAD', '0 @I1@ INDI', '1 EMAIL ann@example.com', '0 TRLR'));
    const email = find(result.index.get('@I1@'), 'EMAIL');
    expect(email?.value).toBe('ann@example.com');
    expect(email?.rawValue).toBe('ann@example.com');
  });

  it('decodes only a leading @@ in GEDCOM 7', () => {
    const result = parseGedcom(
      ged('0 HEAD', '1 GEDC', '2 VERS 7.0', '0 @I1@ INDI', '1 NOTE @@me and a@@b', '0 TRLR'),
    );
    expect(find(result.index.get('@I1@'), 'NOTE')?.value).toBe('@me and a@@b');
  });
});

describe('parseGedcom: malformed input never throws', () => {
  it('warns about level jumps and attaches to the deepest open node', () => {
    const result = parseGedcom(ged('0 HEAD', '0 @I1@ INDI', '1 BIRT', '3 DATE 1900', '0 TRLR'));
    expect(find(result.index.get('@I1@'), 'BIRT', 'DATE')?.level).toBe(3);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'level-jump', line: 4 }),
    );
  });

  it('turns an orphan line before any record into a record with a warning', () => {
    const result = parseGedcom(ged('1 NAME Stray', '0 HEAD', '0 TRLR'));
    expect(result.records[0]).toMatchObject({ level: 1, tag: 'NAME', line: 1 });
    expect(codes(result)).toContain('orphan-line');
  });

  it('skips unparseable text before any record', () => {
    const result = parseGedcom(ged('garbage', '0 HEAD', '0 TRLR'));
    expect(result.skipped).toEqual([{ line: 1, text: 'garbage' }]);
    expect(result.lines.skipped).toBe(1);
    expect(codes(result)).toContain('skipped-line');
  });

  it('warns about missing HEAD and TRLR', () => {
    const result = parseGedcom('0 @I1@ INDI\n1 NAME x');
    expect(codes(result)).toEqual(['missing-head', 'missing-trlr']);
    expect(result.lineCount).toBe(2);
  });

  it('warns about records after TRLR but keeps them', () => {
    const result = parseGedcom(ged('0 HEAD', '0 TRLR', '0 @I1@ INDI'));
    expect(result.index.has('@I1@')).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'after-trlr', line: 3 }),
    );
  });

  it('warns about duplicate xrefs and indexes the first', () => {
    const result = parseGedcom(ged('0 HEAD', '0 @I1@ INDI', '0 @I1@ INDI', '1 NAME b', '0 TRLR'));
    expect(result.index.get('@I1@')?.line).toBe(2);
    expect(result.records).toHaveLength(4);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'duplicate-xref', line: 3 }),
    );
  });

  it('warns about levels written with leading zeros', () => {
    const result = parseGedcom(ged('0 HEAD', '01 CHAR UTF-8', '0 TRLR'));
    expect(result.records[0]?.children[0]?.level).toBe(1);
    expect(codes(result)).toContain('level-format');
  });

  it('flags lines containing replacement characters from invalid bytes', () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('0 HEAD\n1 CHAR UTF-8\n0 @I1@ INDI\n1 NAME A'),
      0xff,
      ...new TextEncoder().encode('\n0 TRLR\n'),
    ]);
    const result = parseGedcom(bytes);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'replacement-char', line: 4 }),
    );
    expect(codes(result)).toContain('invalid-bytes');
  });

  it('caps stored warnings but keeps the total count', () => {
    const text = '0 HEAD\n' + '1 A\n3 B\n'.repeat(50) + '0 TRLR\n';
    const result = parseGedcom(text, { maxWarnings: 10 });
    expect(result.warnings).toHaveLength(10);
    expect(result.warningCount).toBe(50);
  });

  it('handles empty input', () => {
    const result = parseGedcom(new Uint8Array());
    expect(result.records).toEqual([]);
    expect(result.lineCount).toBe(0);
    expect(codes(result)).toEqual(['missing-head', 'missing-trlr']);
  });
});

describe('parseGedcom: malformed record lines never join the previous record', () => {
  it('repairs `0 @I2@INDI` into its own record with a warning', () => {
    const result = parseGedcom(
      ged('0 HEAD', '0 @I1@ INDI', '1 NAME A', '0 @I2@INDI', '1 NAME B /Bad/', '1 BIRT', '0 TRLR'),
    );
    expect(find(result.index.get('@I1@'), 'NAME')?.value).toBe('A');
    expect(result.index.get('@I1@')?.children).toHaveLength(1);
    const i2 = result.index.get('@I2@');
    expect(i2?.children.map((c) => c.tag)).toEqual(['NAME', 'BIRT']);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'malformed-line', line: 4 }),
    );
  });

  it('skips an unrepairable level-0 line and orphans what follows instead of attaching it', () => {
    const result = parseGedcom(
      ged('0 HEAD', '0 @I1@ INDI', '1 NAME A', '0 @I2@', '1 NAME B', '0 TRLR'),
    );
    expect(result.index.get('@I1@')?.children).toHaveLength(1);
    expect(find(result.index.get('@I1@'), 'NAME')?.value).toBe('A');
    expect(result.skipped).toEqual([{ line: 4, text: '0 @I2@' }]);
    expect(result.records.map((r) => r.tag)).toEqual(['HEAD', 'INDI', 'NAME', 'TRLR']);
    expect(codes(result)).toEqual(['skipped-line', 'orphan-line']);
  });

  it('skips `100 FOO x` instead of treating it as note text', () => {
    const result = parseGedcom(ged('0 HEAD', '0 @I1@ INDI', '1 NOTE a', '100 FOO x', '0 TRLR'));
    expect(find(result.index.get('@I1@'), 'NOTE')?.value).toBe('a');
    expect(codes(result)).toEqual(['skipped-line']);
  });

  it('does not continue a pointer with bare text', () => {
    const result = parseGedcom(ged('0 HEAD', '0 @I1@ INDI', '1 FAMS @F1@', 'stray text', '0 TRLR'));
    expect(find(result.index.get('@I1@'), 'FAMS')).toMatchObject({ pointer: '@F1@' });
    expect(find(result.index.get('@I1@'), 'FAMS')?.value).toBeUndefined();
    expect(codes(result)).toEqual(['skipped-line']);
  });
});

describe('parseGedcom: line accounting', () => {
  it('maps every node and continuation to its source lines', () => {
    const result = parseGedcom(
      ged('0 HEAD', '0 @I1@ INDI', '1 NOTE a', '2 CONT b', 'c', '1 SEX M', '0 TRLR'),
    );
    expect(subtreeLines(result.index.get('@I1@')!)).toEqual([2, 3, 4, 5, 6]);
    const all = result.records.flatMap((r) => subtreeLines(r));
    expect(all.length + result.lines.detached).toBe(result.lineCount);
  });

  it('attaches blank and skipped lines inside a record to it, and earlier ones to the preamble', () => {
    const result = parseGedcom(
      ged('', 'junk', '0 HEAD', '0 @I1@ INDI', '', '1 NAME a', '0 @X', '0 TRLR', ''),
    );
    expect(result.preamble.map((p) => p.line)).toEqual([1, 2]);
    expect(subtreeLines(result.index.get('@I1@')!)).toEqual([4, 5, 6, 7]);
    expect(result.lines).toMatchObject({ total: 9, blank: 3, skipped: 2, detached: 2 });
    const all = result.records.flatMap((r) => subtreeLines(r));
    expect(all.length + result.lines.detached).toBe(result.lineCount);
  });
});

describe('parseGedcomStream', () => {
  async function* chunks(bytes: Uint8Array, size: number) {
    for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
  }

  it('matches parseGedcom for any chunk size', async () => {
    const text =
      '\uFEFF' +
      ged('0 HEAD', '1 CHAR UTF-8', '0 @I1@ INDI', '1 NAME Zoë /Ærø/', '1 NOTE a', 'b', '0 TRLR');
    const bytes = new TextEncoder().encode(text.replaceAll('\n', '\r\n'));
    const expected = parseGedcom(bytes);
    for (const size of [1, 2, 3, 7, 64, 100_000]) {
      const streamed = await parseGedcomStream(chunks(bytes, size));
      expect(streamed.records).toEqual(expected.records);
      expect(streamed.lines).toEqual(expected.lines);
      expect(streamed.encoding).toEqual(expected.encoding);
    }
  });

  it('decodes ANSEL and UTF-16 streams', async () => {
    const ansel = new Uint8Array([
      ...new TextEncoder().encode('0 HEAD\n1 CHAR ANSEL\n0 @I1@ INDI\n1 NAME Jos'),
      0xe2,
      ...new TextEncoder().encode('e\n0 TRLR\n'),
    ]);
    const result = await parseGedcomStream(chunks(ansel, 5));
    expect(find(result.index.get('@I1@'), 'NAME')?.value).toBe('José');

    const src = '0 HEAD\n1 CHAR UNICODE\n0 @I1@ INDI\n1 NAME Łukasz\n0 TRLR\n';
    const le = new Uint8Array([
      0xff,
      0xfe,
      ...[...src].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]),
    ]);
    const utf = await parseGedcomStream(chunks(le, 3));
    expect(find(utf.index.get('@I1@'), 'NAME')?.value).toBe('Łukasz');
  });

  it('detects the encoding from the first non-ASCII bytes of a long stream', async () => {
    const enc = new TextEncoder();
    const filler = '1 NOTE ' + 'x'.repeat(70) + '\n';
    const bytes = new Uint8Array([
      ...enc.encode('0 HEAD\n1 CHAR ASCII\n0 @I1@ INDI\n' + filler.repeat(1000) + '1 NAME Ren'),
      0xe9,
      ...enc.encode('\n0 TRLR\n'),
    ]);
    const streamed = await parseGedcomStream(chunks(bytes, 1000));
    // The choice waits for the first non-ASCII byte, so a late one still decides (#269).
    expect(streamed.encoding.encoding).toBe('windows-1252');
    expect(codes(streamed)).toContain('encoding-fallback');
    expect(codes(streamed)).not.toContain('invalid-bytes');
    expect(find(streamed.records[1], 'NAME')?.value).toBe('René');

    const early = new Uint8Array([
      ...enc.encode('0 HEAD\n1 CHAR ASCII\n1 NOTE Ren'),
      0xe9,
      ...enc.encode('\n' + filler.repeat(1000)),
    ]);
    const fallback = await parseGedcomStream(chunks(early, 1000));
    expect(fallback.encoding.encoding).toBe('windows-1252');
    expect(codes(fallback)).toContain('encoding-fallback');
    expect(find(fallback.records[0], 'NOTE')?.value).toBe('René');
  });

  it('reports a line too long to hold in memory instead of throwing', async () => {
    const spy = vi.spyOn(LineSplitter.prototype, 'push').mockImplementation(() => {
      throw new RangeError('Invalid string length');
    });
    try {
      const result = await parseGedcomStream(chunks(new TextEncoder().encode('0 HEAD\n'), 3));
      expect(codes(result)).toContain('decode-failed');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports invalid bytes in a stream', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('0 HEAD\n1 CHAR UTF-8\n1 NOTE '),
      0xff,
    ]);
    const result = await parseGedcomStream(chunks(bytes, 4));
    expect(codes(result)).toContain('invalid-bytes');
  });
});
