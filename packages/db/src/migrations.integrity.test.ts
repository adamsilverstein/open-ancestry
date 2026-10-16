import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  getSchemaVersion,
  migrate,
  openTree,
  TreeStore,
  type Migration,
} from './index';
import { makeTempDir } from '../../../fixtures/temp-dir';

describe('two connections upgrading one tree at once', () => {
  it('a second process that opens the same older tree does not fail on an upgrade the first one already applied', () => {
    const file = join(makeTempDir('oa-mig-race-'), 'tree.sqlite');
    const setup = new Database(file);
    migrate(setup, { to: 3 });
    setup.close();

    // Process A has read schema_version (3) and is about to apply v4. In that
    // window process B (another server or the CLI on the same library) opens
    // the tree and applies v4 and v5 itself. The getter runs where A's
    // transaction has begun but holds no lock yet, which is exactly the window.
    let raced = false;
    const chain: Migration[] = MIGRATIONS.map((m) =>
      m.version !== 4
        ? m
        : {
            ...m,
            get sql() {
              if (!raced) {
                raced = true;
                const b = new Database(file);
                migrate(b);
                b.close();
              }
              return MIGRATIONS[3]!.sql;
            },
          },
    );
    const a = new Database(file);
    expect(() => migrate(a, { migrations: chain })).not.toThrow();
    expect(getSchemaVersion(a)).toBe(LATEST_SCHEMA_VERSION);
    a.close();
  });
});

describe('upgrade lock wait', () => {
  it('waits longer for the lock while migrating than the caller does for requests', () => {
    const db = new Database(':memory:');
    let during = 0;
    const chain: Migration[] = MIGRATIONS.map((m, i) =>
      i !== MIGRATIONS.length - 1
        ? m
        : {
            ...m,
            get sql() {
              during = db.pragma('busy_timeout', { simple: true }) as number;
              return m.sql;
            },
          },
    );
    const store = new TreeStore(db, null, { busyTimeoutMs: 50, migrations: chain });
    expect(during).toBeGreaterThanOrEqual(30_000);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(50);
    store.close();
  });
});

describe('an existing tree written by the first schema', () => {
  it('still opens and upgrades to the latest version with its data', () => {
    // Built from the frozen v1 schema, as the first release wrote it, not from
    // today's migrations, so a change to v001 cannot hide a broken upgrade.
    const dir = join(makeTempDir('oa-mig-v1-'), 'Old.oatree');
    mkdirSync(join(dir, 'media'), { recursive: true });
    mkdirSync(join(dir, 'thumbs'));
    const v1 = new Database(join(dir, 'tree.sqlite'));
    v1.exec(
      readFileSync(join(import.meta.dirname, 'migrations', 'history', 'schema-v1.sql'), 'utf8'),
    );
    const now = '2026-01-01T00:00:00.000Z';
    v1.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
    v1.prepare("INSERT INTO meta (key, value) VALUES ('tree_name', 'Old')").run();
    v1.prepare('INSERT INTO person (id, created_at, updated_at) VALUES (?, ?, ?)').run(
      'P1',
      now,
      now,
    );
    v1.prepare(
      'INSERT INTO person_name (id, person_id, given, surname, is_primary, sort_order) VALUES (?, ?, ?, ?, 1, 0)',
    ).run('N1', 'P1', 'Ida', 'Wren');
    v1.close();

    const store = openTree(dir);
    try {
      expect(getSchemaVersion(store.db)).toBe(LATEST_SCHEMA_VERSION);
      expect(
        store.db.prepare('SELECT given, surname FROM person_name WHERE person_id = ?').get('P1'),
      ).toEqual({ given: 'Ida', surname: 'Wren' });
    } finally {
      store.close();
    }
  });
});
