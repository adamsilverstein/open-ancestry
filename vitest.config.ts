import { defineConfig } from 'vitest/config';

// Each workspace folder is a Vitest project. Packages need no config of their
// own; add a vitest.config.ts inside a workspace only when it needs one (web).
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'fixtures'],
    coverage: {
      provider: 'istanbul',
      reportsDirectory: 'coverage/unit',
      reporter: ['text-summary', 'json', 'json-summary', 'html'],
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        // Process entry points; exercised by e2e, not unit tests.
        'apps/web/src/main.tsx',
        'apps/server/src/dev.ts',
        'apps/cli/src/cli.ts',
      ],
      // Packages are gated on unit coverage here. Apps are mostly exercised by
      // e2e, so they are gated on merged coverage in scripts/coverage-merge.ts.
      thresholds: {
        'packages/**': { lines: 80 },
        // The database package holds every user's data; keep it near-fully tested.
        'packages/db/**': { lines: 90 },
      },
    },
  },
});
