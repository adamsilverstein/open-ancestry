import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getPersonSummary, openTree } from '@open-ancestry/db';
import {
  importGedcom,
  type ImportLimits,
  type ImportPhase,
  type ImportReport,
} from '@open-ancestry/import';
import {
  DEFAULT_HOST,
  Library,
  defaultLibraryRoot,
  devWorkerImporter,
  isLoopbackHost,
  startServer,
  treeNameProblem,
  workerImporter,
  type RunningServer,
  type WorkerImporterOptions,
} from '@open-ancestry/server';
import { escapeControls } from './escape';

export const DEFAULT_PORT = 4317;

const LIMIT_OPTIONS = `Import size limits:
  --max-gedcom-mb <n>  Largest GEDCOM text, also inside a GEDZIP (default 64; $OA_MAX_GEDCOM_MB)
  --max-archive-mb <n> Largest GEDZIP with its photos (default 1024; $OA_MAX_ARCHIVE_MB)`;

const SERVE_OPTIONS = `Options for serve:
  --port <n>           Port to listen on (default ${DEFAULT_PORT})
  --host <host>        Interface to bind (default ${DEFAULT_HOST}; loopback only)
  --library <dir>      Folder holding your trees (default $OA_LIBRARY or ~/OpenAncestry)
  --no-open            Do not open the app in your browser (opened by default on a terminal)
  --open               Open it even when output is not a terminal
  --static-dir <dir>   Built web app to serve (default: bundled build)
  --import-heap-mb <n> Memory for each import's worker, in MB (default 2048; $OA_IMPORT_HEAP_MB)`;

const IMPORT_OPTIONS = `Options for import:
  --name <tree>        Tree name (default: the file name)
  --media <dir>        Folder holding the media files a .ged file refers to
  --library <dir>      Folder holding your trees (default $OA_LIBRARY or ~/OpenAncestry)`;

const USAGE = `Usage: open-ancestry <command> [options]

Commands:
  serve                Start the app on http://127.0.0.1:${DEFAULT_PORT} and open it in your browser
  import <file>        Import a GEDCOM (.ged) or GEDZIP (.zip, .gdz) file into a new tree
  help                 Show this message (also -h, --help; "<command> --help" for one command)

${SERVE_OPTIONS}

${IMPORT_OPTIONS}

${LIMIT_OPTIONS} (serve and import)`;

const COMMAND_USAGE = {
  serve: `Usage: open-ancestry serve [options]

Starts the app on http://127.0.0.1:${DEFAULT_PORT} and opens it in your browser.

${SERVE_OPTIONS}

${LIMIT_OPTIONS}`,
  import: `Usage: open-ancestry import <file> [options]

Imports a GEDCOM (.ged) or GEDZIP (.zip, .gdz) file into a new tree.

${IMPORT_OPTIONS}

${LIMIT_OPTIONS}`,
} as const;

type Topic = keyof typeof COMMAND_USAGE;

/** The usage text for the CLI, or for one command. */
export function usage(topic?: Topic): string {
  return topic ? COMMAND_USAGE[topic] : USAGE;
}

/** A command line the CLI does not understand: exit 2, with the usage. */
export class UsageError extends Error {
  readonly topic: Topic | undefined;

  constructor(message: string, topic?: Topic) {
    super(message);
    this.name = 'UsageError';
    this.topic = topic;
  }
}

export type CliCommand =
  | { command: 'help'; topic?: Topic }
  | {
      command: 'serve';
      host: string;
      port: number;
      library: string;
      open: boolean;
      staticDir: string | undefined;
      importLimits: Partial<ImportLimits>;
      /** Heap for each import worker, in MB (default IMPORT_RESOURCE_LIMITS). */
      importHeapMb: number | undefined;
    }
  | {
      command: 'import';
      file: string;
      name: string | undefined;
      media: string | undefined;
      library: string;
      importLimits: Partial<ImportLimits>;
    };

const MiB = 1024 * 1024;

