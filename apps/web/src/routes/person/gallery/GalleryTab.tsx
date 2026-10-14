import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  CloudOff,
  ExternalLink,
  FileText,
  FileX,
  Image,
  ImageOff,
  ImagePlus,
  Link2Off,
  Music,
  UserRound,
} from 'lucide-react';
import type { MediaRow } from '@open-ancestry/db';
import { invalidateTree, useEdit } from '../../../api/edits';
import type { PersonDetail } from '../../../api/types';
import { Button } from '../../../components/Button/Button';
import { Dialog } from '../../../components/Dialog/Dialog';
import { EmptyState } from '../../../components/EmptyState/EmptyState';
import { Input } from '../../../components/Input/Input';
import { Select } from '../../../components/Select/Select';
import { Skeleton } from '../../../components/Skeleton/Skeleton';
import { eventLabel } from '../../../lib/timeline';
import {
  ancestryLink,
  attachMedia,
  hasThumbnail,
  mediaGroup,
  mediaSource,
  originalUrl,
  personMediaQuery,
  setProfilePhoto,
  thumbUrl,
  type GalleryItem,
  type MediaFilter,
  type MediaOwner,
} from './api';
import { VirtualGrid } from './VirtualGrid';
import styles from './Gallery.module.css';

const FILTERS: [MediaFilter, string][] = [
  ['all', 'All'],
  ['photos', 'Photos'],
  ['documents', 'Documents'],
  ['av', 'Audio & video'],
  ['online', 'Online'],
  ['missing', 'Missing'],
];

const titleOf = (media: MediaRow) => media.title || media.description || 'Untitled';

function ownerLabel(owner: MediaOwner): string | null {
  if (owner.type !== 'event') return null;
  const label = eventLabel(owner.event.type, owner.event.custom_type);
  return owner.event.date_text ? `${label}, ${owner.event.date_text}` : label;
}

/** "Birth" / "Birth, 1898" for media attached to events; nothing for the person alone. */
const attachedTo = (item: GalleryItem) => item.owners.map(ownerLabel).filter(Boolean).join(' · ');

function fileType(media: MediaRow): string {
  if (media.mime === 'application/pdf') return 'PDF';
  if (media.kind === 'audio') return 'Audio';
  if (media.kind === 'video') return 'Video';
  if (media.kind === 'photo') return 'Image';
  return 'File';
}

/** Thumbnails that failed to load (a corrupt or unreadable file), shared by tiles and lightbox. */
type ThumbFailures = { has: (id: string) => boolean; add: (id: string) => void };

function Preview({
  tree,
  media,
  failures,
}: {
  tree: string;
  media: MediaRow;
  failures: ThumbFailures;
}) {
  if (hasThumbnail(media) && !failures.has(media.id)) {
    // Decorative: the tile's caption already names it.
    return (
      <img
        src={thumbUrl(tree, media.id, 'sm')}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => failures.add(media.id)}
      />
    );
  }
  const source = mediaSource(media);
  if (source !== 'local') {
    // Never fetched: remote media are placeholders, and only Ancestry's say so.
    const [Icon, label] =
      source === 'ancestry'
        ? [CloudOff, 'On Ancestry']
        : source === 'remote'
          ? [Link2Off, 'Online, not linked']
          : [FileX, 'File missing'];
    return (
      <span className={styles.placeholder}>
        <Icon size={28} aria-hidden />
        {label}
      </span>
    );
  }
  if (hasThumbnail(media)) {
    return (
      <span className={styles.placeholder}>
        <ImageOff size={28} aria-hidden />
        Image unavailable
      </span>
    );
  }
  const Icon = media.kind === 'audio' || media.kind === 'video' ? Music : FileText;
  return (
    <span className={styles.placeholder}>
      <Icon size={28} aria-hidden />
      {fileType(media)}
    </span>
  );
}

function Tile({
  tree,
  item,
  primary,
  failures,
  onOpen,
  buttonRef,
}: {
  tree: string;
  item: GalleryItem;
  primary: boolean;
  failures: ThumbFailures;
  onOpen: () => void;
  buttonRef: (element: HTMLButtonElement | null) => void;
}) {
  const { media } = item;
  const where = attachedTo(item);
  return (
    <button type="button" className={styles.tile} onClick={onOpen} ref={buttonRef}>
      <span className={styles.preview}>
        <Preview tree={tree} media={media} failures={failures} />
      </span>
      <span className={styles.caption}>
        <span className={styles.title}>{titleOf(media)}</span>
        <span className={styles.meta}>
          {[primary ? 'Profile photo' : null, media.date_text, where].filter(Boolean).join(' · ') ||
            ' '}
        </span>
      </span>
    </button>
  );
}

