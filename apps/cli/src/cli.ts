import { main } from './main';

const code = await main(process.argv.slice(2));
if (code !== 0) process.exit(code);
