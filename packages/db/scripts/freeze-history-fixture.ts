/**
 * Writes src/migrations/history/oa-vN.json for the latest schema version: a
 * small synthetic tree exported with its undo history. Run once when adding a
 * migration, next to dump-schema; released fixtures must never change.
 * migrations.test.ts loads every frozen fixture as a database at its version
 * and as a JSON backup, upgrades both, and undoes and redoes the history.
 *
 * The history includes a clock step back (batches whose ULIDs sort before
 * older ones), so the fixtures also pin undo order to commit order (#100).
 *
 * Usage: npm run freeze-history-fixture -w @open-ancestry/db
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LATEST_SCHEMA_VERSION,
  createUlidFactory,
  events,
  exportJsonString,
  families,
  names,
  noteLinks,
  notes,
  openMemoryTree,
  persons,
  places,
  undo,
} from '../src/index';

const file = join(
  import.meta.dirname,
  '..',
  'src',
  'migrations',
  'history',
  `oa-v${LATEST_SCHEMA_VERSION}.json`,
);
if (existsSync(file)) {
  console.error(`${file} already exists; released history fixtures are frozen.`);
  process.exit(1);
}

const HOUR = 3_600_000;
const T = Date.UTC(2026, 0, 1, 12);
let now = T;
let seed = 7;
// A ULID factory is monotonic within one process; a new one stands in for a
// later session whose clock is behind.
const session = () =>
  createUlidFactory({
    now: () => now,
    random: () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 32,
  });
let newId = session();
const store = openMemoryTree({
  name: 'History fixture',
  clock: () => new Date(now).toISOString(),
  newId: () => newId(),
});

const { result: ids } = store.transact('Seed family', (tx) => {
  const town = places.create(tx, { name: 'Brackenford', full_name: 'Brackenford, Wexmoor' });
  const person = (sex: 'M' | 'F', given: string, surname: string, year: number) => {
    const p = persons.create(tx, { sex, names: [{ given, surname }] });
    events.create(tx, {
      type: 'BIRT',
      date_text: String(year),
      date_sort: year * 10000 + 701,
      place_id: town.id,
      roles: [{ person_id: p.id }],
    });
    return p.id;
  };
  const dad = person('M', 'Ivo', 'Vale', 1930);
  const mom = person('F', 'Nerys', 'Holt', 1932);
  const kid = person('M', 'Ellis', 'Vale', 1960);
  const sister = person('F', 'Petra', 'Vale', 1962);
  families.create(tx, {
    partner1_id: dad,
    partner2_id: mom,
    relationship_type: 'married',
    children: [{ child_id: kid }, { child_id: sister, sort_order: 1 }],
  });
  return { dad, mom, kid, sister, town: town.id };
});

now = T + HOUR;
store.transact('Rename town', (tx) =>
  places.update(tx, ids.town, { full_name: 'Brackenford, Wexmoor, Westmere' }),
);
now = T + 2 * HOUR;
store.transact('Add married name', (tx) =>
  names.add(tx, ids.mom, { given: 'Nerys', surname: 'Vale', type: 'married' }),
);
// A new session with its clock an hour behind: these ids sort before the seed batch.
now = T - HOUR;
newId = session();
store.transact('Set sex', (tx) => persons.update(tx, ids.kid, { sex: 'U' }));
now = T - HOUR / 2;
store.transact('Delete sister', (tx) => persons.delete(tx, ids.sister));
now = T - HOUR / 4;
const { batchId: noted } = store.transact('Add note', (tx) => {
  const note = notes.create(tx, { text: 'Kept bees.' });
  noteLinks.create(tx, { note_id: note.id, owner_type: 'person', owner_id: ids.dad });
});
undo(store, noted);

writeFileSync(file, exportJsonString(store));
store.close();
console.log(`Wrote ${file}`);
