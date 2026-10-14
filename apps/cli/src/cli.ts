import { escapeControls } from './escape';
import { run } from './main';

try {
  await run(process.argv.slice(2));
} catch (error) {
  // Messages can quote a file name or tree name, so escape them like the report.
  console.error(escapeControls(error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
