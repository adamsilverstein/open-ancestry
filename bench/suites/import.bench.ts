import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateGedcom } from '../../fixtures/generate';
import { openMemoryTree } from '../../packages/db/src/index';
import { importGedcom } from '../../packages/import/src/index';
import type { BenchCase } from '../types';
import { makeTempDir } from '../../fixtures/temp-dir';

// design.md section 7: a 10k-person Ancestry GEDCOM imports in under 3s,
// 100k in under 30s (parse + map + load + search index). The on-disk case is
// what users wait for: a new .oatree folder in WAL mode, closed at the end.
const inputs = new Map<number, Uint8Array>();
const input = (people: number) => {
  let bytes = inputs.get(people);
  if (!bytes) {
    bytes = new TextEncoder().encode(generateGedcom({ people, seed: 1 }));
    inputs.set(people, bytes);
  }
  return bytes;
};

async function run(people: number) {
  const store = openMemoryTree();
  const report = await importGedcom({ bytes: input(people) }, store);
  store.close();
  if (report.records.INDI !== people) throw new Error(`imported ${report.records.INDI} people`);
}

// What a user waits for on the first run (#117): a fresh `open-ancestry import`
// process, so no warm JIT, writing a new tree to disk. A tiny --import hook
// reports the child's peak RSS when it exits.
const cli = join(import.meta.dirname, '..', '..', 'apps', 'cli', 'dist', 'cli.js');
const PEAK_HOOK = `data:text/javascript,process.on('exit',()=>process.stderr.write('OA_PEAK_RSS_KB='+process.resourceUsage().maxRSS+'\\n'))`;
const files = new Map<number, string>();
const peaks = new Map<number, number>();

function fixtureFile(people: number): string {
  if (!existsSync(cli)) throw new Error(`${cli} is missing; run npm run build first`);
  let file = files.get(people);
  if (!file) {
    file = join(makeTempDir('oa-bench-ged-'), `synthetic-${people}.ged`);
    writeFileSync(file, input(people));
    files.set(people, file);
  }
  return file;
}

function coldCli(people: number) {
  const library = makeTempDir('oa-bench-cli-');
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        PEAK_HOOK,
        cli,
        'import',
        fixtureFile(people),
        '--library',
        library,
        '--name',
        'b',
      ],
      { encoding: 'utf8' },
    );
    if (child.status !== 0) throw new Error(`CLI import failed: ${child.stderr}`);
    const kb = Number(/OA_PEAK_RSS_KB=(\d+)/.exec(child.stderr)?.[1]);
    peaks.set(people, Math.max(peaks.get(people) ?? 0, kb / 1024));
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
}

async function runOnDisk(people: number) {
  const root = makeTempDir('oa-bench-');
  try {
    const report = await importGedcom({ bytes: input(people) }, { dir: join(root, 'b.oatree') });
    if (report.records.INDI !== people) throw new Error(`imported ${report.records.INDI} people`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export default [
  {
    name: 'import: 10k-person Ancestry GEDCOM',
    setup: () => input(10_000),
    fn: async () => await run(10_000),
    budgetMs: 3000,
    metric: 'mean',
    iterations: 5,
    time: 0,
    warmupIterations: 1,
  },
  {
    name: 'import: 10k-person Ancestry GEDCOM into a tree on disk',
    setup: () => input(10_000),
    fn: async () => await runOnDisk(10_000),
    budgetMs: 3000,
    metric: 'mean',
    iterations: 5,
    time: 0,
    warmupIterations: 1,
  },
  {
    name: 'import: 10k-person GEDCOM, cold CLI process',
    setup: () => fixtureFile(10_000),
    fn: () => coldCli(10_000),
    budgetMs: 3000,
    metric: 'mean',
    iterations: 3,
    time: 0,
    warmupIterations: 0,
    peakMemoryMB: () => peaks.get(10_000),
  },
  {
    name: 'import: 100k-person GEDCOM, cold CLI process',
    setup: () => fixtureFile(100_000),
    fn: () => coldCli(100_000),
    budgetMs: 30_000,
    metric: 'mean',
    iterations: 1,
    time: 0,
    warmupIterations: 0,
    peakMemoryMB: () => peaks.get(100_000),
    memoryBudgetMB: 2048,
  },
  {
    // One person with 50k families and a matching MARR on both sides: the
    // marriage matching and FAMS duplicate checks were quadratic (102s for
    // 20k before the security review fixes).
    name: 'import: one person with 50k families (MARR + FAMS)',
    setup: () => manyFamilies(50_000),
    fn: async () => {
      const store = openMemoryTree();
      const report = await importGedcom({ bytes: manyFamilies(50_000) }, store);
      store.close();
      if (report.records.FAM !== 50_000) throw new Error(`imported ${report.records.FAM} families`);
    },
    budgetMs: 8000,
    metric: 'mean',
    iterations: 1,
    time: 0,
    warmupIterations: 0,
  },
] satisfies BenchCase[];

let manyFamiliesInput: string | undefined;
function manyFamilies(n: number): string {
  if (manyFamiliesInput) return manyFamiliesInput;
  const lines = ['0 HEAD', '1 CHAR UTF-8', '0 @I1@ INDI', '1 NAME Ada /Vale/'];
  for (let i = 0; i < n; i++) lines.push(`1 FAMS @F${i}@`);
  for (let i = 0; i < n; i++)
    lines.push('1 MARR', `2 DATE 1 JAN ${1000 + (i % 900)}`, `2 PLAC Town ${i}`);
  for (let i = 0; i < n; i++) {
    lines.push(
      `0 @F${i}@ FAM`,
      '1 HUSB @I1@',
      '1 MARR',
      `2 DATE 1 JAN ${1000 + (i % 900)}`,
      `2 PLAC Town ${i}`,
    );
  }
  lines.push('0 TRLR', '');
  manyFamiliesInput = lines.join('\n');
  return manyFamiliesInput;
}
