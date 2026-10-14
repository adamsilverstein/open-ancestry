import { generateGedcom } from '../../fixtures/generate';
import { openMemoryTree, type TreeStore } from '../../packages/db/src/index';
import {
  applyReimport,
  closeReimport,
  importGedcom,
  prepareReimport,
  type ReimportSession,
} from '../../packages/import/src/index';
import type { BenchCase } from '../types';

// Issue #56: diffing a 10k-person tree against a modified 10k export takes under 5s.

/**
 * A later export of the same tree: every xref renumbered (as Ancestry does),
 * every 25th birth date refined to a day in the same year, every 40th person given a new residence and
 * 50 new people appended.
 */
export function laterExport(text: string): string {
  let births = 0;
  let people = 0;
  const lines = text
    .replace(/@([A-Z]+)(\d+)@/g, (_, p: string, n: string) => `@${p}${Number(n) + 500000}@`)
    .split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // A refined birth date in the same year, as research usually produces.
    const year = /(\d{4})\s*$/.exec(lines[i + 1] ?? '')?.[1];
    if (
      line.startsWith('1 BIRT') &&
      ++births % 25 === 0 &&
      year &&
      lines[i + 1]?.startsWith('2 DATE ')
    ) {
      out.push(line, `2 DATE 1 JAN ${year}`);
      i++;
      continue;
    }
    out.push(line);
    if (/^0 @I\d+@ INDI$/.test(line) && ++people % 40 === 0) {
      out.push('1 RESI', '2 DATE 1930', '2 PLAC Larchmont Vale, Quill County, Oregon, USA');
    }
  }
  const extra = Array.from({ length: 50 }, (_, n) =>
    [
      `0 @I${900000 + n}@ INDI`,
      `1 NAME Newcomer${n} /Fairweather/`,
      '1 SEX F',
      '1 BIRT',
      `2 DATE ${1950 + n}`,
    ].join('\n'),
  ).join('\n');
  return out.join('\n').replace('0 TRLR', `${extra}\n0 TRLR`);
}

let base = '';
let later = '';
let tree: TreeStore | undefined;
let session: ReimportSession | undefined;

async function freshTree() {
  tree?.close();
  tree = openMemoryTree();
  await importGedcom({ bytes: base }, tree);
  return tree;
}

export default [
  {
    name: 'reimport: diff a 10k tree against a modified 10k export',
    setup: async () => {
      base ||= generateGedcom({ people: 10_000, seed: 1 });
      later ||= laterExport(base);
      await freshTree();
    },
    fn: async () => {
      const session = await prepareReimport(tree!, { bytes: later });
      if (session.diff.counts.newPeople !== 50) {
        throw new Error(`expected 50 new people, got ${session.diff.counts.newPeople}`);
      }
      closeReimport(session);
    },
    budgetMs: 5000,
    metric: 'mean',
    iterations: 3,
    time: 0,
    warmupIterations: 1,
  },
  {
    // Only the apply is timed: each run gets a fresh tree and review, untimed.
    name: 'reimport: apply every default change (10k tree)',
    setup: () => {
      base ||= generateGedcom({ people: 10_000, seed: 1 });
      later ||= laterExport(base);
    },
    beforeEach: async () => {
      const store = await freshTree();
      session = await prepareReimport(store, { bytes: later });
    },
    fn: () => {
      const accepted = new Set(
        session!.diff.people.flatMap((p) =>
          p.changes.filter((c) => c.defaultAccept).map((c) => c.id),
        ),
      );
      applyReimport(tree!, session!, accepted, 'Re-import');
      closeReimport(session!);
    },
    budgetMs: 5000,
    metric: 'mean',
    iterations: 2,
    time: 0,
    warmupIterations: 0,
  },
] satisfies BenchCase[];
