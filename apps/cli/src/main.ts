import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getPersonSummary, openTree } from '@open-ancestry/db';
import { importFile, importGedcom, type ImportReport } from '@open-ancestry/import';
import {
  DEFAULT_HOST,
  Library,
  defaultLibraryRoot,
  isLoopbackHost,
  startServer,
  treeNameProblem,
  type RunningServer,
} from '@open-ancestry/server';

export const DEFAULT_PORT = 4317;

const USAGE = `Usage: open-ancestry <command> [options]

Commands:
  serve                Start the app on http://127.0.0.1:${DEFAULT_PORT}
  import <file>        Import a GEDCOM (.ged) or GEDZIP (.zip, .gdz) file into a new tree
  help                 Show this message

Options for serve:
  --port <n>           Port to listen on (default ${DEFAULT_PORT})
  --host <host>        Interface to bind (default ${DEFAULT_HOST}; loopback only)
  --library <dir>      Folder holding your trees (default $OA_LIBRARY or ~/OpenAncestry)
  --open               Open the app in your browser
  --static-dir <dir>   Built web app to serve (default: bundled build)

Options for import:
  --name <tree>        Tree name (default: the file name)
  --media <dir>        Folder holding the media files a .ged file refers to
  --library <dir>      Folder holding your trees (default $OA_LIBRARY or ~/OpenAncestry)`;

export type CliCommand =
  | { command: 'help' }
  | {
      command: 'serve';
      host: string;
      port: number;
      library: string;
      open: boolean;
      staticDir: string | undefined;
    }
  | {
      command: 'import';
      file: string;
      name: string | undefined;
      media: string | undefined;
      library: string;
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
      name: { type: 'string' },
      media: { type: 'string' },
    },
  });
  if (positionals[0] === 'import') {
    const file = positionals[1];
    if (!file)
      throw new Error('Usage: open-ancestry import <file> [--media <dir>] [--name <tree>]');
    return {
      command: 'import',
      file,
      name: values.name,
      media: values.media,
      library: values.library ?? defaultLibraryRoot(env),
    };
  }
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

const row = (label: string, value: string | number) => `${label.padEnd(15)}${value}`;
const MAX_LISTED = 50;

/** The import report as plain text for the terminal. */
export function formatReport(
  report: ImportReport,
  tree: { name: string; dir: string; homePerson: string | null },
): string {
  const rows = report.rows as Record<string, number | undefined>;
  const source = report.source;
  const lines = [
    `Imported ${report.file.name ?? 'file'} into "${tree.name}" (${tree.dir}) in ${(report.timings.total / 1000).toFixed(1)}s`,
    '',
    row(
      'Source',
      `${[source.system, source.version].filter(Boolean).join(' ') || 'unknown'} (${report.format}, ${report.encoding})`,
    ),
    row('People', rows.person ?? 0),
    row('Families', rows.family ?? 0),
    row('Events', rows.event ?? 0),
    row('Places', rows.place ?? 0),
    row('Sources', rows.source ?? 0),
    row('Citations', rows.citation ?? 0),
    row('Notes', rows.note ?? 0),
    row(
      'Media',
      `${report.media.linked} linked, ${report.media.remote} remote, ${report.media.missing.length} missing, ${report.media.rejected} refused (${rows.media ?? 0} records)`,
    ),
    row(
      'Lines',
      `${report.lines.total} (${report.lines.mapped} mapped, ${report.lines.preserved} preserved)`,
    ),
    row('Living', `${report.living.living} living, ${report.living.deceased} deceased`),
    row('Home person', tree.homePerson ?? 'none'),
    row('Warnings', report.warningCount || 'none'),
  ];
  for (const w of report.warnings.slice(0, MAX_LISTED)) {
    lines.push(`  ${`line ${w.line}`.padEnd(11)}${w.code.padEnd(22)}${w.message}`);
  }
  if (report.warningCount > MAX_LISTED) {
    lines.push(`  ... and ${report.warningCount - MAX_LISTED} more`);
  }
  lines.push(row('Unmapped tags', report.unmapped.length ? report.unmapped.length : 'none'));
  for (const u of report.unmapped.slice(0, MAX_LISTED)) {
    lines.push(
      `  ${u.path.padEnd(28)}${String(u.count).padEnd(7)}line ${u.example.line}: ${u.example.text}`,
    );
  }
  if (report.unmapped.length > MAX_LISTED) {
    lines.push(`  ... and ${report.unmapped.length - MAX_LISTED} more`);
  }
  for (const m of report.media.missing.slice(0, MAX_LISTED)) {
    lines.push(`  missing media: ${m.path} (line ${m.line})`);
  }
  return lines.join('\n');
}

async function importCommand(
  cli: Extract<CliCommand, { command: 'import' }>,
  log: (line: string) => void,
): Promise<void> {
  const name = cli.name ?? basename(cli.file, extname(cli.file)).trim();
  const problem = treeNameProblem(name);
  if (problem) throw new Error(`${problem}: "${name}". Choose another with --name.`);
  mkdirSync(cli.library, { recursive: true });
  const library = new Library(cli.library);
  const dir = library.dirOf(name);
  if (existsSync(dir)) {
    throw new Error(
      `A tree named "${name}" already exists in ${library.root}; choose another with --name.`,
    );
  }
  log(`Importing ${cli.file} ...`);
  const report = await importGedcom(
    { path: cli.file },
    { dir, name },
    {
      ...(cli.media && { mediaDir: cli.media }),
    },
  );
  const store = openTree(dir);
  let homePerson: string | null = null;
  try {
    const home = report.homePersonId ? getPersonSummary(store, report.homePersonId) : null;
    if (home) homePerson = [home.given, home.surname].filter(Boolean).join(' ') || home.id;
  } finally {
    store.close();
  }
  log(formatReport(report, { name, dir, homePerson }));
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
  if (cli.command === 'import') {
    await importCommand(cli, log);
    return undefined;
  }
  if (!isLoopbackHost(cli.host)) warn(exposureWarning(cli.host));
  const server = await startServer({
    host: cli.host,
    port: cli.port,
    library: cli.library,
    staticDir: cli.staticDir ?? bundledStaticDir(),
    importer: importFile,
  });
  log(`open-ancestry running at ${server.url}`);
  log(`Library: ${cli.library}`);
  if (cli.open) openUrl(server.url);
  return server;
}
