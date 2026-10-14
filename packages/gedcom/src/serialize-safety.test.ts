import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseGedcom } from './parser';
import { GedcomSerializeError, serializeGedcom, serializeNode, valueLines } from './serialize';
import type { GedcomNode } from './types';

const node = (partial: Partial<GedcomNode> & Pick<GedcomNode, 'level' | 'tag'>): GedcomNode => ({
  children: [],
  line: 0,
  ...partial,
});

function expectCode(fn: () => unknown, code: GedcomSerializeError['code']) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GedcomSerializeError);
    expect((error as GedcomSerializeError).code).toBe(code);
    return;
  }
  throw new Error(`expected GedcomSerializeError ${code}`);
}

describe('edited values cannot inject lines', () => {
  it.each([
    ['CR', '\r'],
    ['CRLF', '\r\n'],
    ['LF', '\n'],
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
    ['NEL', '\u0085'],
  ])('turns %s into CONT', (_, br) => {
    const out = serializeNode(node({ level: 0, tag: 'NOTE', value: `a${br}0 @X@ INDI` }));
    expect(out).toBe('0 NOTE a\n1 CONT 0 @X@ INDI\n');
    const doc = parseGedcom(out);
    expect(doc.records).toHaveLength(1);
    expect(doc.index.has('@X@')).toBe(false);
    expect(doc.records[0]!.value).toBe('a\n0 @X@ INDI');
  });

  it('drops C0 controls other than tab', () => {
    const out = serializeNode(node({ level: 1, tag: 'NOTE', value: 'a\u0000b\u001bc\u000bd\te' }));
    expect(out).toBe('1 NOTE abcd\te\n');
  });

  it('re-encodes a hand-built raw value that contains a line break', () => {
    const n = node({ level: 1, tag: 'NOTE', value: 'a\nb', rawValue: 'a\nb' });
    expect(serializeNode(n)).toBe('1 NOTE a\n2 CONT b\n');
  });

  it('re-encodes hand-built continuations that contain a line break', () => {
    const n = node({
      level: 1,
      tag: 'NOTE',
      value: 'ab\n0 X',
      rawValue: 'a',
      continuations: [{ tag: 'CONC', level: 2, line: 0, value: 'b\n0 X' }],
    });
    expect(serializeNode(n)).toBe('1 NOTE ab\n2 CONT 0 X\n');
  });
});

describe('CONC splitting', () => {
  it('never cuts inside a surrogate pair or an @ run', () => {
    const value = '\u{1F600}'.repeat(20) + '@@@@@@' + 'x@@y'.repeat(10);
    for (const version of [5, 7]) {
      const out = serializeNode(node({ level: 0, tag: 'NOTE', value }), {
        maxLineLength: 12,
        version,
      });
      for (const l of out.trimEnd().split('\n')) {
        expect(l).not.toMatch(/[\uD800-\uDBFF]$/);
        expect(l).not.toMatch(/^1 CONC [\uDC00-\uDFFF]/);
      }
      const head = version === 7 ? '0 HEAD\n1 GEDC\n2 VERS 7.0\n' : '';
      const doc = parseGedcom(head + out);
      expect(doc.records.at(-1)!.value).toBe(value);
    }
  });
});

describe('CONC splitting of an unsplittable run', () => {
  it('keeps a run of @ longer than the line limit on one line', () => {
    const value = 'ab' + '@'.repeat(40);
    const out = serializeNode(node({ level: 0, tag: 'NOTE', value }), { maxLineLength: 10 });
    expect(parseGedcom(out).records[0]!.value).toBe(value);
    expect(out.trimEnd().split('\n').at(-1)).toMatch(/^1 CONC b@{40}$/);
  });
});

describe('unedited source text', () => {
  it('is kept exactly, including characters other readers treat as breaks', () => {
    const src = '0 @I1@ INDI\n  1 NOTE a\u2028b\u0085c\n';
    expect(serializeNode(parseGedcom(src).records[0]!)).toBe(src);
  });

  it('is never emitted when a hand-built node carries a line break in it', () => {
    const n = node({ level: 1, tag: 'NAME', value: 'x', source: '1 NAME x\n0 @X@ INDI' });
    // The source does not tokenize to the same node, so it is not used at all.
    expect(serializeNode(n)).toBe('1 NAME x\n');
    const sneaky = node({ level: 1, tag: 'NAME', value: 'x', source: '1  NAME x\r' });
    expect(serializeNode(sneaky)).toBe('1 NAME x\n');
  });

  it('rejects extra and preamble lines that contain a line break', () => {
    const n = node({
      level: 1,
      tag: 'NAME',
      value: 'x',
      extra: [{ line: 2, text: '\n0 @X@ INDI' }],
    });
    expectCode(() => serializeNode(n), 'line-break-in-source');
    const doc = { records: [], header: { schema: {} }, preamble: [{ line: 1, text: 'a\rb' }] };
    expectCode(() => serializeGedcom(doc), 'line-break-in-source');
  });
});

