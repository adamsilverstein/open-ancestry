import { describe, expect, it } from 'vitest';
import { LineSplitter, splitLines, tokenizeLine } from './tokenizer';

describe('splitLines', () => {
  it('splits on LF, CRLF and CR', () => {
    expect(splitLines('a\nb\r\nc\rd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not emit an empty line after a final terminator', () => {
    expect(splitLines('a\r\n')).toEqual(['a']);
    expect(splitLines('')).toEqual([]);
  });

  it('keeps blank lines', () => {
    expect(splitLines('a\n\n\r\n\rb')).toEqual(['a', '', '', '', 'b']);
  });
});

describe('LineSplitter', () => {
  it('handles CRLF split across chunks', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((l) => lines.push(l));
    splitter.push('0 HEAD\r');
    splitter.push('\n1 CHAR UTF-8\r');
    splitter.push('\r\n0 TR');
    splitter.push('LR');
    splitter.end();
    expect(lines).toEqual(['0 HEAD', '1 CHAR UTF-8', '', '0 TRLR']);
  });

  it('flushes a pending lone CR at the end', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((l) => lines.push(l));
    splitter.push('a\r');
    splitter.end();
    expect(lines).toEqual(['a']);
  });
});

describe('tokenizeLine', () => {
  it('parses level, xref and tag', () => {
    expect(tokenizeLine('0 @I1@ INDI')).toEqual({ level: 0, xref: '@I1@', tag: 'INDI' });
  });

  it('parses a pointer value', () => {
    expect(tokenizeLine('1 FAMS @F2@')).toEqual({ level: 1, tag: 'FAMS', value: '@F2@' });
  });

  it('keeps every character after the single delimiter, including spaces', () => {
    expect(tokenizeLine('2 CONC  in her hand ')).toEqual({
      level: 2,
      tag: 'CONC',
      value: ' in her hand ',
    });
  });

  it('distinguishes an empty value from no value', () => {
    expect(tokenizeLine('1 NOTE ')).toEqual({ level: 1, tag: 'NOTE', value: '' });
    expect(tokenizeLine('1 BIRT')).toEqual({ level: 1, tag: 'BIRT' });
  });

  it('accepts leading whitespace and tab or repeated delimiters before the tag', () => {
    expect(tokenizeLine('  \t2 DATE 1900')).toMatchObject({ level: 2, tag: 'DATE', value: '1900' });
    expect(tokenizeLine('1\tNAME  Ann')).toMatchObject({ level: 1, tag: 'NAME', value: ' Ann' });
    expect(tokenizeLine('0  @I1@  INDI')).toMatchObject({ xref: '@I1@', tag: 'INDI' });
  });

  it('accepts underscore custom tags and mixed-case custom tags', () => {
    expect(tokenizeLine('1 _MTTAG @T1@')).toMatchObject({ tag: '_MTTAG' });
    expect(tokenizeLine('1 _Tree x')).toMatchObject({ tag: '_Tree' });
  });

  it('flags levels with leading zeros', () => {
    expect(tokenizeLine('01 NAME x')).toEqual({
      level: 1,
      tag: 'NAME',
      value: 'x',
      levelFormat: true,
    });
  });

  it('accepts lines longer than 255 characters', () => {
    const long = 'x'.repeat(5000);
    expect(tokenizeLine(`1 NOTE ${long}`)?.value).toBe(long);
  });

  it.each([
    ['plain text', 'The Bible later passed to Mabel'],
    ['a year starting a sentence', '1850 was a hard year'],
    ['a lowercase standard-looking tag', '1 name John'],
    ['a level with no tag', '1'],
    ['a level with only an xref', '0 @I1@'],
    ['an unterminated xref', '0 @I1 INDI'],
    ['an empty xref', '0 @@ INDI'],
    ['an xref containing a space', '0 @I 1@ INDI'],
    ['an xref glued to the tag', '0 @I1@INDI'],
    ['a tag with punctuation', '1 NA:ME x'],
    ['a level over 99', '100 NAME x'],
    ['a negative level', '-1 NAME x'],
  ])('returns undefined for %s', (_, line) => {
    expect(tokenizeLine(line)).toBeUndefined();
  });
});
