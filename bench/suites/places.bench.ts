import { openMemoryTree, suggestPlaces, type TreeStore } from '../../packages/db/src/index';
import type { BenchCase } from '../types';

// Place suggestions while typing in the event form (#280, #303), on 100k places:
// prefix matches come from the NOCASE index; contains matches top up the list.
let store: TreeStore | undefined;

const TOWNS = ['Millbrook', 'Ashford', 'Brackenford', 'Elderfield', 'Thornbury', 'Wexmoor'];
const COUNTIES = ['Harlow County', 'Westmere', 'Northvale', 'Essex', 'Kent'];

function loaded() {
  if (store) return;
  store = openMemoryTree();
  const insert = store.db.prepare(
    "INSERT INTO place (id, name, full_name, created_at, updated_at) VALUES (?, ?, ?, '', '')",
  );
  store.db.transaction(() => {
    for (let i = 0; i < 100_000; i++) {
      const town = `${TOWNS[i % TOWNS.length]} ${i}`;
      insert.run(`P${i}`, town, `${town}, ${COUNTIES[i % COUNTIES.length]}, England`);
    }
  })();
}

export default [
  {
    name: 'db: place suggestions, prefix (100k places)',
    setup: loaded,
    fn: () => suggestPlaces(store!, 'millbrook 4'),
    budgetMs: 20,
  },
  {
    // No place starts with the text, so every suggestion is a contains match.
    name: 'db: place suggestions, contains only (100k places)',
    setup: loaded,
    fn: () => suggestPlaces(store!, 'harlow county'),
    budgetMs: 50,
  },
  {
    // Worst case: nothing matches, so the contains pass reads every place (about
    // 30 ms). The form waits 150 ms after the last key before asking, so this runs
    // once per pause in typing, not once per key.
    name: 'db: place suggestions, no match (100k places)',
    setup: loaded,
    fn: () => suggestPlaces(store!, 'quarrytown'),
    budgetMs: 50,
    metric: 'mean',
  },
] satisfies BenchCase[];