describe('structure is validated', () => {
  it.each(['', 'NA ME', 'NAME\n0 X', 'A\tB', 'name', 'Ä', 'NAME\r'])('rejects tag %j', (tag) => {
    expectCode(() => serializeNode(node({ level: 1, tag })), 'invalid-tag');
  });

  it.each(['I1', '@I 1@', '@I1@\n0 X', '@@', '@I\u00001@', '@I1', '@I\u20281@'])(
    'rejects xref %j',
    (xref) => {
      expectCode(() => serializeNode(node({ level: 0, tag: 'INDI', xref })), 'invalid-xref');
    },
  );

  it.each(['F1', '@F 1@', '@F1@\r', '@#DJULIAN@', '@@'])('rejects pointer %j', (pointer) => {
    expectCode(() => serializeNode(node({ level: 1, tag: 'FAMS', pointer })), 'invalid-pointer');
  });

  it.each([-1, 1.5, 100, Number.NaN])('rejects level %d', (level) => {
    expectCode(() => serializeNode(node({ level, tag: 'NAME' })), 'invalid-level');
  });

  it('validates children too', () => {
    const parent = node({ level: 0, tag: 'INDI', children: [node({ level: 1, tag: 'BAD TAG' })] });
    expectCode(() => serializeNode(parent), 'invalid-tag');
  });

  it('rejects an eol that is not a line terminator', () => {
    expectCode(
      () => serializeNode(node({ level: 0, tag: 'X' }), { eol: '\n0 X\n' }),
      'invalid-eol',
    );
    expectCode(
      () => serializeGedcom({ records: [], header: { schema: {} } }, { eol: ' ' }),
      'invalid-eol',
    );
  });

  it('accepts @VOID@ and underscore tags', () => {
    expect(serializeNode(node({ level: 1, tag: '_Tree', pointer: '@VOID@' }))).toBe(
      '1 _Tree @VOID@\n',
    );
  });
});

describe('fuzz: serialize -> parse keeps records and values', () => {
  const piece = fc.oneof(
    fc.string({ unit: 'binary', maxLength: 20 }),
    fc.constantFrom(
      '\r',
      '\n',
      '\r\n',
      '\u2028',
      '\u2029',
      '\u0085',
      '\u0000',
      '\u001b',
      '\t',
      '@',
      '@@',
      ' ',
      '0 @X@ INDI',
    ),
  );
  const value = fc.array(piece, { maxLength: 12 }).map((parts) => parts.join(''));
  const normalized = (v: string) => valueLines(v).join('\n');

  it('for arbitrary values on a record and its children', () => {
    fc.assert(
      fc.property(
        value,
        fc.array(value, { maxLength: 5 }),
        fc.integer({ min: 0, max: 400 }),
        fc.constantFrom(5, 7),
        (head, kids, max, version) => {
          const record = node({
            level: 0,
            tag: 'NOTE',
            xref: '@N1@',
            value: head,
            children: kids.map((v) => node({ level: 1, tag: '_X', value: v })),
          });
          const out = serializeNode(record, {
            version,
            ...(max > 20 && { maxLineLength: max }),
          });
          // The parser learns the escaping rule from HEAD.
          const header = version === 7 ? '0 HEAD\n1 GEDC\n2 VERS 7.0\n' : '';
          const doc = parseGedcom(header + out);
          const records = doc.records.filter((r) => r.tag !== 'HEAD');
          expect(records).toHaveLength(1);
          const parsed = records[0]!;
          expect(parsed.value).toBe(normalized(head));
          expect(parsed.children.map((c) => c.value)).toEqual(kids.map(normalized));
        },
      ),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 500) },
    );
  });

  it('for arbitrary tags, xrefs and pointers: either a typed error or an exact round trip', () => {
    const text = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 8 }),
      fc.constantFrom('NAME', '_x', '@I1@', '@F 1@', '@\n@'),
    );
    fc.assert(
      fc.property(text, text, text, (tag, xref, pointer) => {
        const record = node({
          level: 0,
          tag,
          xref,
          children: [node({ level: 1, tag: 'FAMS', pointer })],
        });
        let out: string;
        try {
          out = serializeNode(record);
        } catch (error) {
          expect(error).toBeInstanceOf(GedcomSerializeError);
          return;
        }
        const doc = parseGedcom(out);
        expect(doc.records).toHaveLength(1);
        expect(doc.records[0]).toMatchObject({ tag, xref });
        expect(doc.records[0]!.children[0]?.pointer).toBe(pointer);
      }),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 500) },
    );
  });
});
