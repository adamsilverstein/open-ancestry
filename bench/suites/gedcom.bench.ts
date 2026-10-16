import { generateGedcom } from '../../fixtures/generate';
import { parseGedcom, parseGedcomStream } from '../../packages/gedcom/src/index';
import type { BenchCase } from '../types';

// About 22 lines per generated person, so 4,600 people is just over 100k lines.
let bytes = new Uint8Array();
/**
 * The same file labelled ANSI, all ASCII but for one UTF-8 name mid-file, past
 * the first 64 KiB: the stream parses the ASCII part as it arrives, holds back
 * 64 KiB from that name, then switches to UTF-8 (#269).
 */
let ansi = new Uint8Array();

function setupAnsi() {
  const text = generateGedcom({ people: 4600, seed: 1 });
  const ascii = text.replace(/^1 CHAR .*$/m, '1 CHAR ANSI').replace(/[\u0080-\u{10ffff}]/gu, '?');
  const middle = ascii.indexOf('\n0 @', ascii.length >> 1) + 1;
  ansi = new TextEncoder().encode(
    `${ascii.slice(0, middle)}0 @X1@ INDI\n1 NAME José /Müller/\n${ascii.slice(middle)}`,
  );
  const first = ansi.findIndex((b) => b >= 0x80);
  if (first < 65536) throw new Error(`first non-ASCII byte at ${first}, not past 64 KiB`);
  const { encoding } = parseGedcom(ansi);
  if (encoding.encoding !== 'utf-8') throw new Error(`ANSI case decoded as ${encoding.encoding}`);
}

export default [
  {
    name: 'gedcom: decode + tokenize + parse 100k lines',
    setup: () => {
      const text = generateGedcom({ people: 4600, seed: 1 });
      bytes = new TextEncoder().encode(text);
      const { lineCount } = parseGedcom(bytes);
      if (lineCount < 100_000) throw new Error(`bench input has only ${lineCount} lines`);
    },
    fn: () => parseGedcom(bytes),
    // design.md F4: under 500ms.
    budgetMs: 500,
  },
  {
    name: 'gedcom: stream-parse 100k lines in 64 KiB chunks',
    fn: () =>
      parseGedcomStream(
        (async function* () {
          for (let i = 0; i < bytes.length; i += 65536) yield bytes.subarray(i, i + 65536);
        })(),
      ),
    budgetMs: 500,
  },
  {
    name: 'gedcom: stream-parse 100k lines labelled ANSI, choosing at the first non-ASCII byte',
    setup: setupAnsi,
    fn: () =>
      parseGedcomStream(
        (async function* () {
          for (let i = 0; i < ansi.length; i += 65536) yield ansi.subarray(i, i + 65536);
        })(),
      ),
    budgetMs: 500,
  },
] satisfies BenchCase[];
