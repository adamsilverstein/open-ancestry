import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type PluginOption } from 'vite';
import istanbul from 'vite-plugin-istanbul';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const e2eCoverage = process.env.E2E_COVERAGE === '1';
const apiPort = process.env.OA_PORT ?? '4318';

const plugins: PluginOption[] = [react()];
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
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
});
