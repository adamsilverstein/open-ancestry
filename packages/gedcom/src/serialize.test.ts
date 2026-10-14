import { describe, expect, it } from 'vitest';
import { parseGedcom } from './parser';
import { encodeValue, serializeGedcom, serializeNode } from './serialize';
import type { GedcomNode } from './types';

const node = (partial: Partial<GedcomNode> & Pick<GedcomNode, 'level' | 'tag'>): GedcomNode => ({
  children: [],
  line: 0,
  ...partial,
});

describe('serializeNode', () => {
  it('re-emits a parsed subtree exactly, including CONC/CONT and broken lines', () => {
    const lines = [
      '0 @I1@ INDI',
      '1 NAME Ann /Ash/',
      '1 NOTE Lavinia kept it from 18',
      '2 CONC 62 onward. ',
      '2 CONT',
      '2 CONC  spaced ',
      'bare continuation line',
      '1 EMAIL ann@@example.com',
      '1 FAMS @F1@',
      '1 BIRT',
      '2 DATE @#DJULIAN@ 1700',
    ];
    const result = parseGedcom(`0 HEAD\n${lines.join('\n')}\n0 TRLR\n`);
    expect(serializeNode(result.index.get('@I1@')!)).toBe(lines.join('\n') + '\n');
  });

  it('re-emits unedited GEDCOM 7 escapes without being told the version', () => {
    const doc = parseGedcom('0 HEAD\n1 GEDC\n2 VERS 7.0\n0 @I1@ INDI\n1 NOTE a@@b\n1 _X @@y\n');
    expect(serializeNode(doc.index.get('@I1@')!)).toBe('0 @I1@ INDI\n1 NOTE a@@b\n1 _X @@y\n');
  });

  it('re-emits whitespace quirks, 01 levels, trailing spaces and blank lines exactly', () => {
    const lines = [
      '0 @I1@ INDI',
      '  1 NAME Ann /Ash/',
      '1\tSEX F',
      '1  NOTE  two spaces',
      '2 CONT ',
      '',
      '2 CONC x',
      '01 BIRT',
      '\t',
      '2 DATE 1900',
      '1 @N1@NOTE repaired',
      '1 EMAIL a@b',
      '1 NOTE @x',
    ];
    const doc = parseGedcom(`0 HEAD\n${lines.join('\n')}\n0 TRLR\n`);
    expect(serializeNode(doc.index.get('@I1@')!)).toBe(lines.join('\n') + '\n');
  });

  it('falls back to the canonical line when a node with source text is edited', () => {
    const indi = parseGedcom('0 @I1@ INDI\n  1 NAME Ann\n01 SEX F\n').records[0]!;
    indi.children[0]!.value = 'Bea';
    indi.children[1]!.level = 1;
    expect(serializeNode(indi)).toBe('0 @I1@ INDI\n1 NAME Bea\n01 SEX F\n');
    indi.children[1]!.tag = 'SEX';
    indi.children[1]!.value = 'M';
    expect(serializeNode(indi)).toBe('0 @I1@ INDI\n1 NAME Bea\n1 SEX M\n');
  });

  it('emits the preamble of unparseable lines before the first record', () => {
    const src = 'junk\n\n0 HEAD\n0 TRLR\n';
    expect(serializeGedcom(parseGedcom(src))).toBe(src);
  });

  it('supports CRLF output', () => {
    const indi = parseGedcom('0 @I1@ INDI\n1 SEX M\n').records[0]!;
    expect(serializeNode(indi, { eol: '\r\n' })).toBe('0 @I1@ INDI\r\n1 SEX M\r\n');
  });

  it('re-encodes values edited after parsing', () => {
    const indi = parseGedcom('0 @I1@ INDI\n1 NOTE old\n2 CONT text\n1 EMAIL a@@b\n').records[0]!;
    indi.children[0]!.value = 'new\nmulti';
    indi.children[1]!.value = 'x@@y';
    expect(serializeNode(indi)).toBe('0 @I1@ INDI\n1 NOTE new\n2 CONT multi\n1 EMAIL x@@@@y\n');
  });

  it('emits empty values and empty CONT lines', () => {
    const n = node({ level: 1, tag: 'NOTE', value: '\nb\n' });
    expect(serializeNode(n)).toBe('1 NOTE\n2 CONT b\n2 CONT\n');
    expect(serializeNode(node({ level: 1, tag: 'NOTE', value: '' }))).toBe('1 NOTE \n');
  });

  it('splits long values with CONC away from spaces when maxLineLength is set', () => {
    const value = 'alpha beta gamma delta';
    const out = serializeNode(node({ level: 1, tag: 'NOTE', value }), { maxLineLength: 16 });
    const reparsed = parseGedcom(out).records[0]!;
    expect(reparsed.value).toBe(value);
    for (const line of out.trimEnd().split('\n')) {
      expect(line.length).toBeLessThanOrEqual(16);
      expect(line).not.toMatch(/ $/);
      expect(line).not.toMatch(/CONC {2}/);
    }
  });

  it('splits an unbroken run of spaces when there is no better place', () => {
    const value = ' '.repeat(30);
    const out = serializeNode(node({ level: 1, tag: 'NOTE', value }), { maxLineLength: 12 });
    expect(parseGedcom(out).records[0]!.value).toBe(value);
  });

  it('writes pointers and GEDCOM 7 escapes', () => {
    expect(serializeNode(node({ level: 1, tag: 'HUSB', pointer: '@VOID@' }))).toBe(
      '1 HUSB @VOID@\n',
    );
    expect(serializeNode(node({ level: 1, tag: 'NOTE', value: '@me' }), { version: 7 })).toBe(
      '1 NOTE @@me\n',
    );
  });
});

describe('encodeValue', () => {
  it('round-trips through 5.5.1 decoding', () => {
    for (const v of ['a@b', 'a@@b', '@I1@', '@#DJULIAN@ 1700', '@', '@@@', 'x@']) {
      const doc = parseGedcom(`0 HEAD\n1 NOTE ${encodeValue(v, 5)}\n`);
      expect(doc.records[0]!.children[0]!.value, v).toBe(v);
    }
  });

  it('round-trips through 7 decoding', () => {
    for (const v of ['a@b', 'a@@b', '@I1@', '@', '@@x']) {
      const doc = parseGedcom(`0 HEAD\n1 GEDC\n2 VERS 7.0\n1 NOTE ${encodeValue(v, 7)}\n`);
      expect(doc.records[0]!.children[1]!.value, v).toBe(v);
    }
  });
});

describe('serializeGedcom', () => {
  it('serializes every record', () => {
    const src = '0 HEAD\n1 GEDC\n2 VERS 7.0\n0 @I1@ INDI\n1 NOTE @@x\n0 TRLR\n';
    const result = parseGedcom(src);
    expect(serializeGedcom(result)).toBe(src);
  });
});
