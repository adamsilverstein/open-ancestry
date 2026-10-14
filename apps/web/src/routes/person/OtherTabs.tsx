import { useMemo } from 'react';
import { BookMarked, BookOpenText } from 'lucide-react';
import type { PersonDetail } from '../../api/types';
import { EmptyState } from '../../components/EmptyState/EmptyState';
import { Panel } from '../../components/Panel/Panel';
import { SourceItem } from '../../components/SourceItem/SourceItem';
import { lifeStory } from '../../lib/lifeStory';
import { useOtherSiblings } from './useOtherSiblings';
import { collectCitations, groupBySource } from '../../lib/sources';
import styles from './PersonPage.module.css';

export { GalleryTab } from './gallery/GalleryTab';

export function LifeStoryTab({ tree, detail }: { tree: string; detail: PersonDetail }) {
  const others = useOtherSiblings(tree, detail);
  const paragraphs = useMemo(() => lifeStory(detail, { otherSiblings: others }), [detail, others]);
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
