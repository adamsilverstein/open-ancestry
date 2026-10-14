import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateGedcom } from '../../../fixtures/generate';
import { decodeGedcom } from './encoding';
import { parseGedcom } from './parser';
import { serializeGedcom } from './serialize';
import { project } from './test-utils';
import type { GedcomNode, ParseResult } from './types';

const root = join(import.meta.dirname, '../../../fixtures');
const read = (path: string) => new Uint8Array(readFileSync(join(root, path)));
const find = (node: GedcomNode | undefined, ...tags: string[]): GedcomNode | undefined =>
  tags.reduce<GedcomNode | undefined>((n, t) => n?.children.find((c) => c.tag === t), node);
const codes = (r: ParseResult) => r.warnings.map((w) => w.code);

/**
 * The only differences between a source file and `serializeGedcom` of its
 * parse: no BOM, `\n` line endings and a terminator on the last line.
 */
function normalize(text: string): string {
  const body = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  return body.endsWith('\n') ? body : body + '\n';
}

function expectLossless(bytes: Uint8Array) {
  const parsed = parseGedcom(bytes);
  const out = serializeGedcom(parsed);
  expect(out).toBe(normalize(decodeGedcom(bytes).text));
  expect(project(parseGedcom(out).records)).toEqual(project(parsed.records));
  const { total, nodes, continuations, blank, skipped } = parsed.lines;
  expect(nodes + continuations + blank + skipped).toBe(total);
  return parsed;
}

describe('fixtures/ancestry-sample.ged', () => {
  const result = expectLossless(read('ancestry-sample.ged'));

  it('parses cleanly with every record and line accounted for', () => {
    expect(result.warnings).toEqual([]);
    expect(result.encoding).toMatchObject({ encoding: 'utf-8', bom: true });
    expect(result.records.filter((r) => r.tag === 'INDI')).toHaveLength(26);
    expect(result.lineCount).toBe(475);
    expect(result.lines.blank).toBe(0);
  });

  it('merges the CONC mid-word split and the CONT line (lines 112-114)', () => {
    const owner = result.records.find((r) => r.children.some((c) => c.line === 112));
    const note = owner?.children.find((c) => c.line === 112);
    expect(note?.value).toBe(
      'Lavinia kept the family Bible, which records every birth in the Corran line from 1862 onward in her own hand.\nThe Bible later passed to her granddaughter Mabel.',
    );
  });

  it('keeps every Ancestry custom tag in the tree', () => {
    const tags = new Set<string>();
    const visit = (n: GedcomNode) => {
      tags.add(n.tag);
      n.children.forEach(visit);
    };
    result.records.forEach(visit);
    for (const tag of [
      '_APID',
      '_MTTAG',
      '_MTCAT',
      '_OID',
      '_PRIM',
      '_PHOTO',
      '_FREL',
      '_MREL',
      '_MILT',
      '_TREE',
    ]) {
      expect(tags).toContain(tag);
    }
  });
});

describe('fixtures/generated/synthetic-1000.ged', () => {
  it('parses without warnings and round-trips', () => {
    const result = expectLossless(read('generated/synthetic-1000.ged'));
    expect(result.warnings).toEqual([]);
    expect(result.records.filter((r) => r.tag === 'INDI')).toHaveLength(1000);
  });
});

describe('fixtures/gedcom', () => {
  it('gedcom7.ged: version 7, SCHMA, @VOID@ and leading @@ only', () => {
    const result = expectLossless(read('gedcom/gedcom7.ged'));
    expect(result.warnings).toEqual([]);
    expect(result.header).toMatchObject({
      majorVersion: 7,
      schema: { _SKYPEID: expect.any(String) },
    });
    expect(find(result.index.get('@F1@'), 'HUSB')?.pointer).toBe('@VOID@');
    expect(find(result.index.get('@I1@'), 'NOTE')?.value).toBe(
      '@handle on the forum\nsecond line with an email q@@b.example',
    );
  });

  it('ansel.ged: ANSEL diacritics and CR line endings', () => {
    const result = expectLossless(read('gedcom/ansel.ged'));
    expect(result.encoding).toMatchObject({ encoding: 'ansel', source: 'header' });
    const indi = result.index.get('@I1@');
    expect(find(indi, 'NAME')?.value).toBe('René /Müller/');
    expect(find(indi, 'BIRT', 'PLAC')?.value).toBe('Kraków, Łódź');
    expect(find(indi, 'NOTE')?.value).toBe('Price £5, © 1901, dot-below+circumflex: ậ');
  });

  it('utf16le.ged: UTF-16 with BOM and CRLF', () => {
    const result = expectLossless(read('gedcom/utf16le.ged'));
    expect(result.encoding).toMatchObject({ encoding: 'utf-16le', source: 'bom' });
    expect(find(result.index.get('@I1@'), 'NAME')?.value).toBe('Łucja /Wróblewska/');
    expect(find(result.index.get('@I1@'), 'NOTE')?.value).toBe('日本語のメモ');
  });

  it('cp1252.ged: Windows-1252 declared as ANSI', () => {
    const result = expectLossless(read('gedcom/cp1252.ged'));
    expect(find(result.index.get('@I1@'), 'NAME')?.value).toBe('José /Peña/');
    expect(find(result.index.get('@I1@'), 'NOTE')?.value).toBe('“quoted” €20');
  });

  it('ancestry-quirks.ged: bare-text lines, CONC spacing, long lines, indentation', () => {
    const result = expectLossless(read('gedcom/ancestry-quirks.ged'));
    expect(result.header.ancestry).toBeDefined();
    const indi = result.index.get('@I1@');
    expect(find(indi, 'NAME')?.value).toBe('Wren /Thistlewood/');
    expect(find(indi, 'NOTE')?.value).toBe(
      'Wren kept a diary from 1871 until her death. She wrote about the harvest every autumn.\n' +
        'Ancestry wrote this paragraph without a CONT tag.\n\nAnd this one after a blank line.',
    );
    expect(find(indi, '_LONG')?.value?.length).toBeGreaterThan(255);
    expect(codes(result).filter((c) => c === 'broken-line')).toHaveLength(3);
    expect(result.lines).toEqual({
      total: 20,
      nodes: 15,
      continuations: 5,
      blank: 0,
      skipped: 0,
      detached: 0,
    });
  });

  it('malformed.ged: warnings with line numbers, nothing thrown', () => {
    const bytes = read('gedcom/malformed.ged');
    const result = parseGedcom(bytes);
    expect(serializeGedcom(result)).toBe(decodeGedcom(bytes).text);
    expect(result.warnings.map((w) => [w.code, w.line])).toEqual([
      ['invalid-bytes', 0],
      ['skipped-line', 1],
      ['replacement-char', 5],
      ['level-jump', 7],
      ['misplaced-continuation', 9],
      ['duplicate-xref', 10],
      ['missing-trlr', 0],
    ]);
    expect(find(result.index.get('@I1@'), 'NAME')?.value).toBe('Bad\uFFFD\uFFFD /Bytes/');
    expect(result.index.get('@I2@')).toBeDefined();
    expect(result.lines).toEqual({
      total: 13,
      nodes: 12,
      continuations: 0,
      blank: 0,
      skipped: 1,
      detached: 1,
    });
  });
});

describe('generated 10k-person file', () => {
  it('parses without warnings', () => {
    const result = parseGedcom(generateGedcom({ people: 10_000, seed: 2 }));
    expect(result.warnings).toEqual([]);
    expect(result.records.filter((r) => r.tag === 'INDI')).toHaveLength(10_000);
  });
});
