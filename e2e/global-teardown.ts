import { rmSync } from 'node:fs';
import { ownedE2eLibrary } from '../fixtures/temp-dir';

/**
 * Removes the run's throwaway library (1-2 GB with the seeded trees and
 * imports): only the one this run made in the OS temp dir, never one passed
 * in through OA_E2E_LIBRARY or inherited by a nested run.
 */
export default function globalTeardown() {
  const library = ownedE2eLibrary();
  if (!library) return;
  try {
    rmSync(library, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    console.warn(`Could not remove the e2e library ${library}: ${String(error)}`);
  }
}
