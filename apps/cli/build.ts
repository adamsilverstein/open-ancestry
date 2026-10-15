import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, type BuildOptions } from 'esbuild';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

await rm(here('./dist'), { recursive: true, force: true });

// Bundle the CLI and our workspace packages (which ship as TypeScript source)
// into one ESM file. Third-party dependencies stay external and load from
// node_modules, which keeps native modules like better-sqlite3 working.
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  plugins: [
    {
      name: 'externalize-third-party',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@open-ancestry/') ? undefined : { path: args.path, external: true },
        );
      },
    },
  ],
} satisfies BuildOptions;

await build({
  ...shared,
  entryPoints: [here('./src/cli.ts')],
  outfile: here('./dist/cli.js'),
  banner: { js: '#!/usr/bin/env node' },
});

// Imports run in a worker thread (apps/server import-runner.ts), which needs
// its own entry file next to cli.js.
await build({
  ...shared,
  entryPoints: [here('../server/src/import-worker.ts')],
  outfile: here('./dist/import-worker.js'),
});

await cp(here('../web/dist'), here('./dist/public'), { recursive: true });
