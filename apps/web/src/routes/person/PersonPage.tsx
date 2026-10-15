import { useEffect } from 'react';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi, useRouter } from '@tanstack/react-router';
import { isNotFound } from '../../api/client';
import { takeUnsaved } from '../../api/edits';
import { personQuery } from '../../api/queries';
import type { PersonDetail } from '../../api/types';
import { useToast } from '../../components/Toast/Toast';
import { fullName, nearestRelative } from '../../lib/person';
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
 * Leaves the page when the person stops existing while it is open (deleted in
 * another window, or by undoing their creation): to the nearest relative, else
 * the people list, with one message that also says when an edit was lost.
 */
function useLeaveWhenGone(tree: string, detail: PersonDetail, error: unknown) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const gone = isNotFound(error);
  const personId = detail.person.id;
  const name = fullName(detail.summary);
  const nearby = nearestRelative(detail);
  useEffect(() => {
    if (!gone) return;
    const lost = takeUnsaved(tree);
    toast({
      title: `${name} was deleted (in another window or by undo)`,
      ...(lost ? { description: "Your changes couldn't be saved." } : {}),
    });
    void (nearby
      ? router.navigate({ to: '/person/$personId', params: { personId: nearby } })
      : router.navigate({ to: '/people' }));
    queryClient.removeQueries({ queryKey: personQuery(tree, personId).queryKey });
  }, [gone, name, nearby, personId, queryClient, router, toast, tree]);
}

/** Ancestry-style person page: header band, then Facts, Gallery, Notes, LifeStory, Sources. */
export function PersonPage() {
  const { personId } = route.useParams();
  const { tree } = route.useLoaderData();
  const { tab = 'facts' } = route.useSearch();
  const navigate = route.useNavigate();
  // The loader already fetched it, so this never suspends on navigation.
  const { data: detail, error } = useSuspenseQuery(personQuery(tree, personId));
  useLeaveWhenGone(tree, detail, error);

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
