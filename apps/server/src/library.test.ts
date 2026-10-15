import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getSchemaVersion, migrate } from '@open-ancestry/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from './index';
import {
  Library,
  MAX_TREE_NAME_BYTES,
  MAX_TREE_NAME_LENGTH,
  defaultLibraryRoot,
  newTreeNameProblem,
  treeNameFromFile,
  treeNameProblem,
} from './library';
import { testApi, type TestApi } from './test/helpers';
import { makeTempDir } from '../../../fixtures/temp-dir';

describe('tree name length in bytes (#275 P1)', () => {
  // ext4 and most Linux file systems allow 255 bytes per name, and the folder
  // adds ".oatree" (and a timestamp in the trash): count UTF-8 bytes, not characters.
  it('refuses a name past the byte cap, even under the character cap', () => {
    const cjk = '漢'.repeat(MAX_TREE_NAME_LENGTH); // 100 characters, 300 bytes
    expect(treeNameProblem(cjk)).toMatch(/too long/);
    expect(treeNameProblem('漢'.repeat(MAX_TREE_NAME_BYTES / 3))).toBeNull();
    expect(
      Buffer.byteLength(`${'漢'.repeat(MAX_TREE_NAME_BYTES / 3)} 2026-10-16T12-00-00.000Z.oatree`),
    ).toBeLessThanOrEqual(255);
  });

  it('shortens a file-derived name to fit, at a character boundary', () => {
    const name = treeNameFromFile(`${'漢'.repeat(150)}.ged`);
    expect(treeNameProblem(name)).toBeNull();
    // Room left for a " 2" ... " 1000" suffix.
    expect(Buffer.byteLength(`${name} 1000`)).toBeLessThanOrEqual(MAX_TREE_NAME_BYTES);
    expect(name).toBe('漢'.repeat([...name].length));
    expect(treeNameFromFile(`${'😀'.repeat(100)}.ged`)).not.toMatch(/\uFFFD/);
  });
});

