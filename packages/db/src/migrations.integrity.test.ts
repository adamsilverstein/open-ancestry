import Database from 'better-sqlite3';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, getSchemaVersion, migrate, type Migration } from './index';
import { makeTempDir } from '../../../fixtures/temp-dir';

describe('adversarial: two connections upgrading one tree at once', () => {
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
