import { useEffect } from 'react';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi, useRouter } from '@tanstack/react-router';
import { isNotFound } from '../../api/client';
import { personQuery } from '../../api/queries';
import { useToast } from '../../components/Toast/Toast';
import { fullName } from '../../lib/person';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/Tabs/Tabs';
import { FactsTab } from './FactsTab';
import { NotesTab } from './edit/NotesTab';
import { GalleryTab, LifeStoryTab, SourcesTab } from './OtherTabs';
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

/**
 * Leaves the page when the person stops existing while it is open, e.g. after
 * undoing their creation: back where the user came from, else home.
 */
function useLeaveWhenGone(tree: string, personId: string, name: string, error: unknown) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const gone = isNotFound(error);
  useEffect(() => {
    if (!gone) return;
    toast({ title: `${name} is no longer in the tree` });
    if (router.history.canGoBack()) router.history.back();
    else void router.navigate({ to: '/' });
    queryClient.removeQueries({ queryKey: personQuery(tree, personId).queryKey });
  }, [gone, name, personId, queryClient, router, toast, tree]);
}

/** Ancestry-style person page: header band, then Facts, Gallery, Notes, LifeStory, Sources. */
export function PersonPage() {
  const { personId } = route.useParams();
  const { tree } = route.useLoaderData();
  const { tab = 'facts' } = route.useSearch();
  const navigate = route.useNavigate();
  // The loader already fetched it, so this never suspends on navigation.
  const { data: detail, error } = useSuspenseQuery(personQuery(tree, personId));
  useLeaveWhenGone(tree, personId, fullName(detail.summary), error);

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
            <NotesTab tree={tree} detail={detail} />
          </TabsContent>
          <TabsContent value="lifestory">
            <LifeStoryTab tree={tree} detail={detail} />
          </TabsContent>
          <TabsContent value="sources">
            <SourcesTab detail={detail} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
