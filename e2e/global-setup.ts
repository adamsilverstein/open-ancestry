import { rmSync } from 'node:fs';
import { buildFixtureLibrary } from './tree-fixture';

/** Builds the fixture library once per run at OA_E2E_LIBRARY (set in playwright.config.ts). */
export default function globalSetup() {
  const library = process.env.OA_E2E_LIBRARY;
  if (!library) throw new Error('OA_E2E_LIBRARY is not set');
  rmSync(library, { recursive: true, force: true });
  buildFixtureLibrary(library);
}
