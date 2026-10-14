import { describe, expect, it } from 'vitest';
import { createDecoder, decodeAnsel, decodeGedcom, detectEncoding } from './encoding';

const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const concat = (...parts: (Uint8Array | number[])[]) =>
  new Uint8Array(parts.flatMap((p) => [...p]));

function utf16(text: string, littleEndian: boolean, bom = true): Uint8Array {
  const out: number[] = bom ? (littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]) : [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out.push(...(littleEndian ? [c & 0xff, c >> 8] : [c >> 8, c & 0xff]));
  }
  return new Uint8Array(out);
}

const head = (charset: string) => `0 HEAD\n1 CHAR ${charset}\n0 TRLR\n`;

describe('detectEncoding', () => {
  it('trusts a UTF-8 BOM', () => {
    expect(detectEncoding(concat([0xef, 0xbb, 0xbf], ascii(head('UTF-8'))))).toMatchObject({
      encoding: 'utf-8',
      source: 'bom',
      bom: true,
      declared: 'UTF-8',
    });
  });

  it('detects UTF-16 LE and BE from the BOM', () => {
    expect(detectEncoding(utf16(head('UNICODE'), true)).encoding).toBe('utf-16le');
    expect(detectEncoding(utf16(head('UNICODE'), false)).encoding).toBe('utf-16be');
  });

  it('sniffs BOM-less UTF-16 from the leading 0 of HEAD', () => {
    expect(detectEncoding(utf16(head('UNICODE'), true, false))).toMatchObject({
      encoding: 'utf-16le',
      source: 'sniff',
    });
    expect(detectEncoding(utf16(head('UNICODE'), false, false)).encoding).toBe('utf-16be');
  });

  it.each([
    ['UTF-8', 'utf-8'],
    ['UTF8', 'utf-8'],
    ['ANSEL', 'ansel'],
    ['ASCII', 'ascii'],
    ['ANSI', 'windows-1252'],
    ['WINDOWS-1252', 'windows-1252'],
    ['ISO-8859-1', 'windows-1252'],
    ['IBMPC', 'windows-1252'],
    ['MACINTOSH', 'macintosh'],
  ] as const)('honors 1 CHAR %s without a BOM', (declared, encoding) => {
    expect(detectEncoding(ascii(head(declared)))).toMatchObject({
      encoding,
      source: 'header',
      declared,
      bom: false,
    });
  });

  it('assumes UTF-8 for GEDCOM 7 files without CHAR', () => {
    const bytes = ascii('0 HEAD\n1 GEDC\n2 VERS 7.0\n0 TRLR\n');
    expect(detectEncoding(bytes)).toMatchObject({ encoding: 'utf-8', source: 'sniff' });
  });

  it('falls back to CP1252 for undeclared bytes that are not valid UTF-8', () => {
    const bytes = concat(ascii('0 HEAD\n0 @I1@ INDI\n1 NAME Ren'), [0xe9], ascii('\n'));
    expect(detectEncoding(bytes)).toMatchObject({ encoding: 'windows-1252', source: 'sniff' });
  });

  it('treats UNICODE without UTF-16 bytes as UTF-8', () => {
    expect(detectEncoding(ascii(head('UNICODE'))).encoding).toBe('utf-8');
  });

  it('treats an unknown CHAR as a hint and sniffs instead', () => {
    expect(detectEncoding(ascii(head('KLINGON')))).toMatchObject({
      encoding: 'utf-8',
      source: 'sniff',
      declared: 'KLINGON',
    });
  });

  it('honors an explicit encoding option', () => {
    expect(detectEncoding(ascii(head('UTF-8')), { encoding: 'ansel' })).toMatchObject({
      encoding: 'ansel',
      source: 'option',
    });
  });

  it('handles empty input', () => {
    expect(detectEncoding(new Uint8Array()).encoding).toBe('utf-8');
  });
});

