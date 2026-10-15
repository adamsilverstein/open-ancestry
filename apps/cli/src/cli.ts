import { main } from './main';

// Everything the app writes (trees, media, thumbnails, exports) is private
// family data: readable only by this OS account, whoever's code creates it.
if (process.platform !== 'win32') process.umask(0o077);

const code = await main(process.argv.slice(2));
if (code !== 0) process.exit(code);
