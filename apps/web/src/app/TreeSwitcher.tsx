import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
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

  const currentName = trees.find((t) => t.id === current)?.name ?? current;

  function open(next: Mode) {
    setMode(next);
    setError(undefined);
    setName(next === 'rename' ? (currentName ?? '') : '');
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
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
        await setCurrentTree(queryClient, tree.id);
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
                onValueChange={(id) => void setCurrentTree(queryClient, id)}
              >
                {trees.map((tree) => (
                  <MenuRadioItem key={tree.id} value={tree.id}>
                    {tree.name}
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
