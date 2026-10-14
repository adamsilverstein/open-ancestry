import { parseGedcom, serializeGedcom, subtreeLines } from '@open-ancestry/gedcom';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, importInto, notesOf, pid, rawText, row, rows, value } from './test-helpers';

const files = [
  'ancestry-sample.ged',
  'generated/synthetic-1000.ged',
  ...readdirSync(join(FIXTURES, 'gedcom'))
    .filter((f) => f.endsWith('.ged'))
    .map((f) => `gedcom/${f}`),
];

describe('line accounting and round trip for every fixture', () => {
  it.each(files)('%s: mapped + preserved == total; raw text reproduces the file', async (file) => {
    const bytes = readFileSync(join(FIXTURES, file));
    const doc = parseGedcom(bytes);
    const { store, report } = await importInto(bytes);

    expect(report.lines.total).toBe(doc.lines.total);
    expect(report.lines.mapped + report.lines.preserved).toBe(report.lines.total);

    // Every preserved line outside HEAD/SUBM/TRLR has an unmapped_line row, and no line has two.
    const rawOnly = doc.records
      .filter((r) => ['HEAD', 'SUBM', 'TRLR'].includes(r.tag))
      .reduce((n, r) => n + subtreeLines(r).length, 0);
    const unmapped = rows<{ line_no: number }>(store, 'SELECT line_no FROM unmapped_line');
    expect(unmapped.length).toBe(report.lines.preserved - rawOnly);
    expect(new Set(unmapped.map((u) => u.line_no)).size).toBe(unmapped.length);
    expect(report.unmapped.reduce((n, u) => n + u.count, 0)).toBe(unmapped.length);

    // Documented normalizations: no BOM, LF line endings, terminated last line.
    expect(rawText(store)).toBe(serializeGedcom(doc));
    expect(value(store, 'SELECT count(*) FROM raw_record')).toBe(doc.records.length);
  });
});

describe('parser edge-case fixtures', () => {
  it('gedcom7.ged: @VOID@ partner, v7 escapes, extension tags reported', async () => {
    const { store, report } = await importInto(readFileSync(join(FIXTURES, 'gedcom/gedcom7.ged')));
    expect(report.format).toBe('gedcom-7');
    expect(report.source.system).toBe('SampleApp');
    expect(
      row(store, "SELECT partner1_id, partner2_id FROM family WHERE external_id = '@F1@'"),
    ).toEqual({
      partner1_id: null,
      partner2_id: null,
    });
    expect(report.warnings.filter((w) => w.code === 'bad-pointer')).toEqual([]);
    expect(notesOf(store, 'person', pid(store, '@I1@'))).toEqual([
      '@handle on the forum\nsecond line with an email q@@b.example',
    ]);
    expect(report.unmapped.map((u) => u.path)).toContain('INDI._SKYPEID');
    const skype = report.unmapped.find((u) => u.path === 'INDI._SKYPEID')!;
    expect(skype).toMatchObject({
      tag: '_SKYPEID',
      count: 1,
      example: { line: 10, text: '1 _SKYPEID quill.b' },
    });
    expect(
      row(store, 'SELECT path, line_no, owner_type FROM unmapped_line WHERE line_no = 10'),
    ).toEqual({ path: 'INDI._SKYPEID', line_no: 10, owner_type: 'person' });
  });

  it('malformed.ged: keeps duplicates, preamble and bad lines, with warnings', async () => {
    const { store, report } = await importInto(
      readFileSync(join(FIXTURES, 'gedcom/malformed.ged')),
    );
    expect(value(store, 'SELECT count(*) FROM person')).toBe(3);
    const codes = new Set(report.warnings.map((w) => w.code));
    expect(codes).toContain('duplicate-xref');
    expect(codes).toContain('missing-trlr');
    expect(row(store, "SELECT line, line_no FROM unmapped_line WHERE path = '(preamble)'")).toEqual(
      { line: 'this is not gedcom', line_no: 1 },
    );
    const names = rows<{ full_text: string }>(
      store,
      'SELECT full_text FROM person_name ORDER BY full_text',
    );
    expect(names.map((n) => n.full_text)).toEqual([
      'Bad�� /Bytes/',
      'Duplicate /Record/',
      'Truncated /File/',
    ]);
    expect(report.warnings.every((w) => typeof w.line === 'number' && w.message)).toBe(true);
  });

  it('ancestry-quirks.ged: bare-text note lines, person-level citation, long custom line', async () => {
    const { store, report } = await importInto(
      readFileSync(join(FIXTURES, 'gedcom/ancestry-quirks.ged')),
    );
    const [note] = notesOf(store, 'person', pid(store, '@I1@'));
    expect(note).toContain('from 1871 until her death');
    expect(note).toContain('the harvest every autumn.');
    expect(note).toContain('\nAncestry wrote this paragraph without a CONT tag.');
    expect(note).toContain('\n\nAnd this one after a blank line.');
    expect(
      rows(
        store,
        `SELECT c.apid FROM citation_link l JOIN citation c ON c.id = l.citation_id
         WHERE l.owner_type = 'person' AND l.owner_id = ?`,
        pid(store, '@I1@'),
      ),
    ).toEqual([{ apid: '1,7602::12345' }]);
    expect(report.unmapped.map((u) => u.path)).toEqual(['INDI._LONG']);
  });

  it.each([
    ['cp1252.ged', 'José /Peña/'],
    ['utf16le.ged', null],
    ['ansel.ged', null],
  ])('%s decodes names', async (file, expected) => {
    const { store, report } = await importInto(readFileSync(join(FIXTURES, 'gedcom', file)));
    const names = rows<{ full_text: string }>(store, 'SELECT full_text FROM person_name');
    expect(names.length).toBeGreaterThan(0);
    if (expected) expect(names[0]!.full_text).toBe(expected);
    expect(names.every((n) => !n.full_text.includes('�'))).toBe(true);
    expect(report.lines.mapped + report.lines.preserved).toBe(report.lines.total);
  });
});
