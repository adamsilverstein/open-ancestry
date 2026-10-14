import { importFile } from '@open-ancestry/import';
import { startServer } from './index';

// API server for `npm run dev`; Vite proxies /api here.
const port = Number(process.env.OA_PORT ?? 4318);
const server = await startServer({ port, logger: true, importer: importFile });
console.log(`open-ancestry API listening at ${server.url}`);
