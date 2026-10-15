import { devWorkerComparer, devWorkerImporter, startServer } from './index';

// API server for `npm run dev`; Vite proxies /api here.
const port = Number(process.env.OA_PORT ?? 4318);
const server = await startServer({
  port,
  logger: true,
  importer: devWorkerImporter(),
  comparer: devWorkerComparer(),
});
console.log(`open-ancestry API listening at ${server.url}`);
