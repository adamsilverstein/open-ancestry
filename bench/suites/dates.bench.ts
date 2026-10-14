import { parseDate } from '../../packages/core/src/dates';
import type { BenchCase } from '../types';

// A realistic mix of GEDCOM, Ancestry and hand-typed dates (design.md section 7).
const SAMPLES = [
  '5 SEP 1941',
  'ABT 1890',
  'BET 1890 AND 1895',
  'BEF 12 MAR 1850',
  'FROM 1890 TO 1895',
  '05/28/1960',
  '1941-09-05',
  '2010-2019',
  'abt 1890',
  'c. 1890',
  'Sep 5, 1941',
  '5 Sept 1941',
  '11 FEB 1731/32',
  '@#DJULIAN@ 5 SEP 1700',
  '44 B.C.',
  'INT 1941 (the war year)',
  'unknown',
  'SEP 1941',
  '1941',
  'aft. 1 jan 1900',
];

let inputs: string[] = [];

export default [
  {
    name: 'dates: parse 100k mixed date strings',
    setup: () => {
      // Vary the year so no caching could hide the parsing cost.
      inputs = Array.from({ length: 100_000 }, (_, i) =>
        SAMPLES[i % SAMPLES.length]!.replace(/1[89]\d\d/, String(1800 + (i % 200))),
      );
    },
    fn: () => {
      for (const text of inputs) parseDate(text);
    },
    budgetMs: 150,
  },
] satisfies BenchCase[];
