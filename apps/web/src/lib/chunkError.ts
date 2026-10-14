/**
 * True for a failed dynamic import of one of our chunks: the network is down,
 * or the server restarted with a new build and the old chunk hash is gone.
 * Browsers word it differently (Chromium, WebKit, Firefox).
 */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Load failed|Failed to fetch/i.test(
    message,
  );
}
