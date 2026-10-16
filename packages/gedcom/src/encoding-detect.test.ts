import { describe, expect, it } from 'vitest';
import { parseGedcom, parseGedcomStream } from './parser';

/** A file whose HEAD.CHAR claims `charset` but whose bytes are UTF-8, with the first non-ASCII byte after `padRecords` ASCII records. */
function file(charset: string, padRecords: number): Uint8Array {
  const lines = ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', `1 CHAR ${charset}`];
  for (let i = 1; i <= padRecords; i++)
    lines.push(
      `0 @I${i}@ INDI`,
      `1 NAME Person${i} /Ascii/`,
      '1 BIRT',
      '2 DATE 1 JAN 1900',
      '2 PLAC Springfield, Somewhere, USA',
    );
  lines.push('0 @X1@ INDI', '1 NAME José /Müller/', '0 TRLR', '');
  return new TextEncoder().encode(lines.join('\n'));
}
const nameIn = (doc: ReturnType<typeof parseGedcom>) =>
  doc.records.find((r) => r.xref === '@X1@')!.children.find((c) => c.tag === 'NAME')!.value;
const name = (bytes: Uint8Array) => nameIn(parseGedcom(bytes));
/** Text whose characters are all in Latin-1, as Windows-1252 bytes. */
const encodeCp1252 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
/** Streams `bytes` in chunks of `size`. */
async function* chunks(bytes: Uint8Array, size: number) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

describe('UTF-8 labelled ANSI, ANSEL or IBMPC (#269)', () => {
  it.each(['ANSI', 'ANSEL', 'IBMPC'])(
    'reads UTF-8 labelled %s correctly when non-ASCII appears early',
    (cs) => {
      expect(name(file(cs, 10))).toBe('José /Müller/');
    },
  );
  it.each(['ANSI', 'ANSEL', 'IBMPC'])(
    'reads UTF-8 labelled %s correctly when the first non-ASCII byte is past 64 KB',
    (cs) => {
      expect(name(file(cs, 1000))).toBe('José /Müller/');
    },
  );
});

describe('streaming waits for the first non-ASCII byte to choose (#269)', () => {
  it.each(['ANSI', 'ANSEL', 'IBMPC'])('reads UTF-8 labelled %s past 64 KB', async (cs) => {
    for (const size of [1000, 65536, 100_000]) {
      const doc = await parseGedcomStream(chunks(file(cs, 1000), size));
      expect(nameIn(doc), `chunks of ${size}`).toBe('José /Müller/');
      expect(doc.encoding).toMatchObject({ encoding: 'utf-8', declared: cs });
    }
  });

  it('still reads real Windows-1252 bytes past 64 KB as the label says', async () => {
    const text = new TextDecoder().decode(file('ANSI', 1000));
    const doc = await parseGedcomStream(chunks(encodeCp1252(text), 4096));
    expect(nameIn(doc)).toBe('José /Müller/');
    expect(doc.encoding).toMatchObject({ encoding: 'windows-1252', source: 'header' });
    expect(name(encodeCp1252(text))).toBe('José /Müller/');
  });

  it('falls back to Windows-1252 for a file labelled ASCII whose high bytes start past 64 KB', async () => {
    const text = new TextDecoder().decode(file('ASCII', 1000));
    const doc = await parseGedcomStream(chunks(encodeCp1252(text), 4096));
    expect(nameIn(doc)).toBe('José /Müller/');
    expect(doc.warnings.map((w) => w.code)).toContain('encoding-fallback');
  });

  it('reads an all-ASCII file in chunks the same as whole', async () => {
    const bytes = file('ANSI', 1000).filter((b) => b < 0x80);
    const whole = parseGedcom(bytes);
    const streamed = await parseGedcomStream(chunks(bytes, 777));
    expect(streamed.lineCount).toBe(whole.lineCount);
    expect(streamed.encoding).toEqual(whole.encoding);
  });
});

describe('review of #292', () => {
  /** Streams `bytes` cut at each of `offsets`. */
  async function* cutAt(bytes: Uint8Array, offsets: number[]) {
    let from = 0;
    for (const to of [...offsets, bytes.length]) {
      yield bytes.subarray(from, to);
      from = to;
    }
  }

  it('reads a character split across chunks at the first non-ASCII byte', async () => {
    const bytes = file('ANSI', 1000);
    const at = bytes.findIndex((b) => b >= 0x80);
    expect(at).toBeGreaterThan(64 * 1024);
    // Between the two bytes of é, and right before it.
    for (const offsets of [[at + 1], [at], [1000, at + 1, at + 2]]) {
      const doc = await parseGedcomStream(cutAt(bytes, offsets));
      expect(nameIn(doc), `cut at ${offsets.join(', ')}`).toBe('José /Müller/');
      expect(doc.warnings.map((w) => w.code)).not.toContain('invalid-bytes');
    }
  });

  it('joins an ASCII NOTE with a CONC line that brings the first non-ASCII byte', async () => {
    const text = new TextDecoder()
      .decode(file('ANSEL', 1000))
      .replace('0 @X1@ INDI\n', '0 @X1@ INDI\n1 NOTE Plain start, \n2 CONC then café\n');
    const bytes = new TextEncoder().encode(text);
    const note = (doc: ReturnType<typeof parseGedcom>) =>
      doc.records.find((r) => r.xref === '@X1@')!.children.find((c) => c.tag === 'NOTE')!.value;
    expect(note(parseGedcom(bytes))).toBe('Plain start, then café');
    for (const size of [1000, 65536]) {
      expect(note(await parseGedcomStream(chunks(bytes, size))), `chunks of ${size}`).toBe(
        'Plain start, then café',
      );
    }
  });

  it('warns that the bytes override an ANSEL label', async () => {
    const bytes = file('ANSEL', 1000);
    for (const doc of [parseGedcom(bytes), await parseGedcomStream(chunks(bytes, 4096))]) {
      expect(doc.encoding).toMatchObject({ encoding: 'utf-8', source: 'sniff', declared: 'ANSEL' });
      expect(doc.warnings).toContainEqual(
        expect.objectContaining({
          code: 'charset-mismatch',
          message: expect.stringContaining('HEAD.CHAR says ANSEL'),
        }),
      );
    }
  });
});

describe('HEAD scan and a product VERS (#269)', () => {
  it('decodes an ANSEL file whose SOUR name contains "GEDC" and whose product version is 7.x', () => {
    const ascii = (s: string) => [...new TextEncoder().encode(s)];
    // "José" in ANSEL: combining acute (0xE2) before the base letter.
    const bytes = new Uint8Array([
      ...ascii('0 HEAD\n1 SOUR GEDCOM_PUBLISHER\n2 VERS 7.2\n1 GEDC\n2 VERS 5.5.1\n1 CHAR ANSEL\n'),
      ...ascii('0 @I1@ INDI\n1 NAME Jos'),
      0xe2,
      ...ascii('e /Smith/\n0 TRLR\n'),
    ]);
    const doc = parseGedcom(bytes);
    expect(doc.records[1]!.children[0]!.value).toBe('José /Smith/');
  });
});
