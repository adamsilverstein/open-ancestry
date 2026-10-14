import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEFAULT_HOST,
  defaultLibraryRoot,
  isLoopbackHost,
  startServer,
  type RunningServer,
} from '@open-ancestry/server';

export const DEFAULT_PORT = 4317;

const USAGE = `Usage: open-ancestry <command> [options]

Commands:
  serve    Start the app on http://127.0.0.1:${DEFAULT_PORT}
  help     Show this message

Options for serve:
  --port <n>           Port to listen on (default ${DEFAULT_PORT})
  --host <host>        Interface to bind (default ${DEFAULT_HOST}; loopback only)
  --library <dir>      Folder holding your trees (default $OA_LIBRARY or ~/OpenAncestry)
  --open               Open the app in your browser
  --static-dir <dir>   Built web app to serve (default: bundled build)`;

export type CliCommand =
  | { command: 'help' }
  | {
      command: 'serve';
      host: string;
      port: number;
      library: string;
      open: boolean;
      staticDir: string | undefined;
    };

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliCommand {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      library: { type: 'string' },
      open: { type: 'boolean' },
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
    library: values.library ?? defaultLibraryRoot(env),
    open: values.open ?? false,
    staticDir: values['static-dir'],
  };
}

/** The web build copied next to the bundled CLI (dist/public). */
function bundledStaticDir(): string | undefined {
  const dir = fileURLToPath(new URL('./public/', import.meta.url));
  return existsSync(dir) ? dir : undefined;
}

/** Opens a URL in the default browser without waiting for it. */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [command, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

export function exposureWarning(host: string): string {
  return [
    '',
    '!'.repeat(72),
    `WARNING: listening on ${host}, which is not a loopback address.`,
    'Anyone who can reach this machine on the network can read and change',
    'your family trees, including details of living people.',
    `Use the default --host ${DEFAULT_HOST} unless you are sure.`,
    '!'.repeat(72),
    '',
  ].join('\n');
}

export interface RunDeps {
  log?: (line: string) => void;
  warn?: (line: string) => void;
  openUrl?: (url: string) => void;
}

export async function run(
  argv: string[],
  { log = console.log, warn = console.warn, openUrl = openInBrowser }: RunDeps = {},
): Promise<RunningServer | undefined> {
  const cli = parseCliArgs(argv);
  if (cli.command === 'help') {
    log(USAGE);
    return undefined;
  }
  if (!isLoopbackHost(cli.host)) warn(exposureWarning(cli.host));
  const server = await startServer({
    host: cli.host,
    port: cli.port,
    library: cli.library,
    staticDir: cli.staticDir ?? bundledStaticDir(),
  });
  log(`open-ancestry running at ${server.url}`);
  log(`Library: ${cli.library}`);
  if (cli.open) openUrl(server.url);
  return server;
}
