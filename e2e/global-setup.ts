import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_TREE, MANIFEST, buildFixtureLibrary } from './tree-fixture';

/** Adds the fixture tree to the e2e library (OA_E2E_LIBRARY, set in playwright.config.ts). */
export default function globalSetup() {
  const library = process.env.OA_E2E_LIBRARY;
  if (!library) throw new Error('OA_E2E_LIBRARY is not set');
  // Only our own files: the server may already be using the library folder.
  rmSync(join(library, `${FIXTURE_TREE}.oatree`), { recursive: true, force: true });
  rmSync(join(library, MANIFEST), { force: true });
  buildFixtureLibrary(library);
}
