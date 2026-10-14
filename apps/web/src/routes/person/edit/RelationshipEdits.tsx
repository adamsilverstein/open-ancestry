import { useState, type ReactNode } from 'react';
import type { RelationshipType } from '@open-ancestry/db';
import { MoreHorizontal } from 'lucide-react';
import { apiSend, seg } from '../../../api/client';
import { useEdit } from '../../../api/edits';
import type { ApiPersonSummary, PersonDetail } from '../../../api/types';
import { Button } from '../../../components/Button/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog/ConfirmDialog';
import { Dialog, DialogClose } from '../../../components/Dialog/Dialog';
import { IconButtonBase } from '../../../components/IconButton/IconButtonBase';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../../components/Menu/Menu';
import { Select } from '../../../components/Select/Select';
import { fullName } from '../../../lib/person';
import { RELATIONSHIP_TYPES } from './EditPersonDialog';
import styles from './Edit.module.css';

/*
 * Fixes for wrong relationships, from the Relationships panel: a partnership's
 * type, and removing a parent, partner or child link. Each is one request, so
 * one undo step; people are never deleted.
 */

type ParentFamily = PersonDetail['parentFamilies'][number];
type PartnerFamily = PersonDetail['partnerFamilies'][number];

interface Confirm {
  title: string;
  description: string;
  confirmLabel: string;
  label: string;
  send: () => Promise<unknown>;
}

const names = (people: (ApiPersonSummary | null)[]) =>
  people
    .filter((p) => p !== null)
    .map((p) => fullName(p))
    .join(' and ');

function GroupMenu({ group, children }: { group: string; children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButtonBase
          label={`Actions for ${group}`}
          icon={<MoreHorizontal size={16} aria-hidden />}
          size="sm"
        />
      </MenuTrigger>
      <MenuContent align="end">{children}</MenuContent>
    </Menu>
  );
}

function RelationshipTypeDialog({
  tree,
  family,
  onClose,
}: {
  tree: string;
  family: PartnerFamily;
  onClose: () => void;
}) {
  const edit = useEdit(tree);
  const [type, setType] = useState<RelationshipType>(family.family.relationship_type);
  const partner = family.partner ? fullName(family.partner) : 'an unknown partner';

  function save() {
    onClose();
    if (type === family.family.relationship_type) return;
    edit.mutate({
      label: 'Edit relationship type',
      send: () =>
        apiSend('PATCH', `/trees/${seg(tree)}/families/${family.family.id}`, {
          relationship_type: type,
        }),
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Relationship with ${partner}`}
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
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Select
          label="Relationship type"
          value={type}
          onValueChange={(value) => setType(value as RelationshipType)}
          options={RELATIONSHIP_TYPES}
        />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** Menus for the Relationships panel groups, plus the dialogs they open. */
export function useRelationshipEdits(tree: string, detail: PersonDetail) {
  const edit = useEdit(tree);
  const [typeFor, setTypeFor] = useState<PartnerFamily | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const self = fullName(detail.summary);
  const base = `/trees/${seg(tree)}`;

  const removeChildLink = (child: string, parents: string, linkId: string): Confirm => ({
    title: `Remove ${child} from the family of ${parents}?`,
    description: `${child} will no longer be recorded as their child. Everyone stays in the tree, and you can undo this.`,
    confirmLabel: 'Remove link',
    label: 'Remove child link',
    send: () => apiSend('DELETE', `${base}/family-children/${linkId}`),
  });

  function parentMenu(group: string, family: ParentFamily): ReactNode {
    const parents = names([family.partner1, family.partner2]);
    return (
      <GroupMenu group={group}>
        <MenuItem onSelect={() => setConfirm(removeChildLink(self, parents, family.link.id))}>
          Remove from these parents…
        </MenuItem>
      </GroupMenu>
    );
  }

  function partnerMenu(group: string, family: PartnerFamily): ReactNode {
    const { partner, children } = family;
    const parents = names([detail.summary, partner]);
    const removePartner = (): Confirm => {
      const name = partner ? fullName(partner) : 'the unknown partner';
      if (children.length === 0) {
        return {
          title: `Remove ${name} as partner?`,
          description: `The relationship and its events (such as a marriage) are removed. Both people stay in the tree, and you can undo this.`,
          confirmLabel: 'Remove partner',
          label: 'Remove relationship',
          send: () => apiSend('DELETE', `${base}/families/${family.family.id}`),
        };
      }
      // Children stay with this person; only the partner leaves the family.
      const slot = family.family.partner1_id === partner?.id ? 'partner1_id' : 'partner2_id';
      return {
        title: `Remove ${name} as partner?`,
        description: `${name} will no longer be a parent of ${names(children.map((c) => c.person))}. Both people stay in the tree, and you can undo this.`,
        confirmLabel: 'Remove partner',
        label: 'Remove partner',
        send: () => apiSend('PATCH', `${base}/families/${family.family.id}`, { [slot]: null }),
      };
    };
    return (
      <GroupMenu group={group}>
        <MenuItem onSelect={() => setTypeFor(family)}>Edit relationship type…</MenuItem>
        {partner && (
          <MenuItem onSelect={() => setConfirm(removePartner())}>Remove partner…</MenuItem>
        )}
        {children.map(({ person, link }) => (
          <MenuItem
            key={link.id}
            onSelect={() => setConfirm(removeChildLink(fullName(person), parents, link.id))}
          >
            Remove child {fullName(person)}…
          </MenuItem>
        ))}
      </GroupMenu>
    );
  }

  const dialogs = (
    <>
      {typeFor && (
        <RelationshipTypeDialog tree={tree} family={typeFor} onClose={() => setTypeFor(null)} />
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm?.title ?? ''}
        description={confirm?.description}
        confirmLabel={confirm?.confirmLabel ?? ''}
        onConfirm={() => {
          if (!confirm) return;
          edit.mutate({ label: confirm.label, send: confirm.send });
        }}
      />
    </>
  );

  return { parentMenu, partnerMenu, dialogs };
}
