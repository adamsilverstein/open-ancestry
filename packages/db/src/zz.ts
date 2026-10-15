import { bulkInsert, generateSyntheticTree, openMemoryTree, rebuildSearchIndex } from './index';
for (const n of [100_000]) {
  const store = openMemoryTree();
  bulkInsert(store, generateSyntheticTree({ people: n, seed: 1 }));
  for (let k = 0; k < 3; k++) {
    const t = performance.now();
    rebuildSearchIndex(store);
    console.log(n, (performance.now() - t).toFixed(0), 'ms');
  }
  store.close();
}