function Lightbox({
  tree,
  items,
  index,
  primaryId,
  failures,
  onIndexChange,
  onClose,
  onSetPrimary,
}: {
  tree: string;
  items: GalleryItem[];
  failures: ThumbFailures;
  index: number;
  primaryId: string | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onSetPrimary: (mediaId: string) => void;
}) {
  const item = items[index]!;
  const { media } = item;
  const step = (delta: number) => onIndexChange((index + delta + items.length) % items.length);
  // Arrow keys page through the gallery wherever focus is in the dialog (WebKit
  // leaves it on the dialog itself, since links are not focusable there).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!delta) return;
      event.preventDefault();
      onIndexChange((index + delta + items.length) % items.length);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [index, items.length, onIndexChange]);
  const where = attachedTo(item);
  const remoteLink = ancestryLink(media.remote_url);
  // A photo whose thumbnail failed (corrupt file) is not offered as the profile photo.
  const showsImage = hasThumbnail(media) && !failures.has(media.id);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={titleOf(media)}
      size="lg"
      footer={
        <div className={styles.nav}>
          <Button
            iconStart={<ChevronLeft size={16} aria-hidden />}
            onClick={() => step(-1)}
            disabled={items.length < 2}
          >
            Previous
          </Button>
          <span className={styles.position}>
            {index + 1} of {items.length}
          </span>
          <Button onClick={() => step(1)} disabled={items.length < 2}>
            Next
            <ChevronRight size={16} aria-hidden />
          </Button>
        </div>
      }
    >
      <div className={styles.lightbox}>
        <div className={styles.stage}>
          {showsImage ? (
            <img
              src={thumbUrl(tree, media.id, 'lg')}
              alt={titleOf(media)}
              onError={() => failures.add(media.id)}
            />
          ) : (
            <Preview tree={tree} media={media} failures={failures} />
          )}
        </div>
        <dl className={styles.details}>
          {media.date_text && (
            <>
              <dt>Date</dt>
              <dd>{media.date_text}</dd>
            </>
          )}
          {where && (
            <>
              <dt>Attached to</dt>
              <dd>{where}</dd>
            </>
          )}
          {media.description && (
            <>
              <dt>Description</dt>
              <dd>{media.description}</dd>
            </>
          )}
          {media.ancestry_oid && (
            <>
              <dt>Ancestry id</dt>
              <dd className={styles.mono}>{media.ancestry_oid}</dd>
            </>
          )}
        </dl>
        <div className={styles.nav}>
          {media.local_path ? (
            <a href={originalUrl(tree, media.id)} target="_blank" rel="noreferrer noopener">
              Open original <ExternalLink size={14} aria-hidden />
            </a>
          ) : remoteLink ? (
            // Opening it is the user's choice; the app never loads it.
            <a href={remoteLink} target="_blank" rel="noreferrer noopener">
              View on Ancestry <ExternalLink size={14} aria-hidden />
            </a>
          ) : (
            <span />
          )}
          {showsImage &&
            (primaryId === media.id ? (
              <span className={styles.badge}>
                <UserRound size={16} aria-hidden />
                Profile photo
              </span>
            ) : (
              <Button variant="primary" onClick={() => onSetPrimary(media.id)}>
                Set as profile photo
              </Button>
            ))}
        </div>
      </div>
    </Dialog>
  );
}

