import { useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '../components/Button/Button';
import { Dialog } from '../components/Dialog/Dialog';
import { Input } from '../components/Input/Input';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '../components/Menu/Menu';
import { useToast } from '../components/Toast/Toast';
import type { TreeLayout } from '../components/TreeToolbar/TreeToolbar';
import {
  createTree,
  currentTreeQuery,
  deleteTree,
  renameTree,
  setCurrentTree,
  treesQuery,
} from '../library/api';
import { treeSwitcherClass } from './treeSwitcherClass';
import styles from './TopBar.module.css';

type Mode = 'create' | 'rename' | 'delete' | null;

/**
 * The open tree in the top bar: switch between trees in the library, create,
 * rename and delete (with confirmation). Lazy loaded with the menu library.
 */
export default function TreeSwitcher() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: trees = [] } = useQuery(treesQuery);
  const { data: current = null } = useQuery(currentTreeQuery);
  const [mode, setMode] = useState<Mode>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  const currentTree = trees.find((t) => t.id === current);
  const currentName = currentTree?.label ?? current;
  const pathname = useLocation({ select: (l) => l.pathname });
  const urlTree = useLocation({ select: (l) => (l.search as { tree?: unknown }).tree });

  /**
   * Makes `id` the open tree; create, rename and switch all come through here.
   * A page that shows one person (the tree view, a person page) moves to the
   * new tree's home person when another tree opens: it must never go on
   * showing, or editing, someone from the tree that was open. Pages about the
   * whole tree (people list, home) stay and follow the current tree. A rename
   * keeps the page and rewrites its `?tree=`, which names the old folder.
   */
  async function goToTree(id: string, how: 'open' | 'rename') {
    // setCurrentTree updates the current tree before it awaits anything, so the
    // home route below already resolves the new tree.
    const switched = setCurrentTree(queryClient, id);
    if (how === 'rename') {
      if (urlTree) {
        await navigate({
          to: '.',
          search: (prev: Record<string, unknown>) => ({ ...prev, tree: id }),
          replace: true,
        });
      }
    } else if (/^\/(tree|person)\//.test(pathname)) {
      // The tree view keeps its layout and generations; the new tree's home person is the focus.
      await navigate({
        to: '/tree/$personId',
        params: { personId: 'home' },
        search: (prev) => {
          const { layout, up, down } = prev as { layout?: TreeLayout; up?: number; down?: number };
          return { layout, up, down };
        },
      });
    }
    await switched;
  }

  function open(next: Mode) {
    setMode(next);
    setError(undefined);
    // Rename edits the stored name, not the label with its folder suffix.
    setName(next === 'rename' ? (currentTree?.name ?? current ?? '') : '');
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (mode !== 'delete' && !name.trim()) {
      // Spaces pass `required`; say what is missing instead of sending it.
      setError('Enter a tree name');
      nameInput.current?.focus();
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      if (mode === 'create') {
        const tree = await createTree(name.trim());
        await setCurrentTree(queryClient, tree.id);
        // A new tree is empty: its people list offers Add person.
        await navigate({ to: '/people' });
      } else if (mode === 'rename' && current) {
        const tree = await renameTree(current, name.trim());
        await goToTree(tree.id, 'rename');
      } else if (mode === 'delete' && current) {
        await deleteTree(current);
        const rest = trees.filter((t) => t.id !== current);
        await setCurrentTree(queryClient, rest[0]?.id ?? null);
        toast({
          title: `Deleted “${currentName}”`,
          description: 'Moved to the library .trash folder.',
        });
        await navigate({ to: '/' });
      }
      setMode(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  const nameDialog = mode === 'create' || mode === 'rename';
  return (
    <>
      <Menu>
        <MenuTrigger
          className={treeSwitcherClass}
          aria-label={`Tree: ${currentName ?? 'none open'}`}
        >
          <span>{currentName ?? 'No tree open'}</span>
          <ChevronDown size={14} aria-hidden />
        </MenuTrigger>
        <MenuContent align="start" className={styles.treeMenu}>
          {/* Actions first, so they stay in reach however many trees there are. */}
          <MenuItem onSelect={() => open('create')}>
            <Plus size={16} aria-hidden />
            New tree…
          </MenuItem>
          <MenuItem disabled={!current} onSelect={() => open('rename')}>
            <Pencil size={16} aria-hidden />
            Rename tree…
          </MenuItem>
          <MenuItem disabled={!current} onSelect={() => open('delete')}>
            <Trash2 size={16} aria-hidden />
            Delete tree…
          </MenuItem>
          {trees.length > 0 && (
            <>
              <MenuSeparator />
              <MenuRadioGroup
                value={current ?? ''}
                onValueChange={(id) => void goToTree(id, 'open')}
              >
                {trees.map((tree) => (
                  <MenuRadioItem key={tree.id} value={tree.id}>
                    {tree.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </>
          )}
        </MenuContent>
      </Menu>

      <Dialog
        open={nameDialog}
        onOpenChange={(isOpen) => !isOpen && setMode(null)}
        title={mode === 'rename' ? 'Rename tree' : 'New tree'}
        size="sm"
        footer={
          <>
            <Button onClick={() => setMode(null)}>Cancel</Button>
            <Button variant="primary" type="submit" form="tree-name-form" disabled={pending}>
              {mode === 'rename' ? 'Rename' : 'Create tree'}
            </Button>
          </>
        }
      >
        <form id="tree-name-form" onSubmit={(event) => void submit(event)}>
          <Input
            ref={nameInput}
            label="Tree name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={error}
            required
            maxLength={100}
          />
        </form>
      </Dialog>

      <Dialog
        open={mode === 'delete'}
        onOpenChange={(isOpen) => !isOpen && setMode(null)}
        title={`Delete “${currentName}”?`}
        description="The tree folder moves to the library's .trash folder, so it can be recovered by hand. It disappears from open-ancestry."
        size="sm"
        footer={
          <>
            <Button onClick={() => setMode(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => void submit()} disabled={pending}>
              Delete tree
            </Button>
          </>
        }
      >
        {error && (
          <p role="alert" className={styles.dialogError}>
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}
