import { rmSync } from 'node:fs';

/**
 * Removes the run's throwaway library (1-2 GB with the seeded trees and
 * imports), unless it was passed in through OA_E2E_LIBRARY.
 */
export default function globalTeardown() {
  const library = process.env.OA_E2E_LIBRARY;
  if (library && process.env.OA_E2E_LIBRARY_OWNED === '1') {
    rmSync(library, { recursive: true, force: true, maxRetries: 3 });
  }
}