describe('decodeGedcom', () => {
  it('strips the BOM and decodes UTF-8', () => {
    const { text, warnings } = decodeGedcom(
      concat([0xef, 0xbb, 0xbf], new TextEncoder().encode('0 HEAD\n1 NAME Zoë\n')),
    );
    expect(text).toBe('0 HEAD\n1 NAME Zoë\n');
    expect(warnings).toEqual([]);
  });

  it('decodes UTF-16 LE and BE with a BOM', () => {
    const src = '0 HEAD\n1 CHAR UNICODE\n0 @I1@ INDI\n1 NAME Łukasz /Wróbel/\n';
    expect(decodeGedcom(utf16(src, true)).text).toBe(src);
    expect(decodeGedcom(utf16(src, false)).text).toBe(src);
  });

  it('decodes CP1252 including the 0x80-0x9f range', () => {
    const bytes = concat(ascii(`${head('ANSI')}1 NOTE `), [0x80, 0x93, 0xe9, 0x94]);
    expect(decodeGedcom(bytes).text.endsWith('1 NOTE €“é”')).toBe(true);
  });

  it('decodes ASCII-declared files as UTF-8 when valid, else CP1252', () => {
    const utf8 = concat(ascii(`${head('ASCII')}1 NOTE `), [0xc3, 0xa9]);
    expect(decodeGedcom(utf8).text.endsWith('é')).toBe(true);
    const latin = concat(ascii(`${head('ASCII')}1 NOTE `), [0xe9]);
    const result = decodeGedcom(latin);
    expect(result.text.endsWith('é')).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('encoding-fallback');
  });

  it('replaces invalid UTF-8 bytes and warns instead of throwing', () => {
    const bytes = concat(ascii(`${head('UTF-8')}1 NOTE a`), [0xff, 0xfe, 0x80], ascii('b\n'));
    const { text, warnings } = decodeGedcom(bytes);
    expect(text).toContain('a\uFFFD');
    expect(warnings[0]).toMatchObject({ code: 'invalid-bytes', line: 0 });
  });

  it('does not count a literal U+FFFD as an invalid byte', () => {
    const bytes = new TextEncoder().encode(`${head('UTF-8')}1 NOTE \uFFFD\n`);
    expect(decodeGedcom(bytes).warnings).toEqual([]);
  });

  it('decodes ANSEL with combining diacritics reordered after the base letter', () => {
    // "José Müller" in ANSEL: acute (E2) and diaeresis (E8) precede the base letter.
    const bytes = concat(ascii(`${head('ANSEL')}1 NAME Jos`), [0xe2], ascii('e /M'), [0xe8]);
    const text = decodeGedcom(concat(bytes, ascii('uller/\n'))).text;
    expect(text).toContain('1 NAME José /Müller/');
    expect(text.normalize('NFC')).toBe(text);
  });

  it('warns when the BOM contradicts HEAD.CHAR but trusts the BOM', () => {
    const bytes = concat([0xef, 0xbb, 0xbf], ascii(`${head('ANSEL')}1 NOTE `), [0xc3, 0xa9]);
    const { text, warnings, encoding } = decodeGedcom(bytes);
    expect(encoding.encoding).toBe('utf-8');
    expect(text.endsWith('é')).toBe(true);
    expect(warnings.map((w) => w.code)).toContain('charset-mismatch');
  });
});

describe('decodeAnsel', () => {
  it('maps spacing characters', () => {
    const bytes = new Uint8Array([0xa1, 0xa2, 0xa5, 0xb1, 0xb5, 0xb9, 0xc3, 0xc5, 0xc7, 0xc8]);
    expect(decodeAnsel(bytes).text).toBe('ŁØÆłæ£©¿ß€');
  });

  it('composes stacked diacritics in Unicode order', () => {
    // ANSEL: dot below (F2) + circumflex (E3) + "a"; Unicode: a + U+0323 + U+0302 -> "ậ".
    expect(decodeAnsel(new Uint8Array([0xf2, 0xe3, 0x61])).text).toBe('ậ');
  });

  it('replaces undefined bytes and counts them', () => {
    const result = decodeAnsel(new Uint8Array([0x41, 0x80, 0xff, 0x42]));
    expect(result.text).toBe('A\uFFFD\uFFFDB');
    expect(result.invalid).toBe(2);
  });

  it('keeps a trailing diacritic with no base letter', () => {
    expect(decodeAnsel(new Uint8Array([0x41, 0xe2])).text).toBe('Á');
  });
});

describe('createDecoder', () => {
  it('decodes ANSEL across chunk boundaries', () => {
    const decoder = createDecoder('ansel');
    const text =
      decoder.decode(new Uint8Array([0x4a, 0x6f, 0x73, 0xe2])) + decoder.decode(ascii('e'));
    expect(text + decoder.end()).toBe('José');
  });

  it('decodes UTF-8 split mid-sequence', () => {
    const decoder = createDecoder('utf-8');
    const [a, b] = [new Uint8Array([0x5a, 0x6f, 0xc3]), new Uint8Array([0xab])];
    expect(decoder.decode(a) + decoder.decode(b) + decoder.end()).toBe('Zoë');
    expect(decoder.invalidBytes()).toBe(0);
  });

  it('counts invalid UTF-8 bytes', () => {
    const decoder = createDecoder('utf-8');
    decoder.decode(new Uint8Array([0x41, 0xff]));
    decoder.end();
    expect(decoder.invalidBytes()).toBeGreaterThan(0);
  });
});
