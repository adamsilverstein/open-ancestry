import type { Api, Deps } from '../context';
import { requireRow } from '../edits';
import { TreeIdParams } from '../schemas';

/** Tag reads beyond the list in trees.ts: the people a tag is on (for tree highlighting). */
export function tagRoutes(app: Api, { library }: Deps): void {
  app.get(
    '/api/trees/:tree/tags/:id/people',
    { schema: { params: TreeIdParams } },
    async (request) => {
      const store = library.open(request.params.tree);
      requireRow(store, 'tag', request.params.id);
      const rows = store
        .stmt(
          "SELECT owner_id FROM tag_link WHERE tag_id = ? AND owner_type = 'person' ORDER BY owner_id",
        )
        .all(request.params.id) as { owner_id: string }[];
      return { personIds: rows.map((r) => r.owner_id) };
    },
  );
}
