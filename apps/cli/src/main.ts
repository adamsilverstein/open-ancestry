import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_HOST, startServer, type RunningServer } from '@open-ancestry/server';

export const DEFAULT_PORT = 4317;

const USAGE = `Usage: open-ancestry <command> [options]

Commands:
  serve    Start the app on http://127.0.0.1:${DEFAULT_PORT}
  help     Show this message

Options for serve:
  --port <n>           Port to listen on (default ${DEFAULT_PORT})
  --host <host>        Interface to bind (default ${DEFAULT_HOST}; loopback only)
  --static-dir <dir>   Built web app to serve (default: bundled build)`;

export type CliCommand =
  | { command: 'help' }
  | { command: 'serve'; host: string; port: number; staticDir: string | undefined };

export function parseCliArgs(argv: string[]): CliCommand {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      'static-dir': { type: 'string' },
    },
  });
  if (positionals[0] !== 'serve') return { command: 'help' };

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port: ${values.port}`);
  }
  return {
    command: 'serve',
    host: values.host ?? DEFAULT_HOST,
    port,
    staticDir: values['static-dir'],
  };
}

/** The web build copied next to the bundled CLI (dist/public). */
function bundledStaticDir(): string | undefined {
  const dir = fileURLToPath(new URL('./public/', import.meta.url));
  return existsSync(dir) ? dir : undefined;
}

export async function run(
  argv: string[],
  log: (line: string) => void = console.log,
): Promise<RunningServer | undefined> {
  const cli = parseCliArgs(argv);
  if (cli.command === 'help') {
    log(USAGE);
    return undefined;
  }
  const server = await startServer({
    host: cli.host,
    port: cli.port,
    staticDir: cli.staticDir ?? bundledStaticDir(),
  });
  log(`open-ancestry running at ${server.url}`);
  return server;
}
