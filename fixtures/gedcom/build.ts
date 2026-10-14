/**
 * Writes the encoding and edge-case fixtures in this folder. They are tiny and
 * committed; rerun after editing: `npx tsx fixtures/gedcom/build.ts`.
 * Every name and place is invented.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dirname;
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const write = (name: string, bytes: number[] | Uint8Array) =>
  writeFileSync(join(dir, name), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

// GEDCOM 7: no CHAR, SCHMA extension tags, @VOID@, leading @@ escape, CRLF.
write(
  'gedcom7.ged',
  new TextEncoder().encode(
    [
      '0 HEAD',
      '1 GEDC',
      '2 VERS 7.0.14',
      '1 SCHMA',
      '2 TAG _SKYPEID http://xmlns.com/foaf/0.1/skypeID',
      '1 SOUR SampleApp',
      '2 VERS 3.1',
      '0 @I1@ INDI',
      '1 NAME Quill /Brackenridge/',
      '1 _SKYPEID quill.b',
      '1 NOTE @@handle on the forum',
      '2 CONT second line with an email q@@b.example',
      '1 FAMC @F1@',
      '0 @F1@ FAM',
      '1 HUSB @VOID@',
      '1 CHIL @I1@',
      '0 TRLR',
      '',
    ].join('\r\n'),
  ),
);

// ANSEL with diacritics before their base letters, old Mac CR line endings.
write('ansel.ged', [
  ...ascii('0 HEAD\r1 CHAR ANSEL\r1 GEDC\r2 VERS 5.5.1\r0 @I1@ INDI\r1 NAME Ren'),
  0xe2, // acute
  ...ascii('e /M'),
  0xe8, // diaeresis
  ...ascii('uller/\r1 BIRT\r2 PLAC Krak'),
  0xe2,
  ...ascii('ow, '),
  0xa1, // Ł
  0xe2,
  ...ascii('od'),
  0xe2,
  ...ascii('z\r1 NOTE Price '),
  0xb9, // £
  ...ascii('5, '),
  0xc3, // ©
  ...ascii(' 1901, dot-below+circumflex: '),
  0xf2,
  0xe3,
  ...ascii('a\r0 TRLR\r'),
]);

// UTF-16 LE with BOM and CRLF.
const utf16 = [
  '0 HEAD',
  '1 CHAR UNICODE',
  '1 GEDC',
  '2 VERS 5.5.1',
  '0 @I1@ INDI',
  '1 NAME Łucja /Wróblewska/',
  '1 NOTE 日本語のメモ',
  '0 TRLR',
  '',
].join('\r\n');
write('utf16le.ged', [
  0xff,
  0xfe,
  ...[...utf16].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]),
]);

// Windows-1252 declared as ANSI.
write('cp1252.ged', [
  ...ascii('0 HEAD\n1 CHAR ANSI\n1 GEDC\n2 VERS 5.5.1\n0 @I1@ INDI\n1 NAME Jos'),
  0xe9,
  ...ascii(' /Pe'),
  0xf1,
  ...ascii('a/\n1 NOTE '),
  0x93,
  ...ascii('quoted'),
  0x94,
  ...ascii(' '),
  0x80,
  ...ascii('20\n0 TRLR\n'),
]);

// Ancestry-style quirks: bare-text continuation lines (with a blank line
// between paragraphs), CONC splitting mid-word and before a space, leading
// whitespace, and a line far over 255 characters.
write(
  'ancestry-quirks.ged',
  new TextEncoder().encode(
    '\uFEFF' +
      [
        '0 HEAD',
        '1 CHAR UTF-8',
        '1 SOUR Ancestry.com Family Trees',
        '2 VERS 2024.12',
        '1 GEDC',
        '2 VERS 5.5.1',
        '0 @I1@ INDI',
        '  1 NAME Wren /Thistlewood/',
        '1 NOTE Wren kept a diary from 18',
        '2 CONC 71 until her death. She wrote about the',
        '2 CONC  harvest every autumn.',
        'Ancestry wrote this paragraph without a CONT tag.',
        '',
        'And this one after a blank line.',
        `1 _LONG ${'Lorem ipsum dolor sit amet '.repeat(20).trim()}`,
        '1 SOUR @S1@',
        '2 _APID 1,7602::12345',
        '0 @S1@ SOUR',
        '1 TITL 1900 Census',
        '0 TRLR',
        '',
      ].join('\n'),
  ),
);

// Malformed: garbage before HEAD, orphan line, level jump, duplicate xref,
// misplaced CONC, invalid UTF-8 bytes, no TRLR.
write('malformed.ged', [
  ...ascii('this is not gedcom\n0 HEAD\n1 CHAR UTF-8\n0 @I1@ INDI\n1 NAME Bad'),
  0xff,
  0xfe,
  ...ascii(' /Bytes/\n1 BIRT\n3 DATE 1900\n1 SEX M\n1 CONC orphaned continuation\n'),
  ...ascii('0 @I1@ INDI\n1 NAME Duplicate /Record/\n0 @I2@ INDI\n1 NAME Truncated /File/\n'),
]);
