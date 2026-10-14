import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type PluginOption } from 'vite';
import istanbul from 'vite-plugin-istanbul';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const e2eCoverage = process.env.E2E_COVERAGE === '1';
const apiPort = process.env.OA_PORT ?? '4318';

/** Preloads the fingerprinted Inter latin subset so UI text never waits on CSS discovery. */
function preloadUiFont(): Plugin {
  return {
    name: 'oa-preload-ui-font',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const font = Object.values(ctx.bundle ?? {}).find(
          (file) =>
            file.type === 'asset' && /inter-latin-wght-normal.*\.woff2$/.test(file.fileName),
        );
        if (!font) return [];
        return [
          {
            tag: 'link',
            attrs: {
              rel: 'preload',
              href: `/${font.fileName}`,
              as: 'font',
              type: 'font/woff2',
              crossorigin: '',
            },
            injectTo: 'head',
          },
        ];
      },
    },
  };
}

const plugins: PluginOption[] = [react(), preloadUiFont()];
if (e2eCoverage) {
  // Instrument the production build so Playwright can collect window.__coverage__.
  plugins.push(
    istanbul({
      cwd: repoRoot,
      include: ['apps/web/src/**', 'packages/*/src/**'],
      exclude: ['**/*.test.*', 'node_modules/**'],
      extension: ['.ts', '.tsx'],
      requireEnv: false,
      forceBuildInstrument: true,
    }),
  );
}

export default defineConfig({
  plugins,
  build: {
    sourcemap: e2eCoverage,
    // Read by scripts/check-bundle-size.ts to measure the initial JS.
    manifest: true,
  },
  css: {
    modules: {
      localsConvention: 'camelCaseOnly',
    },
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
});