/** A positive whole number of MB from a flag, else the environment variable, else undefined. */
function megabytes(
  flag: string,
  value: string | undefined,
  env: NodeJS.ProcessEnv,
  variable: string,
): number | undefined {
  const [source, raw] =
    value !== undefined ? [`--${flag}`, value] : [variable, env[variable] || undefined];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${source}: ${raw} (a whole number of MB)`);
  }
  return n;
}

function importLimits(
  values: { 'max-gedcom-mb'?: string; 'max-archive-mb'?: string },
  env: NodeJS.ProcessEnv,
): Partial<ImportLimits> {
  const gedcom = megabytes('max-gedcom-mb', values['max-gedcom-mb'], env, 'OA_MAX_GEDCOM_MB');
  const archive = megabytes('max-archive-mb', values['max-archive-mb'], env, 'OA_MAX_ARCHIVE_MB');
  return {
    ...(gedcom !== undefined && { maxBytes: gedcom * MiB }),
    ...(archive !== undefined && { maxArchiveBytes: archive * MiB }),
  };
}

export function parseCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  { tty = Boolean(process.stdout.isTTY) }: { tty?: boolean } = {},
): CliCommand {
  const isTopic = (word: string | undefined): word is Topic =>
    word === 'serve' || word === 'import';
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        port: { type: 'string' },
        host: { type: 'string' },
        library: { type: 'string' },
        open: { type: 'boolean' },
        'static-dir': { type: 'string' },
        name: { type: 'string' },
        media: { type: 'string' },
        'max-gedcom-mb': { type: 'string' },
        'max-archive-mb': { type: 'string' },
        'import-heap-mb': { type: 'string' },
      },
    });
  } catch (error) {
    // Node's message suggests "--" for positionals; name the option plainly instead.
    const option = /'(-[^']*)'/.exec((error as Error).message)?.[1];
    const topic = argv.find(isTopic);
    throw new UsageError(option ? `Unknown option: ${option}` : (error as Error).message, topic);
  }
  const { positionals, values } = parsed;
  const [command, second] = positionals;
  if (command === undefined) return { command: 'help' };
  if (command === 'help')
    return isTopic(second) ? { command: 'help', topic: second } : { command: 'help' };
  if (!isTopic(command)) throw new UsageError(`Unknown command: ${command}`);
  if (values.help) return { command: 'help', topic: command };
  if (command === 'import') {
    const file = second;
    if (!file) throw new UsageError('Missing the file to import', 'import');
    return {
      command: 'import',
      file,
      name: values.name,
      media: values.media,
      library: values.library ?? defaultLibraryRoot(env),
      importLimits: importLimits(values, env),
    };
  }

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port: ${values.port}`);
  }
  return {
    command: 'serve',
    host: values.host ?? DEFAULT_HOST,
    port,
    library: values.library ?? defaultLibraryRoot(env),
    // On a terminal, open the app (spec F6); piped output (CI, e2e) gets no browser.
    open: values.open ?? tty,
    staticDir: values['static-dir'],
    importLimits: importLimits(values, env),
    importHeapMb: megabytes('import-heap-mb', values['import-heap-mb'], env, 'OA_IMPORT_HEAP_MB'),
  };
}

/**
 * Imports run in a worker thread: the bundled worker next to the bundled CLI
 * (dist/import-worker.js), or the TypeScript source when run unbundled.
 */
function serverImporter(limits: Partial<ImportLimits>, heapMb: number | undefined) {
  const options: WorkerImporterOptions = {
    limits,
    ...(heapMb !== undefined && { resourceLimits: { maxOldGenerationSizeMb: heapMb } }),
  };
  const bundled = new URL('./import-worker.js', import.meta.url);
  return existsSync(fileURLToPath(bundled))
    ? workerImporter(bundled, options)
    : devWorkerImporter(options);
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
/** Longest unmapped example shown; real exports have lines of 500+ characters. */
const MAX_EXAMPLE = 80;

/** Pads a column, always leaving at least one space before the next. */
const column = (text: string, width: number) =>
  text.length < width ? text.padEnd(width) : `${text} `;
const shorten = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
/** Import time for the report: tenths of a second, or "under 0.1s". */
export const seconds = (ms: number) => (ms < 100 ? 'under 0.1s' : `${(ms / 1000).toFixed(1)}s`);

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
    `Imported ${e(report.file.name ?? 'file')} into "${e(tree.name)}" (${e(tree.dir)}) in ${seconds(report.timings.total)}`,
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
    lines.push(`  ${column(`line ${w.line}`, 11)}${column(e(w.code), 22)}${e(w.message)}`);
  }
  if (report.warningCount > MAX_LISTED) {
    lines.push(`  ... and ${report.warningCount - MAX_LISTED} more`);
  }
  lines.push(row('Unmapped tags', report.unmapped.length ? report.unmapped.length : 'none'));
  for (const u of report.unmapped.slice(0, MAX_LISTED)) {
    lines.push(
      `  ${column(e(u.path), 28)}${column(String(u.count), 7)}line ${u.example.line}: ${shorten(e(u.example.text), MAX_EXAMPLE)}`,
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
  mkdirSync(cli.library, { recursive: true });
  const library = new Library(cli.library);
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
      limits: cli.importLimits,
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
    if (failure instanceof UsageError) {
      error(`${escapeControls(failure.message)}\n\n${usage(failure.topic)}`);
      return 2;
    }
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
    log(usage(cli.topic));
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
    staticDir: cli.staticDir ?? bundledStaticDir(),
    importer: serverImporter(cli.importLimits, cli.importHeapMb),
    importLimits: cli.importLimits,
  });
  log(`open-ancestry running at ${escapeControls(server.url)}`);
  log(`Library: ${escapeControls(cli.library)}`);
  if (cli.open) openUrl(server.url);
  return stopOnSignals(server, signals, exit, log);
}
