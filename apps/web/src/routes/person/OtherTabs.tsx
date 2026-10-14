import { useMemo } from 'react';
import { BookMarked, BookOpenText, Image } from 'lucide-react';
import { mediaUrl } from '../../api/queries';
import type { PersonDetail } from '../../api/types';
import { EmptyState } from '../../components/EmptyState/EmptyState';
import { Panel } from '../../components/Panel/Panel';
import { SourceItem } from '../../components/SourceItem/SourceItem';
import { lifeStory } from '../../lib/lifeStory';
import { collectCitations, groupBySource } from '../../lib/sources';
import styles from './PersonPage.module.css';

export function GalleryTab({ tree, detail }: { tree: string; detail: PersonDetail }) {
  const photos = detail.media.filter(({ media }) => media.kind === 'photo' && media.local_path);
  if (photos.length === 0) {
    return (
      <EmptyState
        icon={<Image size={24} aria-hidden />}
        title="No photos yet"
        description="Photos attached to this person in the tree appear here."
      />
    );
  }
  return (
    <ul className={styles.gallery}>
      {photos.map(({ media }) => (
        <li key={media.id}>
          <figure className={styles.photo}>
            <img
              src={mediaUrl(tree, media.id)}
              alt={media.title ?? media.description ?? 'Photo'}
              loading="lazy"
              decoding="async"
              width={media.width ?? 200}
              height={media.height ?? 200}
            />
            {media.title && <figcaption>{media.title}</figcaption>}
          </figure>
        </li>
      ))}
    </ul>
  );
}

export function LifeStoryTab({ detail }: { detail: PersonDetail }) {
  const paragraphs = useMemo(() => lifeStory(detail), [detail]);
  if (paragraphs.length === 0) {
    return (
      <EmptyState
        icon={<BookOpenText size={24} aria-hidden />}
        title="Not enough to tell yet"
        description="Add events like a birth, marriage or residence to build a LifeStory."
      />
    );
  }
  return (
    <article className={styles.story}>
      {paragraphs.map((text) => (
        <p key={text}>{text}</p>
      ))}
    </article>
  );
}

export function SourcesTab({ detail }: { detail: PersonDetail }) {
  const groups = useMemo(() => groupBySource(collectCitations(detail)), [detail]);
  if (groups.length === 0) {
    return <EmptyState icon={<BookMarked size={24} aria-hidden />} title="No sources yet" />;
  }
  return (
    <div className={styles.readable}>
      {groups.map((group) => (
        <Panel key={group.id} title={group.title} headingLevel={2}>
          <ul className={styles.plainList}>
            {group.items.map(({ detail: { citation }, citedFor, link }) => (
              <li key={citation.id}>
                <SourceItem
                  title={`Cited for ${citedFor.join(', ')}`}
                  citation={citation.page ?? undefined}
                  quality={
                    citation.quality !== null && citation.quality >= 0 && citation.quality <= 3
                      ? (citation.quality as 0 | 1 | 2 | 3)
                      : undefined
                  }
                  externalUrl={link?.href}
                  externalLabel={link?.label}
                />
              </li>
            ))}
          </ul>
        </Panel>
      ))}
    </div>
  );
}