function AttachDialog({
  tree,
  detail,
  onClose,
  onAttached,
}: {
  tree: string;
  detail: PersonDetail;
  onClose: () => void;
  onAttached: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState(`person:${detail.person.id}`);
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const options = [
    { value: `person:${detail.person.id}`, label: 'This person' },
    ...detail.events
      .filter(({ role }) => role.role === 'principal')
      .map(({ event }) => ({
        value: `event:${event.id}`,
        label: [eventLabel(event.type, event.custom_type), event.date_text]
          .filter(Boolean)
          .join(', '),
      })),
  ];
  async function submit() {
    if (!file) {
      setError('Choose a file to attach');
      return;
    }
    const [type, id] = target.split(':') as ['person' | 'event', string];
    setPending(true);
    setError(undefined);
    try {
      await attachMedia(tree, { type, id }, file);
      await onAttached();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Add media"
      description="The file is copied into this tree's media folder. Identical files are stored once."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={pending} onClick={() => void submit()}>
            Attach
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <Input
          label="File"
          type="file"
          error={error}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <Select label="Attach to" options={options} value={target} onValueChange={setTarget} />
      </div>
    </Dialog>
  );
}

/** Person Gallery tab: every photo, document and Ancestry placeholder of the person. */
export function GalleryTab({ tree, detail }: { tree: string; detail: PersonDetail }) {
  const personId = detail.person.id;
  const queryClient = useQueryClient();
  const { data: items } = useQuery(personMediaQuery(tree, personId));
  const [filter, setFilter] = useState<MediaFilter>('all');
  const [open, setOpen] = useState<number | null>(null);
  const [attaching, setAttaching] = useState(false);
  const tiles = useRef(new Map<string, HTMLButtonElement>());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const failures = useMemo<ThumbFailures>(
    () => ({
      has: (id) => failed.has(id),
      add: (id) => setFailed((prev) => (prev.has(id) ? prev : new Set(prev).add(id))),
    }),
    [failed],
  );

  const counts = useMemo(() => {
    const result: Record<MediaFilter, number> = {
      all: 0,
      photos: 0,
      documents: 0,
      av: 0,
      online: 0,
      missing: 0,
    };
    for (const item of items ?? []) {
      result.all++;
      result[mediaGroup(item.media)]++;
    }
    return result;
  }, [items]);
  const shown = useMemo(
    () => (items ?? []).filter((i) => filter === 'all' || mediaGroup(i.media) === filter),
    [items, filter],
  );

  const edit = useEdit(tree);
  const refresh = () => invalidateTree(queryClient, tree);

  function close() {
    const current = open === null ? undefined : shown[open];
    setOpen(null);
    // Return focus to the tile of the item last shown, not the one first opened.
    if (current) setTimeout(() => tiles.current.get(current.media.id)?.focus(), 0);
  }

  const addButton = (
    <Button iconStart={<ImagePlus size={16} aria-hidden />} onClick={() => setAttaching(true)}>
      Add media
    </Button>
  );

  return (
    <section aria-label="Gallery" className={styles.gallery}>
      {!items ? (
        <Skeleton height={228} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Image size={24} aria-hidden />}
          title="No media yet"
          description="Photos and documents attached to this person or their events appear here."
          action={addButton}
        />
      ) : (
        <>
          <div className={styles.toolbar}>
            <div role="group" aria-label="Media type" className={styles.filters}>
              {FILTERS.map(([value, label]) => (
                <Button
                  key={value}
                  size="sm"
                  variant="secondary"
                  className={styles.filter}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label} ({counts[value]})
                </Button>
              ))}
            </div>
            {addButton}
          </div>
          <p className={styles.count}>
            {shown.length} {shown.length === 1 ? 'item' : 'items'}
          </p>
          <VirtualGrid
            items={shown}
            getKey={(item) => item.media.id}
            renderItem={(item, index) => (
              <Tile
                tree={tree}
                item={item}
                primary={detail.person.primary_media_id === item.media.id}
                failures={failures}
                onOpen={() => setOpen(index)}
                buttonRef={(element) => {
                  if (element) tiles.current.set(item.media.id, element);
                  else tiles.current.delete(item.media.id);
                }}
              />
            )}
          />
        </>
      )}
      {open !== null && shown[open] && (
        <Lightbox
          tree={tree}
          items={shown}
          index={open}
          primaryId={detail.person.primary_media_id}
          failures={failures}
          onIndexChange={setOpen}
          onClose={close}
          onSetPrimary={(mediaId) =>
            // Through the shared edit hook: optimistic, rolled back on error, and one
            // undoable change like every other edit.
            edit.mutate({
              label: 'Set profile photo',
              send: () => setProfilePhoto(tree, personId, mediaId),
              optimistic: {
                personId,
                update: (d) => ({
                  ...d,
                  person: { ...d.person, primary_media_id: mediaId },
                  summary: {
                    ...d.summary,
                    primaryMediaId: mediaId,
                    primaryPhotoLocal: !!items?.find((i) => i.media.id === mediaId)?.media
                      .local_path,
                  },
                }),
              },
            })
          }
        />
      )}
      {attaching && (
        <AttachDialog
          tree={tree}
          detail={detail}
          onClose={() => setAttaching(false)}
          onAttached={refresh}
        />
      )}
    </section>
  );
}
