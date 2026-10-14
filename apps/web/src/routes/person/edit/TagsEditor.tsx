import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Tags } from 'lucide-react';
import type { TagRow } from '@open-ancestry/db';
import { seg } from '../../../api/client';
import { useEdit } from '../../../api/edits';
import { apiSend } from '../../../api/client';
import { tagsQuery } from '../../../api/search';
import type { PersonDetail } from '../../../api/types';
import { Button } from '../../../components/Button/Button';
import { Checkbox } from '../../../components/Checkbox/Checkbox';
import { Input } from '../../../components/Input/Input';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/Popover/Popover';
import { fullName } from '../../../lib/person';
import { removeTag } from './optimistic';
import styles from './Edit.module.css';

/** Attach or detach the tree's tags, or create a new one, from the person header. */
export function TagsEditor({ tree, detail }: { tree: string; detail: PersonDetail }) {
  const id = detail.person.id;
  const base = `/trees/${seg(tree)}`;
  const edit = useEdit(tree);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  // Tags touched while open stay listed, so unchecking one never removes its row.
  const [touched, setTouched] = useState<TagRow[]>([]);
  const remember = (tag: TagRow) =>
    setTouched((list) => (list.some((t) => t.id === tag.id) ? list : [...list, tag]));
  const { data: tags = [] } = useQuery({ ...tagsQuery(tree), enabled: open });
  // React state for the box the user just clicked: the query cache notifies on a
  // later tick, which would let the controlled checkbox flip back for a moment.
  // It only applies until the detail's tags change (optimistically or refetched).
  const [pending, setPending] = useState<{ base: TagRow[]; checked: Record<string, boolean> }>({
    base: detail.tags,
    checked: {},
  });
  const has = new Set(detail.tags.map((t) => t.id));
  const isChecked = (tag: TagRow) =>
    (pending.base === detail.tags ? pending.checked[tag.id] : undefined) ?? has.has(tag.id);

  const toggle = (tag: TagRow, attach: boolean) => {
    remember(tag);
    setPending((p) => ({
      base: detail.tags,
      checked: { ...(p.base === detail.tags ? p.checked : {}), [tag.id]: attach },
    }));
    edit.mutate(
      attach
        ? {
            label: `Tag ${tag.name}`,
            optimistic: { personId: id, update: (d) => ({ ...d, tags: [...d.tags, tag] }) },
            send: () => apiSend('POST', `${base}/people/${id}/tags`, { tagId: tag.id }),
          }
        : {
            label: `Untag ${tag.name}`,
            optimistic: { personId: id, update: (d) => removeTag(d, tag.id) },
            send: () => apiSend('DELETE', `${base}/people/${id}/tags/${tag.id}`),
          },
    );
  };

  const create = () => {
    const tagName = name.trim();
    if (!tagName) return;
    setName('');
    edit.mutate({
      label: `Create tag ${tagName}`,
      // Created and attached in one batch, so one undo removes both.
      send: async () => {
        const { results } = await apiSend<{ results: [TagRow] }>('POST', `${base}/batch`, {
          label: `Tag ${fullName(detail.summary)}: ${tagName}`,
          operations: [{ op: 'tag.create', tag: { name: tagName }, attachTo: id }],
        });
        remember(results[0]);
      },
    });
  };

  // Detail tags first (they may not be loaded in the list yet), then the rest.
  const all = [...detail.tags, ...touched, ...tags].filter(
    (tag, index, list) => list.findIndex((t) => t.id === tag.id) === index,
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="secondary" iconStart={<Tags size={14} aria-hidden />}>
          Edit tags
        </Button>
      </PopoverTrigger>
      <PopoverContent label="Tags" align="start">
        <div className={styles.form}>
          {all.length > 0 ? (
            <div className={styles.tagList}>
              {all.map((tag) => (
                <Checkbox
                  key={tag.id}
                  label={tag.name}
                  checked={isChecked(tag)}
                  onChange={(e) => toggle(tag, e.currentTarget.checked)}
                />
              ))}
            </div>
          ) : (
            <p>No tags in this tree yet.</p>
          )}
          <form
            className={styles.newTag}
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <Input label="New tag" value={name} onChange={(e) => setName(e.currentTarget.value)} />
            <Button type="submit" size="md" disabled={!name.trim()}>
              Create tag
            </Button>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  );
}
