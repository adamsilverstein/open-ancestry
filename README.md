# open-ancestry

An open source, local-first, very fast family tree app. Import your Ancestry.com GEDCOM export and browse, search, edit and re-export your tree entirely on your own machine.

- Spec and acceptance criteria: [docs/spec/design.md](docs/spec/design.md)
- Implementation plan: [docs/spec/plan.md](docs/spec/plan.md)
- Design system: [docs/design-system.md](docs/design-system.md)
- Contributing: [AGENTS.md](AGENTS.md)

Status: under active initial development.

## Getting started

Requires Node 24 (`.nvmrc`).

```sh
nvm use
npm install
npm run build && npm start      # http://127.0.0.1:4317
```

To import, export your tree from Ancestry (below), open the app and drop the `.ged` file (or a GEDZIP `.zip`/`.gdz`) on the home page. The import report lists counts, warnings by line number and any tags that could not be mapped; nothing is dropped. Or use the command line:

```sh
node apps/cli/dist/cli.js import ~/Downloads/family.ged --name "Vale family" [--media ~/Downloads/family-media]
```

Trees are folders in your library (`~/OpenAncestry`, or `--library` / `$OA_LIBRARY`); switch, create, rename and delete them from the tree menu in the top bar. The server binds to `127.0.0.1` only.

### One person per computer account

Open Ancestry assumes the account that runs it is the only one that should see the library:

- The library, its trees and everything in them are created readable by your account alone (folders `0700`, files `0600`), and existing ones are tightened when they open.
- While the server runs, any program on this computer can reach it at `127.0.0.1`, including programs run by other accounts. Binding to loopback keeps other machines out, not other users of this one. On a shared computer, stop the server (Ctrl+C) when you're done.

## Development

```sh
npm run dev           # API (tsx watch, :4318 or $OA_PORT) + web (Vite HMR, :5173, proxies /api)
npm run lint          # ESLint + Prettier check
npm run format        # Prettier write
npm run typecheck     # tsc for root scripts and every workspace
npm test              # Vitest (all workspaces) with coverage + thresholds
npm run e2e           # build, then Playwright (Chromium + WebKit) against the CLI-served app
npm run coverage      # unit + instrumented e2e, merged into coverage/merged
npm run bench         # bench/suites/*.bench.ts, fails over budget
npm run fixtures      # regenerate synthetic GEDCOM in fixtures/generated
```

| Path | What |
| --- | --- |
| `packages/core` | Pure domain logic (dates, names, layout) |
| `packages/db` | SQLite schema and repositories (better-sqlite3) |
| `packages/gedcom` | GEDCOM parsing, export, GEDZIP |
| `packages/import` | GEDCOM/GEDZIP import into a tree (Ancestry adapter) |
| `packages/export` | GEDCOM 5.5.1 / 7 and GEDZIP export |
| `apps/server` | Fastify API and static SPA hosting |
| `apps/web` | Vite + React 19 SPA |
| `apps/cli` | `open-ancestry serve` and `open-ancestry import`, bundled with the web build |
| `e2e/` | Playwright tests; import `test` from `e2e/fixtures.ts` so coverage is collected |
| `bench/` | tinybench harness; add `bench/suites/<area>.bench.ts` |
| `fixtures/` | Synthetic Ancestry-style GEDCOM; see [fixtures/README.md](fixtures/README.md) |

Workspace packages export TypeScript source (`"exports": "./src/index.ts"`); Vite, Vitest, tsx and the CLI's esbuild bundle compile it, so there is no per-package build step. Each workspace folder is a Vitest project automatically; add a `vitest.config.ts` only if it needs a special environment.

## Exporting from Ancestry

Trees > (your tree) > Tree Settings > Export tree > Download. You get a `.ged` (GEDCOM 5.5.1) file. Photos are not included in Ancestry's export; see the spec for media options.

## License

MIT
