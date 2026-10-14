import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseGedcom, parseGedcomStream } from './parser';
import { serializeGedcom } from './serialize';
import { project } from './test-utils';
import type { ParseResult } from './types';

const RUNS = Number(process.env.FUZZ_RUNS ?? 300);

function checkInvariants(result: ParseResult) {
  const { total, nodes, continuations, blank, skipped } = result.lines;
  expect(nodes + continuations + blank + skipped).toBe(total);
  expect(result.lineCount).toBe(total);
  for (const w of result.warnings) expect(w.line).toBeLessThanOrEqual(total);
}

const tag = fc.constantFrom(
  'HEAD',
  'TRLR',
  'INDI',
  'NAME',
  'NOTE',
  'CONC',
  'CONT',
  'DATE',
  '_APID',
  'GEDC',
  'VERS',
  'name',
);
const value = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.constantFrom('@I1@', '@@x', 'a@@b', '@#DJULIAN@ 1700', '@VOID@', '', ' ', '7.0', '5.5.1'),
);
const gedcomLine = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .tuple(
        fc.integer({ min: 0, max: 5 }),
        fc.option(fc.constantFrom('@I1@', '@F1@', '@N1@')),
        tag,
        fc.option(value),
      )
      .map(
        ([level, xref, t, v]) =>
          `${level} ${xref ? xref + ' ' : ''}${t}${v === null ? '' : ' ' + v}`,
      ),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 30, size: 'max', unit: 'binary' }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom('', '   ', '\t', '01 NAME x', '  2 DATE 1900', '1  NAME  two'),
  },
);
const eol = fc.constantFrom('\n', '\r\n', '\r');
const document = fc
  .tuple(fc.array(gedcomLine, { maxLength: 80, size: 'max' }), eol)
  .map(([lines, e]) => lines.join(e));

describe('fuzz: parser never throws', () => {
  it('on random bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4000, size: 'max' }), (bytes) => {
        checkInvariants(parseGedcom(bytes));
      }),
      { numRuns: RUNS },
    );
  });

  it('on random bytes behind each kind of byte order mark and charset', () => {
    const prefix = fc.constantFrom(
      [0xef, 0xbb, 0xbf],
      [0xff, 0xfe],
      [0xfe, 0xff],
      [...new TextEncoder().encode('0 HEAD\n1 CHAR ANSEL\n')],
      [...new TextEncoder().encode('0 HEAD\n1 CHAR ASCII\n')],
      [...new TextEncoder().encode('0 HEAD\n1 CHAR UNICODE\n')],
    );
    fc.assert(
      fc.property(prefix, fc.uint8Array({ maxLength: 2000, size: 'max' }), (p, bytes) => {
        checkInvariants(parseGedcom(new Uint8Array([...p, ...bytes])));
      }),
      { numRuns: RUNS },
    );
  });

  it('on GEDCOM-like documents, and parse -> serialize -> parse is stable', () => {
    fc.assert(
      fc.property(document, (text) => {
        const first = parseGedcom(text);
        checkInvariants(first);
        const again = parseGedcom(serializeGedcom(first));
        expect(project(again.records)).toEqual(project(first.records));
        // Serializing is idempotent once normalized.
        expect(serializeGedcom(again)).toBe(serializeGedcom(first));
      }),
      { numRuns: RUNS },
    );
  });

  it('streaming matches whole-buffer parsing for any chunking', async () => {
    await fc.assert(
      fc.asyncProperty(document, fc.integer({ min: 1, max: 50 }), async (text, size) => {
        const bytes = new TextEncoder().encode(text);
        async function* chunks() {
          for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
        }
        const streamed = await parseGedcomStream(chunks());
        const whole = parseGedcom(bytes);
        expect(streamed.records).toEqual(whole.records);
        expect(streamed.lines).toEqual(whole.lines);
      }),
      { numRuns: 100 },
    );
  });
});

describe('fuzz: bounded time on hostile shapes', () => {
  it.each([
    ['one 5 MB line', 'x'.repeat(5_000_000)],
    ['200k blank lines', '\n'.repeat(200_000)],
    ['deep level staircase', Array.from({ length: 50_000 }, (_, i) => `${i % 100} T`).join('\n')],
    ['50k bare text lines', '0 HEAD\n1 NOTE a\n' + 'text\n'.repeat(50_000)],
    ['50k CONC lines', '0 HEAD\n1 NOTE a\n' + '2 CONC b\n'.repeat(50_000)],
    ['@ storms', '0 HEAD\n1 NOTE ' + '@'.repeat(100_000)],
  ])('%s', (_, text) => {
    const start = performance.now();
    const result = parseGedcom(text);
    serializeGedcom(result);
    checkInvariants(result);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
