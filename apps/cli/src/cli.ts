import { run } from './main';

// Everything the app writes (trees, media, thumbnails, exports) is private
// family data: readable only by this OS account, whoever's code creates it.
if (process.platform !== 'win32') process.umask(0o077);

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
