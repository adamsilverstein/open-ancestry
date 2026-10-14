import type { Api, Deps } from '../context';
import { checkTree, dismissLabel, keepingScan, setDismissed } from '../checks';
import { edit } from '../edits';
import { DismissBody, TreeParams } from '../schemas';

/** Tree checker: the report, and dismissing or restoring issues (undoable). */
export function checkRoutes(app: Api, { library }: Deps): void {
  app.get('/api/trees/:tree/checks', { schema: { params: TreeParams } }, async (request) =>
    checkTree(library.open(request.params.tree)),
  );

  for (const [path, dismissed] of [
    ['dismiss', true],
    ['restore', false],
  ] as const) {
    app.post(
      `/api/trees/:tree/checks/${path}`,
      { schema: { params: TreeParams, body: DismissBody } },
      async (request) => {
        const store = library.open(request.params.tree);
        const { keys } = request.body;
        const label = dismissLabel(store, keys, dismissed);
        const { batchId, result } = keepingScan(store, () =>
          edit(store, label, (tx) => setDismissed(tx, keys, dismissed)),
        );
        return { batchId, changed: result };
      },
    );
  }
}
