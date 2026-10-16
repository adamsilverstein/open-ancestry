import { generateGedcom } from '../../fixtures/generate';
import { parseGedcom, parseGedcomStream } from '../../packages/gedcom/src/index';
import type { BenchCase } from '../types';

// About 22 lines per generated person, so 4,600 people is just over 100k lines.
let bytes = new Uint8Array();
/** The same file labelled ANSI, so the stream waits for its first non-ASCII byte (#269). */
let ansi = new Uint8Array();

export default [
  {
    name: 'gedcom: decode + tokenize + parse 100k lines',
    setup: () => {
      const text = generateGedcom({ people: 4600, seed: 1 });
      bytes = new TextEncoder().encode(text);
      ansi = new TextEncoder().encode(text.replace(/^1 CHAR .*$/m, '1 CHAR ANSI'));
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
    fn: () =>
      parseGedcomStream(
        (async function* () {
          for (let i = 0; i < ansi.length; i += 65536) yield ansi.subarray(i, i + 65536);
        })(),
      ),
    budgetMs: 500,
  },
] satisfies BenchCase[];
