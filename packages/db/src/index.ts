import Database from 'better-sqlite3';

/** Version of the bundled SQLite library; also proves the native binding loads. */
export function sqliteVersion(): string {
  const db = new Database(':memory:');
  try {
    const row = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    return row.version;
  } finally {
    db.close();
  }
}
