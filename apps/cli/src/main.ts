import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getPersonSummary, openTree } from '@open-ancestry/db';
import {
  importFile,
  importGedcom,
  type ImportPhase,
  type ImportReport,
} from '@open-ancestry/import';
import {
  DEFAULT_HOST,
  Library,
  defaultLibraryRoot,
  isLoopbackHost,
  startServer,
  treeNameProblem,
  type RunningServer,
} from '@open-ancestry/server';
import { escapeControls } from './escape';

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
  --library <dir>      Folder holding your trees (default $OA_LIBRARY or ~/OpenAncestry)

Both:
  --shared-library     Open trees even if other accounts can write to the library folder
                       (also OA_SHARED_LIBRARY=1); they could swap a tree while it is open`;

export type CliCommand =
  | { command: 'help' }
  | {
      command: 'serve';
      host: string;
      port: number;
      library: string;
      open: boolean;
      staticDir: string | undefined;
      sharedLibrary: boolean;
    }
  | {
      command: 'import';
      file: string;
      name: string | undefined;
      media: string | undefined;
      library: string;
      sharedLibrary: boolean;
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
      'shared-library': { type: 'boolean' },
    },
  });
  // Opting in to a library folder other accounts can write to (issue #211).
  const sharedLibrary = values['shared-library'] ?? env.OA_SHARED_LIBRARY === '1';
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
      sharedLibrary,
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
    sharedLibrary,
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
    `WARNING: listening on ${escapeControls(host)}, which is not a loopback address.`,
    'Anyone who can reach this machine on the network can read and change',
    'your family trees, including details of living people.',
    `Use the default --host ${DEFAULT_HOST} unless you are sure.`,
    '!'.repeat(72),
    '',
  ].join('\n');
}

export interface RunDeps {
  log?: (line: string) => void;
  /** Where import progress goes (default: stderr when it is a terminal). */
  progress?: (text: string) => void;
  warn?: (line: string) => void;
  openUrl?: (url: string) => void;
  /** Where SIGINT/SIGTERM arrive (default: the process). */
  signals?: Pick<NodeJS.Process, 'on' | 'off'>;
  /** Ends the process after a signal-triggered shutdown (default: process.exit). */
  exit?: (code: number) => void;
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Stops the server gracefully on Ctrl-C or SIGTERM: running imports abort and
 * clean up (their upload and any empty tree they created) before the process
 * ends. A second signal exits at once.
 */
function stopOnSignals(
  server: RunningServer,
  signals: Pick<NodeJS.Process, 'on' | 'off'>,
  exit: (code: number) => void,
  log: (line: string) => void,
): RunningServer {
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) return exit(1);
    stopping = true;
    log(`Stopping (${signal})...`);
    server.close().then(
      () => exit(0),
      () => exit(1),
    );
  };
  for (const signal of STOP_SIGNALS) signals.on(signal, onSignal);
  const close = server.close;
  return {
    ...server,
    close: async () => {
      for (const signal of STOP_SIGNALS) signals.off(signal, onSignal);
      await close();
    },
  };
}

const row = (label: string, value: string | number) => `${label.padEnd(15)}${value}`;
const MAX_LISTED = 50;

/**
 * The import report as plain text for the terminal. Every value from the file
 * (or its name) is escaped on its own, so none can add lines or controls.
 */
export function formatReport(
  report: ImportReport,
  tree: { name: string; dir: string; homePerson: string | null },
): string {
  const e = escapeControls;
  const rows = report.rows as Record<string, number | undefined>;
  const source = report.source;
  const lines = [
    `Imported ${e(report.file.name ?? 'file')} into "${e(tree.name)}" (${e(tree.dir)}) in ${(report.timings.total / 1000).toFixed(1)}s`,
    '',
    row(
      'Source',
      `${e([source.system, source.version].filter(Boolean).join(' ') || 'unknown')} (${report.format}, ${report.encoding})`,
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
    row('Home person', e(tree.homePerson ?? 'none')),
    row('Warnings', report.warningCount || 'none'),
  ];
  for (const w of report.warnings.slice(0, MAX_LISTED)) {
    lines.push(`  ${`line ${w.line}`.padEnd(11)}${e(w.code).padEnd(22)}${e(w.message)}`);
  }
  if (report.warningCount > MAX_LISTED) {
    lines.push(`  ... and ${report.warningCount - MAX_LISTED} more`);
  }
  lines.push(row('Unmapped tags', report.unmapped.length ? report.unmapped.length : 'none'));
  for (const u of report.unmapped.slice(0, MAX_LISTED)) {
    lines.push(
      `  ${e(u.path).padEnd(28)}${String(u.count).padEnd(7)}line ${u.example.line}: ${e(u.example.text)}`,
    );
  }
  if (report.unmapped.length > MAX_LISTED) {
    lines.push(`  ... and ${report.unmapped.length - MAX_LISTED} more`);
  }
  for (const m of report.media.missing.slice(0, MAX_LISTED)) {
    lines.push(`  missing media: ${e(m.path)} (line ${m.line})`);
  }
  return lines.join('\n');
}

const PHASE_LABELS: Record<ImportPhase, string> = {
  read: 'Reading',
  parse: 'Parsing',
  map: 'Mapping records',
  finalize: 'Linking families',
  commit: 'Saving',
  done: 'Done',
};

/** One status line per phase (and per 10% while mapping), for a progress line on stderr. */
export function progressReporter(write: (text: string) => void) {
  let last = '';
  return (phase: ImportPhase, done: number, total: number) => {
    const percent = phase === 'map' && total > 0 ? Math.floor((done / total) * 10) * 10 : null;
    const line = percent === null ? PHASE_LABELS[phase] : `${PHASE_LABELS[phase]} ${percent}%`;
    if (line === last) return;
    last = line;
    write(phase === 'done' ? `\r${line.padEnd(30)}\n` : `\r${line.padEnd(30)}`);
  };
}

/** Progress goes to stderr only on a terminal, so piped output stays the report alone. */
const stderrProgress = process.stderr.isTTY
  ? (text: string) => void process.stderr.write(text)
  : undefined;

async function importCommand(
  cli: Extract<CliCommand, { command: 'import' }>,
  log: (line: string) => void,
  progress: ((text: string) => void) | undefined,
): Promise<void> {
  if (cli.media) {
    const isDir = (() => {
      try {
        return statSync(cli.media).isDirectory();
      } catch {
        return false;
      }
    })();
    if (!isDir) throw new Error(`--media folder not found: ${cli.media}`);
  }
  const name = cli.name ?? basename(cli.file, extname(cli.file)).trim();
  const problem = treeNameProblem(name);
  if (problem) throw new Error(`${problem}: "${name}". Choose another with --name.`);
  const library = new Library(cli.library, { shared: cli.sharedLibrary });
  library.ensureRoot();
  const dir = library.dirOf(name);
  if (existsSync(dir)) {
    throw new Error(
      `A tree named "${name}" already exists in ${library.root}; choose another with --name.`,
    );
  }
  log(`Importing ${escapeControls(cli.file)} ...`);
  const report = await importGedcom(
    { path: cli.file },
    { dir, name },
    {
      ...(cli.media && { mediaDir: cli.media }),
      ...(progress && { onProgress: progressReporter(progress) }),
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

export interface MainDeps extends RunDeps {
  /** Where a failure's message goes (default console.error). */
  error?: (line: string) => void;
}

/**
 * The CLI entry: runs a command and returns the exit code. Failures print
 * their message escaped, since messages quote file, folder and tree names.
 */
export async function main(
  argv: string[],
  { error = console.error, ...deps }: MainDeps = {},
): Promise<number> {
  try {
    await run(argv, deps);
    return 0;
  } catch (failure) {
    error(escapeControls(failure instanceof Error ? failure.message : String(failure)));
    return 1;
  }
}

export async function run(
  argv: string[],
  {
    log = console.log,
    warn = console.warn,
    openUrl = openInBrowser,
    progress = stderrProgress,
    signals = process,
    exit = (code: number) => process.exit(code),
  }: RunDeps = {},
): Promise<RunningServer | undefined> {
  const cli = parseCliArgs(argv);
  if (cli.command === 'help') {
    log(USAGE);
    return undefined;
  }
  if (cli.command === 'import') {
    await importCommand(cli, log, progress);
    return undefined;
  }
  if (!isLoopbackHost(cli.host)) warn(exposureWarning(cli.host));
  const server = await startServer({
    host: cli.host,
    port: cli.port,
    library: cli.library,
    sharedLibrary: cli.sharedLibrary,
    staticDir: cli.staticDir ?? bundledStaticDir(),
    importer: importFile,
  });
  log(`open-ancestry running at ${escapeControls(server.url)}`);
  log(`Library: ${escapeControls(cli.library)}`);
  if (cli.open) openUrl(server.url);
  return stopOnSignals(server, signals, exit, log);
}
