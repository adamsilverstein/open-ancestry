import { useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { personQuery } from '../../api/queries';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/Tabs/Tabs';
import { FactsTab } from './FactsTab';
import { GalleryTab, LifeStoryTab, NotesTab, SourcesTab } from './OtherTabs';
import { PersonHeader } from './PersonHeader';
import type { PersonTab } from './search';
import styles from './PersonPage.module.css';

const route = getRouteApi('/person/$personId');

const TAB_LABELS: Record<PersonTab, string> = {
  facts: 'Facts',
  gallery: 'Gallery',
  notes: 'Notes',
  lifestory: 'LifeStory',
  sources: 'Sources',
};

/** Ancestry-style person page: header band, then Facts, Gallery, Notes, LifeStory, Sources. */
export function PersonPage() {
  const { personId } = route.useParams();
  const { tree } = route.useLoaderData();
  const { tab = 'facts' } = route.useSearch();
  const navigate = route.useNavigate();
  // The loader already fetched it, so this never suspends on navigation.
  const { data: detail } = useSuspenseQuery(personQuery(tree, personId));

  return (
    // Keyed so per-person UI state (filters, collapsed groups) resets on navigation.
    <div key={personId} className={styles.page}>
      <PersonHeader tree={tree} detail={detail} />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          void navigate({
            search: value === 'facts' ? {} : { tab: value as Exclude<PersonTab, 'facts'> },
            replace: true,
          })
        }
      >
        <div className={styles.tabBar}>
          <TabsList aria-label="Person sections" className={styles.tabList}>
            {(Object.keys(TAB_LABELS) as PersonTab[]).map((key) => (
              <TabsTrigger key={key} value={key}>
                {TAB_LABELS[key]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <div className={styles.body}>
          <TabsContent value="facts">
            <FactsTab tree={tree} detail={detail} />
          </TabsContent>
          <TabsContent value="gallery">
            <GalleryTab tree={tree} detail={detail} />
          </TabsContent>
          <TabsContent value="notes">
            <NotesTab detail={detail} />
          </TabsContent>
          <TabsContent value="lifestory">
            <LifeStoryTab detail={detail} />
          </TabsContent>
          <TabsContent value="sources">
            <SourcesTab detail={detail} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
