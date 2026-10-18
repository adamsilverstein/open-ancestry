import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import type { TagRow } from '@open-ancestry/db';
import { apiSend, seg } from '../../api/client';
import { useEdit } from '../../api/edits';
import { currentTreeQuery } from '../../api/queries';
import { tagsQuery } from '../../api/search';
import { Button } from '../../components/Button/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog/ConfirmDialog';
import { Dialog, DialogClose } from '../../components/Dialog/Dialog';
import { EmptyState } from '../../components/EmptyState/EmptyState';
import { IconButton } from '../../components/IconButton/IconButton';
import { Input } from '../../components/Input/Input';
import { Skeleton } from '../../components/Skeleton/Skeleton';
import { TagBadge } from '../../components/TagBadge/TagBadge';
import { TAG_COLORS, tagColor } from '../../lib/tags';
import type { TagColor } from '../../lib/person';
import styles from './TagsPage.module.css';

type Tag = TagRow & { people: number };

const UNCATEGORIZED = 'Uncategorized';

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const people = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'person' : 'people'}`;

/** Name, category (with existing ones suggested) and one of the eight palette colors. */
function TagDialog({
  title,
  tag,
  categories,
  onSave,
  onClose,
}: {
  title: string;
  tag?: Tag | undefined;
  categories: string[];
  onSave: (values: { name: string; category: string; color: string }) => void;
  onClose: () => void;
}) {
  const listId = useId();
  const radioName = useId();
  const [name, setName] = useState(tag?.name ?? '');
  const [category, setCategory] = useState(tag?.category ?? '');
  const [color, setColor] = useState<TagColor>(tag ? tagColor(tag) : 1);
  const save = () => {
    if (!name.trim()) return;
    onClose();
    onSave({ name: name.trim(), category: category.trim(), color: `tag-${color}` });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      size="sm"
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" onClick={save} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Input label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <Input
          label="Category"
          hint="For example Research, DNA or Military. Leave empty for none."
          value={category}
          list={listId}
          onChange={(e) => setCategory(e.currentTarget.value)}
        />
        <datalist id={listId}>
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <fieldset className={styles.colors}>
          <legend className={styles.legend}>Color</legend>
          {TAG_COLORS.map((option) => (
            <label key={option.color} className={styles.swatch}>
              <input
                type="radio"
                name={radioName}
                checked={color === option.color}
                onChange={() => setColor(option.color)}
              />
              <span
                className={styles.dot}
                style={{ background: `var(--oa-tag-${option.color})` }}
                aria-hidden
              />
              {option.name}
            </label>
          ))}
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function RenameCategory({
  category,
  onSave,
  onClose,
}: {
  category: string;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(category);
  const save = () => {
    if (!name.trim() || name.trim() === category) return onClose();
    onClose();
    onSave(name.trim());
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Rename category"
      size="sm"
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Input
          label="Category name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** MyTreeTags: tags grouped by category, with people counts and filters. */
export function TagsPage() {
  const { data: tree } = useQuery(currentTreeQuery);
  const { data: tags } = useQuery({ ...tagsQuery(tree ?? ''), enabled: !!tree });
  const edit = useEdit(tree ?? '');
  const [dialog, setDialog] = useState<
    { kind: 'new' } | { kind: 'edit'; tag: Tag } | { kind: 'rename'; category: string } | null
  >(null);
  const [confirm, setConfirm] = useState<
    { kind: 'tag'; tag: Tag } | { kind: 'category'; category: string; tags: Tag[] } | null
  >(null);

  if (tree === null) {
    return (
      <div className={styles.page}>
        <EmptyState level={1} title="No tree open" description="Import a GEDCOM file first." />
      </div>
    );
  }

  const base = `/trees/${seg(tree ?? '')}`;
  const list = (tags ?? []) as Tag[];
  const groups = new Map<string, Tag[]>();
  for (const tag of list) {
    const key = tag.category || UNCATEGORIZED;
    groups.set(key, [...(groups.get(key) ?? []), tag]);
  }
  const categories = [...new Set(list.map((t) => t.category).filter(Boolean))];
  const batch = (label: string, operations: unknown[]) =>
    edit.mutate({ label, send: () => apiSend('POST', `${base}/batch`, { label, operations }) });

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Tags</h1>
          <p className={styles.intro}>
            Group people by research status, DNA match, military service or anything else. Tags
            filter the people list and highlight people in the tree.
          </p>
        </div>
        <Button
          variant="primary"
          iconStart={<Plus size={16} aria-hidden />}
          onClick={() => setDialog({ kind: 'new' })}
        >
          New tag
        </Button>
      </header>

      {!tags ? (
        <div aria-busy="true" className={styles.loading}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={48} />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Tags size={24} aria-hidden />}
          title="No tags yet"
          description="Create a tag, then add it to people from their page."
        />
      ) : (
        [...groups].map(([category, items], index) => (
          <section
            key={category}
            aria-labelledby={`tag-category-${index}`}
            className={styles.category}
          >
            <div className={styles.categoryHeader}>
              <h2 id={`tag-category-${index}`} className={styles.categoryTitle}>
                {category}
              </h2>
              {category !== UNCATEGORIZED && (
                <div className={styles.categoryActions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDialog({ kind: 'rename', category })}
                  >
                    Rename category
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirm({ kind: 'category', category, tags: items })}
                  >
                    Delete category
                  </Button>
                </div>
              )}
            </div>
            <ul className={styles.list}>
              {items.map((tag) => (
                <li key={tag.id} className={styles.tag}>
                  <TagBadge label={tag.name} color={tagColor(tag)} />
                  <span className={styles.count}>{people(tag.people)}</span>
                  <span className={styles.links}>
                    <Link to="/people" search={{ tag: tag.id }}>
                      Show people
                    </Link>
                    <Link
                      to="/tree/$personId"
                      params={{ personId: 'home' }}
                      search={{ tag: tag.id }}
                    >
                      Highlight in tree
                    </Link>
                  </span>
                  <IconButton
                    label={`Edit tag ${tag.name}`}
                    size="sm"
                    icon={<Pencil size={14} aria-hidden />}
                    onClick={() => setDialog({ kind: 'edit', tag })}
                  />
                  <IconButton
                    label={`Delete tag ${tag.name}`}
                    size="sm"
                    icon={<Trash2 size={14} aria-hidden />}
                    onClick={() => setConfirm({ kind: 'tag', tag })}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {dialog?.kind === 'new' && (
        <TagDialog
          title="New tag"
          categories={categories}
          onClose={() => setDialog(null)}
          onSave={(v) =>
            edit.mutate({
              label: `Add tag: ${v.name}`,
              send: () => apiSend('POST', `${base}/tags`, v),
            })
          }
        />
      )}
      {dialog?.kind === 'edit' && (
        <TagDialog
          title="Edit tag"
          tag={dialog.tag}
          categories={categories}
          onClose={() => setDialog(null)}
          onSave={(v) =>
            batch(`Edit tag: ${dialog.tag.name}`, [
              { op: 'tag.update', id: dialog.tag.id, patch: v },
            ])
          }
        />
      )}
      {dialog?.kind === 'rename' && (
        <RenameCategory
          category={dialog.category}
          onClose={() => setDialog(null)}
          onSave={(name) =>
            batch(`Rename category: ${dialog.category}`, [
              { op: 'tag.renameCategory', from: dialog.category, to: name },
            ])
          }
        />
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={
          confirm?.kind === 'category'
            ? `Delete the ${confirm.category} category and its ${plural(confirm.tags.length, 'tag')}?`
            : `Delete the ${confirm?.kind === 'tag' ? confirm.tag.name : ''} tag?`
        }
        description="It comes off everyone who has it. You can undo this."
        confirmLabel={confirm?.kind === 'category' ? 'Delete category' : 'Delete tag'}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === 'tag') {
            batch(`Delete tag: ${confirm.tag.name}`, [{ op: 'tag.delete', id: confirm.tag.id }]);
          } else {
            batch(`Delete category: ${confirm.category}`, [
              { op: 'tag.deleteCategory', category: confirm.category },
            ]);
          }
        }}
      />
    </div>
  );
}
