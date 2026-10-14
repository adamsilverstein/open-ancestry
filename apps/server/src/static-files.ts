import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The files the SPA build may serve: regular files under `root`, as URL paths
 * (`/assets/app-1a2b.js`), skipping dot entries, symlinks and `index.html`
 * (the shell is rendered per request). Built on first use, not at startup
 * (cold start, #54); the build does not change while the server runs.
 *
 * The static route only serves exact members, so case variants, directories,
 * dotfiles and anything a symlink points at fall through to the shell.
 */
export function staticFileIndex(root: string): (urlPath: string) => boolean {
  let files: Set<string> | undefined;
  const walk = (dir: string, prefix: string, into: Set<string>) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), path, into);
      else if (entry.isFile() && path !== '/index.html') into.add(path);
    }
  };
  return (urlPath) => {
    if (!files) {
      files = new Set();
      walk(root, '', files);
    }
    return files.has(urlPath);
  };
}
