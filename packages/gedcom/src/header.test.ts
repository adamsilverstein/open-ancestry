import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeHeader } from './header';
import { parseGedcom } from './parser';

const fixtures = join(import.meta.dirname, '../../../fixtures');

describe('analyzeHeader', () => {
  it('detects an Ancestry.com 5.5.1 export', () => {
    const result = parseGedcom(readFileSync(join(fixtures, 'ancestry-sample.ged')));
    expect(result.header).toEqual({
      version: '5.5.1',
      majorVersion: 5,
      form: 'LINEAGE-LINKED',
      charset: 'UTF-8',
      source: {
        system: 'Ancestry.com Family Trees',
        name: 'Ancestry.com Member Trees',
        version: '2024.12',
        corp: 'Ancestry.com',
        data: 'Ashgrove Family Tree',
      },
      ancestry: { treeName: 'Ashgrove Family Tree', treeId: '200000042', env: 'prd' },
      submitter: '@SUBM1@',
      schema: {},
    });
  });

  it('reads GEDCOM 7 version and SCHMA extension tags', () => {
    const result = parseGedcom(
      [
        '0 HEAD',
        '1 GEDC',
        '2 VERS 7.0.14',
        '1 SCHMA',
        '2 TAG _SKYPEID http://xmlns.com/foaf/0.1/skypeID',
        '2 TAG _MEMBER http://xmlns.com/foaf/0.1/member',
        '2 TAG _BROKEN',
        '1 SOUR ExampleApp',
        '2 VERS 1.2',
        '1 DEST Other',
        '1 DATE 1 JAN 2026',
        '1 LANG en-US',
        '1 FILE family.ged',
        '0 TRLR',
      ].join('\n'),
    );
    expect(result.header).toEqual({
      version: '7.0.14',
      majorVersion: 7,
      source: { system: 'ExampleApp', version: '1.2' },
      destination: 'Other',
      date: '1 JAN 2026',
      language: 'en-US',
      filename: 'family.ged',
      schema: {
        _SKYPEID: 'http://xmlns.com/foaf/0.1/skypeID',
        _MEMBER: 'http://xmlns.com/foaf/0.1/member',
      },
    });
  });

  it('returns an empty header when HEAD is missing', () => {
    expect(analyzeHeader(undefined)).toEqual({ schema: {} });
  });

  it('ignores a non-numeric version', () => {
    const head = parseGedcom('0 HEAD\n1 GEDC\n2 VERS draft\n').records[0];
    expect(analyzeHeader(head)).toEqual({ version: 'draft', schema: {} });
  });
});
