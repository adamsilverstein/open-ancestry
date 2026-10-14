/**
 * Fails when the web app's initial JS (the entry chunk plus everything it
 * statically imports) exceeds the budget in docs/spec/design.md section 7.
 * Lazy route chunks are excluded: they load after first render.
 *
 * Usage: npm run build -w @open-ancestry/web && npm run size
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
}

const budgetBytes = 150_000;
const dist = join(import.meta.dirname, '..', 'apps', 'web', 'dist');
const manifest = JSON.parse(await readFile(join(dist, '.vite', 'manifest.json'), 'utf8')) as Record<
  string,
  ManifestChunk
>;

const entry = Object.keys(manifest).find((key) => manifest[key]?.isEntry);
if (!entry) throw new Error('No entry chunk in the Vite manifest. Build the web app first.');

const initial = new Set<string>();
const visit = (key: string) => {
  if (initial.has(key)) return;
  initial.add(key);
  for (const child of manifest[key]?.imports ?? []) visit(child);
};
visit(entry);

let total = 0;
const rows: string[] = [];
for (const key of initial) {
  const file = manifest[key]!.file;
  const size = gzipSync(await readFile(join(dist, file))).length;
  total += size;
  rows.push(`  ${(size / 1000).toFixed(1).padStart(7)} kB  ${file}`);
}

console.log(`Initial JS (gzip):\n${rows.join('\n')}`);
console.log(
  `  ${(total / 1000).toFixed(1).padStart(7)} kB  total, budget ${budgetBytes / 1000} kB`,
);
if (total > budgetBytes) {
  console.error(`Initial JS is over budget by ${((total - budgetBytes) / 1000).toFixed(1)} kB.`);
  process.exit(1);
}