describe('a tree busy in another server on the same library (#275 P3)', () => {
  it('refuses rename, delete and writes while the other server imports', () => {
    const root = makeTempDir('oa-two-servers-');
    const first = new Library(root);
    const second = new Library(root);
    first.create('Shared');
    first.closeAll();
    const release = first.markBusy('Shared');
    // Same process, separate Library objects: only the lock file can tell.
    expect(() => second.rename('Shared', 'Moved')).toThrow(/busy in another/);
    expect(() => second.delete('Shared')).toThrow(/busy in another/);
    expect(() => second.assertIdle('Shared')).toThrow(expect.objectContaining({ statusCode: 409 }));
    // The server holding the lock reports its own import, not another server's.
    expect(() => first.assertIdle('Shared')).toThrow(/is busy; try again/);
    const again = first.markBusy('Shared');
    release();
    expect(() => second.assertIdle('Shared')).toThrow(/busy in another/);
    again();
    expect(existsSync(join(root, 'Shared.oatree', 'busy.lock'))).toBe(false);
    second.rename('Shared', 'Moved');
    expect(second.list().map((t) => t.id)).toEqual(['Moved']);
    second.closeAll();
  });

  it('lets only one server hold the lock when two mark the tree busy (#289 c)', () => {
    const root = makeTempDir('oa-lock-race-');
    const first = new Library(root);
    const second = new Library(root);
    const third = new Library(root);
    first.create('Race');
    first.closeAll();
    // Both passed assertIdle before either marked: markBusy itself must decide.
    const release = first.markBusy('Race');
    expect(() => second.markBusy('Race')).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(second.isBusy('Race')).toBe(false);
    // The loser's refusal left the winner's lock in place.
    expect(() => third.assertIdle('Race')).toThrow(/busy in another/);
    release();
    second.markBusy('Race')();
    for (const library of [first, second, third]) library.closeAll();
  });

  it('never moves aside a fresh lock another server just took over (#289)', () => {
    // A and B both judge an old lock stale. A moves it aside and creates its
    // own; B, a moment later, must not move A's fresh lock aside too.
    const root = makeTempDir('oa-lock-takeover-');
    const a = new Library(root);
    const b = new Library(root);
    a.create('T');
    a.closeAll();
    const lock = join(root, 'T.oatree', 'busy.lock');
    writeFileSync(lock, JSON.stringify({ pid: 4242, host: 'gone', owner: 'old', at: '' }));
    const then = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, then, then);
    let releaseA: (() => void) | undefined;
    b.testHooks.beforeLockTakeover = () => {
      releaseA = a.markBusy('T');
    };
    expect(() => b.markBusy('T')).toThrow(/busy in another/);
    expect(JSON.parse(readFileSync(lock, 'utf8')).owner).not.toBe('old');
    expect(() => b.assertIdle('T')).toThrow(/busy in another/);
    expect(readdirSync(join(root, 'T.oatree')).filter((n) => n.includes('stale'))).toEqual([]);
    releaseA!();
    a.closeAll();
    b.closeAll();
  });

  describe('lock liveness: a heartbeat, not the host or a day (#289 a)', () => {
    const lockOf = (root: string, tree: string) => join(root, `${tree}.oatree`, 'busy.lock');
    const plant = (root: string, tree: string, lock: object, ageMs: number) => {
      writeFileSync(lockOf(root, tree), JSON.stringify({ owner: 'other', at: '', ...lock }));
      const then = new Date(Date.now() - ageMs);
      utimesSync(lockOf(root, tree), then, then);
    };
    const tree = () => {
      const root = makeTempDir('oa-lock-live-');
      const library = new Library(root);
      library.create('T');
      library.closeAll();
      return { root, library };
    };

    it('trusts a fresh lock from any host, and takes over one silent for minutes', () => {
      const { root, library } = tree();
      plant(root, 'T', { pid: 4242, host: 'renamed-container' }, 10_000);
      expect(() => library.markBusy('T')).toThrow(/busy in another/);
      plant(root, 'T', { pid: 4242, host: 'renamed-container' }, 6 * 60_000);
      const release = library.markBusy('T');
      expect(JSON.parse(readFileSync(lockOf(root, 'T'), 'utf8')).owner).not.toBe('other');
      release();
      library.closeAll();
    });

    it('does not let a reused pid on this host keep a silent lock alive', () => {
      // A container restarts as pid 1 every time: the old lock names a live pid.
      const { root, library } = tree();
      plant(root, 'T', { pid: process.pid, host: hostname() }, 6 * 60_000);
      expect(() => library.assertIdle('T')).not.toThrow();
      library.markBusy('T')();
      library.closeAll();
    });

    it('frees at once a lock whose process on this host is gone', () => {
      const { root, library } = tree();
      const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
      plant(root, 'T', { pid: dead, host: hostname() }, 0);
      expect(() => library.assertIdle('T')).not.toThrow();
      library.closeAll();
    });

    it('keeps its own lock fresh with a heartbeat while busy', () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      try {
        const { root, library } = tree();
        const release = library.markBusy('T');
        const old = new Date(Date.now() - 4 * 60_000);
        utimesSync(lockOf(root, 'T'), old, old);
        vi.advanceTimersByTime(30_000);
        expect(Date.now() - statSync(lockOf(root, 'T')).mtimeMs).toBeLessThan(60_000);
        release();
        library.closeAll();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('ignores a lock left by a server process that has exited', () => {
    const root = makeTempDir('oa-stale-lock-');
    const library = new Library(root);
    library.create('Left');
    library.closeAll();
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    writeFileSync(
      join(root, 'Left.oatree', 'busy.lock'),
      JSON.stringify({ pid: dead, host: hostname(), owner: 'gone', at: new Date().toISOString() }),
    );
    expect(() => library.assertIdle('Left')).not.toThrow();
    expect(existsSync(join(root, 'Left.oatree', 'busy.lock'))).toBe(false);
    library.rename('Left', 'Right');
    library.closeAll();
  });
});

describe('treeNameProblem', () => {
  it.each([
    'Vale Family',
    'Familie Müller',
    "O'Brien 2",
    'a',
    'x'.repeat(100),
    'Conway',
    'console',
    'COM10',
  ])('accepts %j', (name) => {
    expect(treeNameProblem(name)).toBeNull();
  });

  it.each([
    '',
    '.hidden',
    '..',
    '../escape',
    'a/b',
    'a\\b',
    'C:tree',
    'trailing.',
    ' padded',
    'pad ',
    'nul\u0000',
    'tab\there',
    'what?',
    'x'.repeat(101),
    'CON',
    'nul.txt',
    'Com1',
    'lpt9.oatree',
    'AUX',
    'prn',
    '100%',
  ])('rejects %j', (name) => {
    expect(treeNameProblem(name)).not.toBeNull();
  });

  it.each(['Family\u202e', 'Line\u2028break'])('refuses %j for a new tree', (name) => {
    expect(newTreeNameProblem(name)).not.toBeNull();
  });

  it('keeps a long uploaded file name with an isolate acceptable after shortening (#215)', () => {
    // Wherever the cut falls, inside the isolate or not, the name the server picks must pass.
    for (let before = 0; before <= 120; before += 7) {
      for (const inside of [1, 30, 90]) {
        const file = `${'A'.repeat(before)}\u2068${'ב'.repeat(inside)}\u2069 tree.ged`;
        const name = treeNameFromFile(file);
        expect(newTreeNameProblem(name), JSON.stringify([before, inside, name])).toBeNull();
      }
    }
  });

  it('cleans direction overrides out of a name taken from an uploaded file (#190)', () => {
    expect(treeNameFromFile('Family\u202e.ged')).toBe('Family');
    expect(newTreeNameProblem(treeNameFromFile('Fam\u202eily\u2028Tree.ged'))).toBeNull();
  });
});

describe('defaultLibraryRoot', () => {
  it('uses OA_LIBRARY when set, else ~/OpenAncestry', () => {
    expect(defaultLibraryRoot({ OA_LIBRARY: '/tmp/lib' })).toBe('/tmp/lib');
    expect(defaultLibraryRoot({})).toBe(join(homedir(), 'OpenAncestry'));
  });
});

describe('Library', () => {
  it('creates its root lazily and caches one store per tree', async () => {
    const root = join(makeTempDir('oa-lib-'), 'nested');
    const library = new Library(root);
    expect(existsSync(root)).toBe(false);
    expect(library.list()).toEqual([]);
    const created = library.create('One');
    expect(library.open('One')).toBe(created);
    library.closeAll();
    const reopened = library.open('One');
    expect(reopened).not.toBe(created);
    expect(library.open('One')).toBe(reopened);
    library.closeAll();
  });

  it('tells copied tree folders apart by folder name (#193)', async () => {
    const root = makeTempDir('oa-lib-');
    const library = new Library(root);
    library.create('Smith');
    library.closeAll();
    // A folder copied by hand keeps the tree_name inside it.
    cpSync(join(root, 'Smith.oatree'), join(root, 'Smith copy.oatree'), { recursive: true });
    cpSync(join(root, 'Smith.oatree'), join(root, 'Backup.oatree'), { recursive: true });
    expect(library.list().map(({ id, name, label }) => ({ id, name, label }))).toEqual([
      { id: 'Smith', name: 'Smith', label: 'Smith' },
      { id: 'Backup', name: 'Smith', label: 'Smith (Backup)' },
      { id: 'Smith copy', name: 'Smith', label: 'Smith (Smith copy)' },
    ]);
    // Without a folder named exactly "Smith", every copy shows its folder: no
    // tree takes over the plain label, so labels cannot swap.
    library.closeAll();
    rmSync(join(root, 'Smith.oatree'), { recursive: true, force: true });
    expect(library.list().map((t) => t.label)).toEqual(['Smith (Backup)', 'Smith (Smith copy)']);
    // Folder names cannot smuggle bidi or control characters into a label.
    library.closeAll();
    cpSync(join(root, 'Backup.oatree'), join(root, 'Evil\u202Eypoc.oatree'), { recursive: true });
    expect(library.list().map((t) => t.label)).toContain('Smith (Evilypoc)');
    library.closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses to rename or delete a busy tree', async () => {
    const library = new Library(makeTempDir('oa-lib-'));
    library.create('Busy');
    let release!: () => void;
    const running = library.whileBusy('Busy', () => new Promise<void>((r) => (release = r)));
    expect(() => library.rename('Busy', 'Other')).toThrow(/busy/);
    expect(() => library.delete('Busy')).toThrow(/busy/);
    release();
    await running;
    library.rename('Busy', 'Other');
    expect(library.list().map((t) => t.id)).toEqual(['Other']);
    library.closeAll();
  });

  it('lists a tree another process is upgrading without waiting for the upgrade', () => {
    const root = makeTempDir('oa-lib-');
    // A tree written by an older version, so opening it would upgrade it.
    const dir = join(root, 'Old.oatree');
    mkdirSync(join(dir, 'media'), { recursive: true });
    mkdirSync(join(dir, 'thumbs'));
    const old = new Database(join(dir, 'tree.sqlite'));
    migrate(old, { to: 3 });
    old.prepare("INSERT INTO meta (key, value) VALUES ('tree_name', 'Old family')").run();
    old.pragma('journal_mode = WAL');
    // Another server or the CLI is part way through the upgrade: it holds the
    // write lock, and an upgrade waits for its lock for up to 30 s.
    old.exec('BEGIN IMMEDIATE');
    const library = new Library(root);
    try {
      const started = performance.now();
      expect(library.list().map(({ id, name }) => ({ id, name }))).toEqual([
        { id: 'Old', name: 'Old family' },
      ]);
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      old.exec('ROLLBACK');
    }
    // Listing reads the name only: it leaves the upgrade to whoever opens the tree.
    expect(getSchemaVersion(old)).toBe(3);
    old.close();
    library.closeAll();
  });

  it.each([
    [
      'a damaged database file',
      (file: string) => writeFileSync(file, 'not a database'.repeat(100)),
    ],
    [
      'a database without its meta table',
      (file: string) => {
        rmSync(file, { force: true });
        rmSync(`${file}-wal`, { force: true });
        rmSync(`${file}-shm`, { force: true });
        new Database(file).close();
      },
    ],
  ])('still lists the library when one tree has %s', (_, damage) => {
    const root = makeTempDir('oa-lib-');
    const setup = new Library(root);
    setup.create('Settled');
    setup.create('Broken');
    setup.closeAll();
    damage(join(root, 'Broken.oatree', 'tree.sqlite'));
    const library = new Library(root);
    expect(library.list().map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'Broken', name: 'Broken' },
      { id: 'Settled', name: 'Settled' },
    ]);
    library.closeAll();
  });

  it('still lists the library while another process is importing into one tree', () => {
    const root = makeTempDir('oa-lib-');
    const setup = new Library(root);
    setup.create('Settled');
    setup.create('Importing');
    setup.closeAll();
    // `open-ancestry import` (or an e2e worker) writing a tree holds its lock
    // for the whole import, so the server cannot open that one tree yet.
    const importer = new Database(join(root, 'Importing.oatree', 'tree.sqlite'));
    importer.pragma('journal_mode = DELETE');
    importer.exec('BEGIN EXCLUSIVE');
    const library = new Library(root);
    try {
      // The server waits briefly for the lock, not better-sqlite3's default 5 s.
      const started = performance.now();
      expect(library.list().map(({ id, name }) => ({ id, name }))).toEqual([
        { id: 'Importing', name: 'Importing' },
        { id: 'Settled', name: 'Settled' },
      ]);
      expect(performance.now() - started).toBeLessThan(1000);
      // Opening the locked tree itself still reports it busy, as a 409.
      expect(() => library.open('Importing')).toThrow(
        expect.objectContaining({ code: 'SQLITE_BUSY' }),
      );
    } finally {
      importer.exec('ROLLBACK');
      importer.close();
    }
    // Once the import is done the tree opens and shows its stored name.
    expect(library.info('Importing').name).toBe('Importing');
    library.closeAll();
  });

  it('resolves an id to its folder as spelled on disk, without folding case', async () => {
    const library = new Library(makeTempDir('oa-lib-'));
    const created = library.create('Caf\u00e9');
    // NFD and NFC spellings are one tree: one connection, one busy state.
    expect(library.open('Cafe\u0301')).toBe(created);
    expect(library.canonical('Cafe\u0301')).toBe('Caf\u00e9');
    const release = library.markBusy('Cafe\u0301');
    expect(library.isBusy('Caf\u00e9')).toBe(true);
    release();
    expect(library.isBusy('Caf\u00e9')).toBe(false);
    // A case variant is a different (missing) tree on every file system.
    expect(library.exists('CAF\u00c9')).toBe(false);
    expect(() => library.open('caf\u00e9')).toThrow(/not found/);
    expect(library.list().map((t) => t.id)).toEqual(['Caf\u00e9']);
    library.closeAll();
  });
});

describe('tree routes', () => {
  let api: TestApi;
  beforeEach(async () => {
    api = await testApi();
  });
  afterEach(() => api.close());

  it('creates, lists, opens, renames and soft-deletes trees', async () => {
    const created = await api.post('/api/trees', { name: 'Vale Family' });
    expect(created.statusCode).toBe(201);
    expect(created.json().tree).toMatchObject({
      id: 'Vale Family',
      name: 'Vale Family',
      peopleCount: 0,
      homePersonId: null,
    });
    expect(existsSync(join(api.root, 'Vale Family.oatree', 'tree.sqlite'))).toBe(true);

    await api.post('/api/trees', { name: 'Avery' });
    const list = (await api.get('/api/trees')).json().trees;
    expect(list.map((t: { id: string }) => t.id)).toEqual(['Avery', 'Vale Family']);
    expect(list[0].modifiedAt).toMatch(/^\d{4}-/);

    const opened = await api.get('/api/trees/Vale%20Family');
    expect(opened.json().tree.schemaVersion).toBeGreaterThan(0);

    const renamed = await api.patch('/api/trees/Vale%20Family', { name: 'Vale' });
    expect(renamed.json().tree).toMatchObject({ id: 'Vale', name: 'Vale' });
    expect((await api.get('/api/trees/Vale%20Family')).statusCode).toBe(404);
    expect((await api.patch('/api/trees/Vale', { name: 'Vale' })).statusCode).toBe(200);

    const deleted = await api.del('/api/trees/Vale');
    expect(deleted.statusCode).toBe(204);
    expect((await api.get('/api/trees/Vale')).statusCode).toBe(404);
    const trash = await readdir(join(api.root, '.trash'));
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatch(/^Vale .*\.oatree$/);
    // The trash is not a tree.
    expect((await api.get('/api/trees')).json().trees.map((t: { id: string }) => t.id)).toEqual([
      'Avery',
    ]);
  });

  it('refuses duplicate and invalid names', async () => {
    await api.post('/api/trees', { name: 'A' });
    await api.post('/api/trees', { name: 'B' });
    expect((await api.post('/api/trees', { name: 'A' })).json().error.code).toBe('conflict');
    expect((await api.patch('/api/trees/A', { name: 'B' })).statusCode).toBe(409);
    for (const name of ['../x', '.dot', 'a/b']) {
      const res = await api.post('/api/trees', { name });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
    // Blank names get a plain message, not a schema error (issue #123).
    for (const name of ['', '   ']) {
      const res = await api.post('/api/trees', { name });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toEqual({ code: 'bad_request', message: 'Enter a tree name' });
    }
    expect((await api.patch('/api/trees/A', { name: ' ' })).json().error.message).toBe(
      'Enter a tree name',
    );
    expect((await api.post('/api/trees', {})).json().error.code).toBe('validation_failed');
    expect((await api.post('/api/trees', { name: 'A', extra: 1 })).statusCode).toBe(400);
  });

  it('answers 404 or 400 for unknown or path-like tree ids', async () => {
    expect((await api.get('/api/trees/Nope')).json()).toEqual({
      error: { code: 'not_found', message: 'Tree "Nope" not found' },
    });
    expect((await api.get('/api/trees/..%2F..%2Fetc')).statusCode).toBe(400);
    expect((await api.get('/api/trees/.trash')).statusCode).toBe(400);
    expect((await api.patch('/api/trees/Nope', { name: 'X' })).statusCode).toBe(404);
    expect((await api.del('/api/trees/Nope')).statusCode).toBe(404);
  });
});

describe.skipIf(process.platform === 'win32')('library permissions', () => {
  const mode = (path: string) => statSync(path).mode & 0o777;
  const temps: string[] = [];
  const temp = async () => {
    const dir = makeTempDir('oa-lib-');
    temps.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates the library folder private to its owner', async () => {
    const root = join(await temp(), 'Library');
    const library = new Library(root);
    library.create('Vale');
    expect(mode(root)).toBe(0o700);
    expect(mode(library.dirOf('Vale'))).toBe(0o700);
    library.closeAll();
  });

  it('tightens an existing library folder and its trees on open', async () => {
    const root = join(await temp(), 'Library');
    new Library(root).create('Vale');
    chmodSync(root, 0o755);
    chmodSync(new Library(root).dirOf('Vale'), 0o755);
    const library = new Library(root);
    expect(library.list().map((t) => t.id)).toEqual(['Vale']);
    expect(mode(root)).toBe(0o700);
    expect(mode(library.dirOf('Vale'))).toBe(0o700);
    library.closeAll();
  });

  it('refuses a library folder other accounts can write to, unless it is declared shared', async () => {
    // Issue #211: another account could swap a tree folder between the checks
    // and SQLite opening it by path.
    const root = await temp();
    chmodSync(root, 0o775);
    writeFileSync(join(root, 'notes.txt'), 'not a tree');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => new Library(root).list()).toThrow(
      expect.objectContaining({
        statusCode: 403,
        message: expect.stringMatching(/other accounts can change.*--shared-library/s),
      }),
    );
    expect(() => new Library(root).create('Vale')).toThrow(/--shared-library/);
    for (const writable of [0o757, 0o777]) {
      chmodSync(root, writable);
      expect(() => new Library(root).list()).toThrow(/other accounts can change/);
    }
    chmodSync(root, 0o775);
    const shared = new Library(root, { shared: true });
    shared.create('Vale');
    expect(shared.list().map((t) => t.id)).toEqual(['Vale']);
    shared.closeAll();
    // Not on Windows, where these mode bits mean nothing.
    expect(() => new Library(root, { platform: 'win32' }).list()).not.toThrow();
  });

  it('refuses a library folder that belongs to another account', async () => {
    // Under a parent others can write to (no sticky bit), another account can
    // swap in its own 0700 folder: the mode looks private, the owner is not you.
    const root = await temp();
    expect(() => new Library(root, { uid: -1 }).list()).toThrow(
      expect.objectContaining({
        statusCode: 403,
        message: expect.stringMatching(/belongs to another account.*--shared-library/s),
      }),
    );
    expect(() => new Library(root, { uid: -1 }).open('Any')).toThrow(/another account/);
    expect(() => new Library(root, { uid: -1, shared: true }).list()).not.toThrow();
    expect(() => new Library(root, { uid: -1, platform: 'win32' }).list()).not.toThrow();
    expect(() => new Library(root).list()).not.toThrow();
  });

  it('refuses a folder of another account even when it holds only trees (tightening branch)', async () => {
    // A folder of nothing but trees is tightened rather than warned about, and
    // tightening skips a folder that is not ours: the owner check must still run.
    const root = join(await temp(), 'Library');
    new Library(root).create('Vale');
    new Library(root).closeAll();
    chmodSync(root, 0o755);
    expect(() => new Library(root, { uid: -1 }).list()).toThrow(/belongs to another account/);
    expect(() => new Library(root, { uid: -1, shared: true }).list()).not.toThrow();
  });

  it('leaves a shared folder that holds more than trees alone, with a warning', async () => {
    // e.g. `--library ~` or a group-shared folder: chmod would lock others out.
    const root = await temp();
    chmodSync(root, 0o755);
    writeFileSync(join(root, 'notes.txt'), 'not a tree');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const library = new Library(root);
    library.create('Vale');
    expect(mode(root)).toBe(0o755);
    expect(mode(library.dirOf('Vale'))).toBe(0o700);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/other accounts can see/);
    library.list();
    expect(warn).toHaveBeenCalledTimes(1);
    library.closeAll();
  });

  it('warns about a shared library folder once, at startup', async () => {
    const root = await temp();
    chmodSync(root, 0o755);
    writeFileSync(join(root, 'notes.txt'), 'not a tree');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createServer({ library: root });
    expect(warn).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('leaves an existing empty folder alone too, with a warning', async () => {
    const root = await temp();
    chmodSync(root, 0o755);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Library(root).list();
    expect(mode(root)).toBe(0o755);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a planted tree link with a clear 403', async () => {
    const root = join(await temp(), 'Library');
    const library = new Library(root);
    library.create('Real');
    library.closeAll();
    symlinkSync(library.dirOf('Real'), library.dirOf('Planted'));
    expect(() => library.open('Planted')).toThrow(
      expect.objectContaining({ statusCode: 403, message: expect.stringMatching(/symbolic link/) }),
    );
  });

  it('keeps the trash private', async () => {
    const root = join(await temp(), 'Library');
    const library = new Library(root);
    library.create('Gone');
    library.delete('Gone');
    expect(mode(join(root, '.trash'))).toBe(0o700);
    library.closeAll();
  });
});

describe('search index rebuild (#199)', () => {
  it('opens a tree with a stale index at once and rebuilds it in the background', async () => {
    const { persons, searchIndexStale, searchPeople } = await import('@open-ancestry/db');
    const root = await mkdtemp(join(tmpdir(), 'oa-library-search-'));
    const first = new Library(root);
    const store = first.create('Fold');
    const id = store.transact('add', (tx) =>
      persons.create(tx, { names: [{ given: 'Emre', surname: 'Yılmaz' }] }),
    ).result.id;
    store.db.prepare("DELETE FROM derived_state WHERE name = 'search_index'").run();
    first.closeAll();

    const library = new Library(root);
    const opened = library.open('Fold');
    // Opening did not rebuild: the request that opened it is not held up.
    expect(searchIndexStale(opened)).toBe(true);
    await expect.poll(() => searchIndexStale(opened), { interval: 5, timeout: 5000 }).toBe(false);
    expect(searchPeople(opened, 'yilmaz').map((r) => r.person.id)).toEqual([id]);
    library.closeAll();
  });
});
