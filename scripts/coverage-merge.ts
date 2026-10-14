/**
 * Merges unit (Vitest) and e2e (instrumented web build) istanbul coverage with
 * nyc into coverage/merged, then writes a per-workspace markdown summary to
 * coverage/summary.md for the CI job summary and PR comment.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

interface Metric {
  total: number;
  covered: number;
  pct: number | 'Unknown';
}
type Metrics = Record<'lines' | 'statements' | 'functions' | 'branches', Metric>;
type Summary = Record<string, Metrics>;

const root = join(import.meta.dirname, '..');
const coverageDir = join(root, 'coverage');
const unitFile = join(coverageDir, 'unit', 'coverage-final.json');
const e2eRawDir = join(coverageDir, 'e2e', 'raw');
const metricKeys = ['lines', 'statements', 'functions', 'branches'] as const;

/**
 * Minimum merged (unit + e2e) line coverage. Apps are gated here rather than
 * in vitest.config.ts so UI code can be covered by e2e instead of shallow unit
 * tests. Ratchet up, never down.
 */
const mergedLineThresholds: Record<string, number> = {
  total: 80,
  'apps/web': 80,
  'apps/server': 80,
  'apps/cli': 70,
};

async function e2eFiles(): Promise<string[]> {
  if (!existsSync(e2eRawDir)) return [];
  const names = await readdir(e2eRawDir);
  return names.filter((name) => name.endsWith('.json')).map((name) => join(e2eRawDir, name));
}

/** Runs `nyc report` over a set of istanbul JSON files. */
async function report(name: string, inputs: string[], reporters: string[]): Promise<string> {
  const tempDir = join(coverageDir, '.tmp', name);
  const reportDir = join(coverageDir, name === 'merged' ? 'merged' : join(name, 'report'));
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  await Promise.all(inputs.map((file, i) => copyFile(file, join(tempDir, `${i}.json`))));
  execFileSync(
    'npx',
    [
      'nyc',
      'report',
      '--temp-dir',
      tempDir,
      '--report-dir',
      reportDir,
      '--cwd',
      root,
      ...reporters.flatMap((r) => ['--reporter', r]),
    ],
    { cwd: root, stdio: 'inherit' },
  );
  return reportDir;
}

async function readSummary(dir: string): Promise<Summary> {
  return JSON.parse(await readFile(join(dir, 'coverage-summary.json'), 'utf8')) as Summary;
}

/** Groups file paths by workspace, e.g. packages/core or apps/web. */
function workspaceOf(file: string): string {
  const parts = relative(root, file).split(/[\\/]/);
  return parts.length > 2 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? file);
}

function pct(m: Metric): string {
  return m.total === 0 ? '-' : `${((m.covered / m.total) * 100).toFixed(1)}%`;
}

function aggregate(summary: Summary): Map<string, Metrics> {
  const groups = new Map<string, Metrics>();
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === 'total') continue;
    const key = workspaceOf(file);
    const group =
      groups.get(key) ??
      (Object.fromEntries(
        metricKeys.map((k) => [k, { total: 0, covered: 0, pct: 0 }]),
      ) as unknown as Metrics);
    for (const k of metricKeys) {
      group[k].total += metrics[k].total;
      group[k].covered += metrics[k].covered;
    }
    groups.set(key, group);
  }
  return groups;
}

function row(label: string, m: Metrics): string {
  return `| ${label} | ${metricKeys.map((k) => pct(m[k])).join(' | ')} |`;
}

const unit = existsSync(unitFile) ? [unitFile] : [];
const e2e = await e2eFiles();
if (unit.length === 0 && e2e.length === 0) {
  console.error('No coverage found. Run `npm test` and `npm run e2e:coverage` first.');
  process.exit(1);
}

const mergedDir = await report(
  'merged',
  [...unit, ...e2e],
  ['html', 'json-summary', 'text-summary'],
);
const merged = await readSummary(mergedDir);
const groups = aggregate(merged);
const failures = Object.entries(mergedLineThresholds).flatMap(([key, min]) => {
  const m = key === 'total' ? merged.total : groups.get(key);
  if (!m || m.lines.total === 0) return [];
  const actual = (m.lines.covered / m.lines.total) * 100;
  return actual < min ? [`${key}: lines ${actual.toFixed(1)}% < ${min}%`] : [];
});
const lines = [
  '## Coverage',
  '',
  '| Workspace | Lines | Statements | Functions | Branches |',
  '| --- | --- | --- | --- | --- |',
  ...[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([k, m]) => row(k, m)),
  row('**Total (unit + e2e)**', merged.total as Metrics),
];

if (unit.length > 0) {
  lines.push(row('Unit only', (await readSummary(join(coverageDir, 'unit'))).total as Metrics));
}
if (e2e.length > 0) {
  const e2eDir = await report('e2e', e2e, ['json-summary']);
  lines.push(row('E2E only (web)', (await readSummary(e2eDir)).total as Metrics));
}
lines.push(
  '',
  failures.length > 0
    ? `**Below merged threshold:** ${failures.join('; ')}`
    : `Merged line thresholds met (${Object.entries(mergedLineThresholds)
        .map(([k, v]) => `${k} ${v}%`)
        .join(', ')}).`,
  '',
  `Unit inputs: ${unit.length}, e2e inputs: ${e2e.length}. HTML report: \`coverage/merged\`.`,
);

await rm(join(coverageDir, '.tmp'), { recursive: true, force: true });
const markdown = `${lines.join('\n')}\n`;
await writeFile(join(coverageDir, 'summary.md'), markdown);
console.log(markdown);
if (failures.length > 0) {
  console.error(`Merged coverage below threshold: ${failures.join('; ')}`);
  process.exit(1);
}
