import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENUM_COLUMNS, LATEST_SCHEMA_VERSION, listTables } from './index';
import { memoryTree } from './test/helpers';

const doc = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'data-model.md'), 'utf8');

/** Columns documented under each `### \`table\`` heading, from the first cell of its table rows. */
function documentedTables(): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of doc.split('\n')) {
    const heading = /^### `([a-z_]+)`/.exec(line);
    if (heading) {
      current = heading[1] as string;
      tables.set(current, []);
      continue;
    }
    if (line.startsWith('## ')) current = null;
    const cell = /^\| `([a-z_0-9]+)` \|/.exec(line);
    if (current && cell) tables.get(current)?.push(cell[1] as string);
  }
  return tables;
}

describe('docs/data-model.md', () => {
  const store = memoryTree();
  const live = listTables(store.db);
  const documented = documentedTables();

  it('documents exactly the tables in the live schema', () => {
    expect([...documented.keys()].sort()).toEqual(live.map((t) => t.name).sort());
  });

  it.each(live.map((t) => [t.name, t.columns] as const))(
    'documents every column of %s, in order',
    (name, columns) => {
      expect(documented.get(name)).toEqual(columns);
    },
  );

  it('lists every enum value', () => {
    for (const [key, values] of Object.entries(ENUM_COLUMNS)) {
      for (const value of values) expect(doc, `${key} = ${value}`).toContain(`\`${value}\``);
    }
  });

  it('states the current schema version and has an ER diagram', () => {
    expect(doc).toContain(`Current schema version: **${LATEST_SCHEMA_VERSION}**`);
    expect(doc).toContain('```mermaid\nerDiagram');
  });
});
