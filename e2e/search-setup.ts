import { buildSearchLibrary } from './search-fixture';

/** Builds the search and people-list trees in the e2e server's library. */
export default function searchSetup() {
  const library = process.env.OA_E2E_LIBRARY;
  if (!library) throw new Error('OA_E2E_LIBRARY is not set');
  buildSearchLibrary(library);
}
