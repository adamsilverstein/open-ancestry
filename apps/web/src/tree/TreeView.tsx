import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { UserRoundX } from 'lucide-react';
import {
  expandKey,
  type ExpandDirection,
  type ExpandKey,
  type FanLayout,
  type LayoutNode,
  type TreeLayout,
} from '@open-ancestry/core';
import { Button } from '../components/Button/Button';
import { EmptyState } from '../components/EmptyState/EmptyState';
import { Minimap } from '../components/Minimap/Minimap';
import {
  QuickViewPopover,
  type QuickViewAnchor,
} from '../components/QuickViewPopover/QuickViewPopover';
import { useToast } from '../components/Toast/Toast';
import type { PersonSummary } from '../lib/person';
import { TreeToolbar, type TreeLayout as LayoutKind } from '../components/TreeToolbar/TreeToolbar';
import { Skeleton } from '../components/Skeleton/Skeleton';
import {
  ApiError,
  fetchHome,
  fetchNeighborhood,
  MAX_GENERATIONS,
  parseGenerations,
  treeKeys,
  type NeighborhoodRequest,
} from './api';
import { usePalette } from '../app/palette';
import { lifeEvent, toPersonSummary } from './format';
import { GraphCache } from './graphCache';
import { LayoutClient, type LayoutRequest, type WorkerResponse } from './layoutClient';
import { TreeCanvas, type TreeCanvasHandle } from './TreeCanvas';
import { ZOOM_STEP, type Rect } from './viewport';
import styles from './TreeView.module.css';

export interface TreeSearch {
  tree?: string;
  layout?: LayoutKind;
  up?: number;
  down?: number;
}

/** Search params with `undefined` entries dropped (the route's search has optional keys). */
function cleanSearch(search: { [K in keyof TreeSearch]?: TreeSearch[K] | undefined }): TreeSearch {
  const out: TreeSearch = {};
  if (search.tree !== undefined) out.tree = search.tree;
  if (search.layout !== undefined) out.layout = search.layout;
  if (search.up !== undefined) out.up = search.up;
  if (search.down !== undefined) out.down = search.down;
  return out;
}

const PEDIGREE_CARD = { width: 96, height: 120 };

/** Generations shown above and below the focus person per layout. */
export const DEFAULT_DEPTH: Record<LayoutKind, { up: number; down: number }> = {
  family: { up: 3, down: 2 },
  pedigree: { up: 4, down: 0 },
  descendants: { up: 0, down: 3 },
  fan: { up: 5, down: 0 },
};

/** Deeper fans have rings too thin to click; the pedigree goes deeper instead. */
export const MAX_FAN_GENERATIONS = 6;

const STALE = 5 * 60_000;
/** How long the pointer or keyboard rests on a card before its layout is prepared. */
const PREFETCH_DWELL_MS = 120;
const NO_KIN: Record<string, string> = {};
const REFOCUS_MARK = 'oa-tree-refocus-start';

/** A tiny external store so the minimap re-renders on pan without the tree. */
function createViewportStore() {
  let value: Rect = { x: 0, y: 0, width: 0, height: 0 };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: Rect) {
      value = next;
      for (const l of listeners) l();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function TreeMinimap({
  layout,
  store,
  person,
  onNavigate,
  onDismiss,
}: {
  layout: TreeLayout;
  store: ReturnType<typeof createViewportStore>;
  person: (personId: string) => PersonSummary | undefined;
  onNavigate: (center: { x: number; y: number }) => void;
  onDismiss: () => void;
}) {
  const viewport = useSyncExternalStore(store.subscribe, store.get);
  const nodes = useMemo(
    () =>
      layout.nodes.map((n) => ({
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        sex: person(n.personId)?.sex,
      })),
    [layout, person],
  );
  const bounds = useMemo(
    () => ({
      x: layout.bounds.minX,
      y: layout.bounds.minY,
      width: layout.bounds.width,
      height: layout.bounds.height,
    }),
    [layout],
  );
  return (
    <Minimap
      className={styles.minimap}
      nodes={nodes}
      bounds={bounds}
      viewport={viewport}
      onNavigate={onNavigate}
      onDismiss={onDismiss}
    />
  );
}

interface Result {
  /** The graph the layout was made from; its cards' details come from it. */
  cache: GraphCache;
  layout: TreeLayout | null;
  fan: FanLayout | null;
  kin: Record<string, string>;
  focus: string;
  kind: LayoutKind;
}

function layoutOptions(
  kind: LayoutKind,
  up: number,
  down: number,
  view: Pick<ViewState, 'expanded' | 'collapsed' | 'parents'>,
): LayoutRequest['options'] {
  return kind === 'fan'
    ? { generations: up + 1, collapsed: view.collapsed, selectedParentFamilies: view.parents }
    : {
        ancestorsDepth: up,
        descendantsDepth: down,
        // The pedigree doubles every generation: compact cards fit four on screen.
        ...(kind === 'pedigree' && { cardSize: PEDIGREE_CARD }),
        expanded: view.expanded,
        collapsed: view.collapsed,
        selectedParentFamilies: view.parents,
      };
}

const EMPTY_VIEW = { expanded: [], collapsed: [], parents: {} };

interface ViewState {
  /** Expand state belongs to one focus person and layout. */
  for: string;
  expanded: ExpandKey[];
  collapsed: ExpandKey[];
  parents: Record<string, string>;
}

/** The tree canvas around one focus person: data, layout worker, toolbar, popover, find. */
export function TreeView({
  tree,
  personId,
  search,
}: {
  tree: string;
  personId: string;
  search: TreeSearch;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const kind: LayoutKind = search.layout ?? 'family';
  // Hand-edited URLs can hold anything: clamp to what the server serves.
  const requestedUp = parseGenerations(search.up) ?? DEFAULT_DEPTH[kind].up;
  const fanCapped = kind === 'fan' && requestedUp > MAX_FAN_GENERATIONS;
  const up = fanCapped ? MAX_FAN_GENERATIONS : requestedUp;
  const down = parseGenerations(search.down) ?? DEFAULT_DEPTH[kind].down;

  const canvas = useRef<TreeCanvasHandle>(null);
  // The page remounts this view per tree, so one cache and worker per tree.
  // Replaced (with a fresh worker) when an edit, undo or redo changes the tree:
  // the cache only adds, so a removed relative would otherwise stay on screen.
  const [cache, setCache] = useState(() => new GraphCache());
  const [client] = useState(() => new LayoutClient(() => cache.snapshot()));
  // A new worker (after a reset or crash) starts from the current cache.
  useEffect(() => client.setSnapshot(() => cache.snapshot()), [client, cache]);
  /** Neighborhoods loaded beyond the focus (expanded chevrons), to reload after a reset. */
  const extraLoads = useRef(new Map<string, NeighborhoodRequest>());
  const reload = useRef<NeighborhoodRequest[]>([]);
  const [dataVersion, setDataVersion] = useState(0);
  const [loaded, setLoaded] = useState<{ focus: string; kind: LayoutKind } | null>(null);
  const [failure, setFailure] = useState<{ focus: string; notFound: boolean } | null>(null);
  /** Bumped by "Try again" to re-run loading and layout. */
  const [attempt, setAttempt] = useState(0);
  /** Chevron loads that failed for this focus; the rest of the tree still shows. */
  const [missing, setMissing] = useState<{ focus: string; requests: NeighborhoodRequest[] } | null>(
    null,
  );
  const [result, setResult] = useState<Result | null>(null);
  const [rendered, setRendered] = useState<Result | null>(null);
  const [popoverKey, setPopoverKey] = useState<string | null>(null);
  const palette = usePalette();
  const [menuOpen, setMenuOpen] = useState(false);
  const [minimapVisible, setMinimapVisible] = useState(true);
  const viewKey = `${personId}|${kind}`;
  const [view, setView] = useState<ViewState>({
    for: viewKey,
    expanded: [],
    collapsed: [],
    parents: {},
  });
  const current =
    view.for === viewKey ? view : { for: viewKey, expanded: [], collapsed: [], parents: {} };
  const [viewportStore] = useState(createViewportStore);
  const refocusPending = useRef(false);

  useEffect(() => () => client.dispose(), [client]);

  const ensure = useCallback(
    /** `quiet` merges without re-laying out the view on screen (prefetching). */
    async (request: NeighborhoodRequest, { quiet = false } = {}) => {
      const slice = await queryClient.fetchQuery({
        queryKey: treeKeys.neighborhood(tree, request),
        queryFn: ({ signal }) => fetchNeighborhood(tree, request, signal),
        staleTime: STALE,
      });
      if (!quiet && request.focus !== personId) {
        extraLoads.current.set(JSON.stringify(request), request);
      }
      if (cache.merge(slice)) {
        client.merge(slice);
        if (!quiet) setDataVersion(cache.version);
      }
    },
    [queryClient, tree, cache, client, personId],
  );

  /**
   * Layouts computed ahead for likely next focus people (the card under the
   * pointer or keyboard), so a re-focus skips the worker round trip. Each is
   * valid only for the graph version it was computed on.
   */
  const speculative = useRef(
    new Map<string, { version: number; response: Promise<WorkerResponse>; id: number }>(),
  );
  /** The guess being prepared: its pending dwell timer and neighborhood request. */
  const guess = useRef<{ timer: ReturnType<typeof setTimeout>; request?: NeighborhoodRequest }>(
    null,
  );
  const speculationKey = useCallback(
    (focus: string) => `${kind}|${focus}|${up}|${down}`,
    [kind, up, down],
  );

  const requestFor = useCallback(
    (focus: string): NeighborhoodRequest => ({
      focus,
      // One generation past what is shown, so the next chevron needs no request,
      // but never past the server's limit.
      up: kind === 'descendants' ? 0 : Math.min(up + 1, MAX_GENERATIONS),
      down: kind === 'pedigree' || kind === 'fan' ? 0 : Math.min(down + 1, MAX_GENERATIONS),
      // The family view shows siblings, aunts and uncles (with their spouses).
      siblingsDepth: kind === 'family' ? 2 : 0,
    }),
    [kind, up, down],
  );

  // Load the focus person's neighborhood.
  useEffect(() => {
    let cancelled = false;
    if (!refocusPending.current) {
      performance.mark(REFOCUS_MARK);
      refocusPending.current = true;
    }
    (async () => {
      try {
        await ensure(requestFor(personId));
        // After a reset, bring back what expanded chevrons had loaded.
        const again = reload.current;
        reload.current = [];
        await Promise.allSettled(again.map((r) => ensure(r)));
        if (!cancelled) {
          setFailure(null);
          setLoaded({ focus: personId, kind });
        }
      } catch (error) {
        if (cancelled) return;
        setFailure({
          focus: personId,
          notFound: error instanceof ApiError && error.status === 404,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, cache, personId, kind, ensure, requestFor, attempt]);

  const retryMissing = useCallback(async () => {
    if (!missing) return;
    const { focus, requests } = missing;
    const settled = await Promise.allSettled(requests.map((r) => ensure(r)));
    const failed = requests.filter((_, i) => settled[i]!.status === 'rejected');
    setMissing(failed.length > 0 ? { focus, requests: failed } : null);
  }, [missing, ensure]);

  // Lay out in the worker whenever data or view options change; latest wins.
  const latestRequest = useRef(0);
  useEffect(() => {
    if (loaded?.focus !== personId || loaded.kind !== kind || !cache.has(personId)) return;
    const pristine =
      current.expanded.length === 0 &&
      current.collapsed.length === 0 &&
      Object.keys(current.parents).length === 0;
    const ahead = pristine ? speculative.current.get(speculationKey(personId)) : undefined;
    const id = ++latestRequest.current;
    const fresh = () =>
      client.layout({
        kind,
        focusId: personId,
        options: layoutOptions(kind, up, down, current),
      });
    let response: Promise<WorkerResponse>;
    if (ahead && ahead.version === cache.version) {
      // The guess was right: send it now if it is still waiting for an idle worker,
      // and fall back to a normal layout if it was superseded.
      client.prioritize(ahead.id);
      response = ahead.response.catch(fresh);
    } else {
      response = fresh();
    }
    response.then(
      (response) => {
        if (id !== latestRequest.current) return;
        setResult({
          cache,
          layout: response.layout,
          fan: response.fan,
          kin: response.kin,
          focus: personId,
          kind,
        });
      },
      () => {
        if (id === latestRequest.current) setFailure({ focus: personId, notFound: false });
      },
    );
    // `current` is rebuilt each render; its parts are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, cache, dataVersion, loaded, personId, kind, up, down, view, attempt, speculationKey]);

  const shownResult = result && result.focus === personId && result.kind === kind ? result : null;
  const busy = !shownResult || rendered !== shownResult;

  // Until a reset's new layout arrives, the cards on screen keep their details.
  const shownCache = shownResult?.cache ?? cache;
  const person = useCallback(
    (id: string) => shownCache.display(id, (summary) => toPersonSummary(summary, tree)),
    [shownCache, tree],
  );

  // An edit, undo or redo invalidates the tree's queries (`invalidateTree`). The
  // cache cannot tell what was removed, so start it over: refetch the focus and
  // any expanded neighborhoods, and drop layouts guessed from the old data.
  useEffect(() => {
    let scheduled = false;
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'invalidate') return;
      const key = event.query.queryKey;
      if (key[0] !== 'tree' || key[1] !== tree || key[2] !== 'neighborhood') return;
      // One edit invalidates every query of the tree at once: reset once.
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        reload.current = [...extraLoads.current.values()];
        extraLoads.current.clear();
        speculative.current.clear();
        client.dispose();
        setCache(new GraphCache());
      });
    });
  }, [queryClient, tree, client]);

  const goTo = useCallback(
    (id: string, layout?: LayoutKind) => {
      performance.mark(REFOCUS_MARK);
      refocusPending.current = true;
      setPopoverKey(null);
      void navigate({
        to: '/tree/$personId',
        params: { personId: id },
        search: (prev) => cleanSearch({ ...prev, layout: layout ?? prev.layout }),
      });
    },
    [navigate],
  );

  const goHome = useCallback(async () => {
    try {
      const home = await queryClient.fetchQuery({
        queryKey: treeKeys.home(tree),
        queryFn: ({ signal }) => fetchHome(tree, signal),
        staleTime: STALE,
      });
      if (home) goTo(home);
      else toast({ title: 'This tree has no home person yet' });
    } catch {
      toast({ title: 'Could not load the home person', variant: 'error' });
    }
  }, [queryClient, tree, goTo, toast]);

  const onRendered = useCallback(() => {
    setRendered(shownResult);
    const measure = refocusPending.current;
    refocusPending.current = false;
    // For perf tests and profiling, once the frame showing this layout is painted:
    // a task queued from the next animation frame runs after that frame's paint.
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        // The first layout on screen is the tree's first paint; later ones replace
        // the previous mark, and old re-focus measures are dropped, so the
        // timeline does not grow for the life of the tab.
        if (performance.getEntriesByName('oa-tree-first-paint', 'mark').length === 0) {
          performance.mark('oa-tree-first-paint');
        }
        performance.clearMarks('oa-tree-ready');
        performance.mark('oa-tree-ready');
        if (!measure) return;
        if (performance.getEntriesByName('oa-tree-refocus', 'measure').length >= 100) {
          performance.clearMeasures('oa-tree-refocus');
        }
        try {
          performance.measure('oa-tree-refocus', REFOCUS_MARK, 'oa-tree-ready');
        } catch {
          // The start mark was cleared; nothing to measure.
        }
      };
      channel.port2.postMessage(null);
    });
  }, [shownResult]);

  const onToggle = useCallback(
    (node: LayoutNode, direction: ExpandDirection, expand: boolean) => {
      const key = expandKey(node.personId, direction);
      setView((v) => {
        const base =
          v.for === viewKey ? v : { for: viewKey, expanded: [], collapsed: [], parents: {} };
        return {
          ...base,
          expanded: expand
            ? [...base.expanded.filter((k) => k !== key), key]
            : base.expanded.filter((k) => k !== key),
          collapsed: expand ? base.collapsed.filter((k) => k !== key) : [...base.collapsed, key],
        };
      });
      if (!expand) return;
      // Past the loaded slice: fetch more generations from this person.
      const id = node.personId;
      const more =
        direction === 'up' && cache.needsParents(id)
          ? { focus: id, up: 3, down: 0 }
          : direction === 'down' && cache.needsChildren(id)
            ? { focus: id, up: 0, down: 3 }
            : null;
      if (more) {
        // On failure the rest of the tree stays, with a Retry notice.
        ensure(more).catch(() =>
          setMissing((m) => ({
            focus: personId,
            requests: [...(m?.focus === personId ? m.requests : []), more],
          })),
        );
      }
    },
    [viewKey, cache, ensure, personId],
  );

  const onSwitchParents = useCallback(
    (id: string) => {
      const choice = shownResult?.layout?.alternateParentFamilies[id];
      if (!choice) return;
      const next =
        choice.families[(choice.families.indexOf(choice.selected) + 1) % choice.families.length]!;
      setView((v) => {
        const base =
          v.for === viewKey ? v : { for: viewKey, expanded: [], collapsed: [], parents: {} };
        return { ...base, parents: { ...base.parents, [id]: next } };
      });
    },
    [shownResult, viewKey],
  );

  const onCardClick = useCallback((node: LayoutNode) => {
    if (node.isDuplicate && node.duplicateOf) {
      // Pedigree collapse: jump to the person's original card.
      setPopoverKey(null);
      canvas.current?.centerOnKey(node.duplicateOf);
      canvas.current?.focusCard(node.duplicateOf);
      return;
    }
    setPopoverKey((key) => (key === node.key ? null : node.key));
  }, []);

  // A likely next focus person (hovered or reached by keyboard): after a short
  // dwell, load their neighborhood and lay it out ahead, so re-focusing on them
  // skips the worker round trip. One guess at a time: a newer one cancels the
  // older one's fetch, and the client keeps guesses behind real layouts.
  const onPrefetch = useCallback(
    (id: string) => {
      const previous = guess.current;
      if (previous) {
        clearTimeout(previous.timer);
        if (previous.request) {
          void queryClient.cancelQueries({
            queryKey: treeKeys.neighborhood(tree, previous.request),
          });
        }
      }
      guess.current = null;
      if (id === personId) return;
      const key = speculationKey(id);
      const timer = setTimeout(() => {
        const request = requestFor(id);
        const mine = { timer, request };
        guess.current = mine;
        void ensure(request, { quiet: true })
          .then(() => {
            if (guess.current === mine) guess.current = null;
            const known = speculative.current.get(key);
            if (known?.version === cache.version || !cache.has(id)) return;
            const response = client.layout(
              { kind, focusId: id, options: layoutOptions(kind, up, down, EMPTY_VIEW) },
              { speculative: true },
            );
            // A failed or superseded guess just falls back to a normal layout.
            response.catch(() => {
              if (speculative.current.get(key)?.id === response.id) {
                speculative.current.delete(key);
              }
            });
            speculative.current.delete(key);
            speculative.current.set(key, { version: cache.version, response, id: response.id });
            // Keep the few most recent guesses.
            for (const old of speculative.current.keys()) {
              if (speculative.current.size <= 4) break;
              speculative.current.delete(old);
            }
          })
          .catch(() => {
            // Prefetching is best effort; a cancelled fetch lands here.
          });
      }, PREFETCH_DWELL_MS);
      guess.current = { timer };
    },
    [
      personId,
      speculationKey,
      ensure,
      requestFor,
      cache,
      client,
      kind,
      up,
      down,
      queryClient,
      tree,
    ],
  );

  // A new focus (or leaving the view) drops a guess still waiting out its dwell.
  useEffect(() => () => clearTimeout(guess.current?.timer), [personId]);

  const onInteract = useCallback(() => setPopoverKey(null), []);

  // Shortcuts: + - 0 zoom, H home, F find (the app palette, which re-focuses the
  // tree), L layout, M minimap. Only while
  // focus is in the tree (canvas, toolbar, minimap), so typing elsewhere never triggers them
  // (WCAG 2.1.4).
  useEffect(() => {
    const inTree = (event: KeyboardEvent) =>
      (event.target as HTMLElement).closest?.('[data-tree-region]') !== null;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (!inTree(event)) return;
      const target = event.target as HTMLElement;
      if (
        target.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]',
        )
      )
        return;
      const actions: Record<string, () => void> = {
        '+': () => canvas.current?.zoomBy(ZOOM_STEP),
        '=': () => canvas.current?.zoomBy(ZOOM_STEP),
        '-': () => canvas.current?.zoomBy(1 / ZOOM_STEP),
        _: () => canvas.current?.zoomBy(1 / ZOOM_STEP),
        '0': () => canvas.current?.fit(),
        h: () => void goHome(),
        f: palette.open,
        l: () => setMenuOpen(true),
        m: () => setMinimapVisible((v) => !v),
      };
      const action = actions[event.key.length === 1 ? event.key.toLowerCase() : event.key];
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [goHome, palette]);

  const anchor = useMemo<QuickViewAnchor | null>(
    () =>
      popoverKey
        ? {
            getBoundingClientRect: () => canvas.current?.clientRect(popoverKey) ?? new DOMRect(),
            focus: () => canvas.current?.focusCard(popoverKey),
            isConnected: true,
          }
        : null,
    [popoverKey],
  );
  const popoverNode = shownResult?.layout?.nodes.find((n) => n.key === popoverKey);
  const popoverSummary = popoverNode ? cache.summary(popoverNode.personId) : undefined;
  const focusName = person(personId)?.name;

  if (failure?.focus === personId) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyPanel} data-surface="raised">
          <EmptyState
            level={2}
            icon={<UserRoundX size={28} aria-hidden />}
            title={failure.notFound ? 'Person not found' : 'Could not load the tree'}
            description={
              failure.notFound
                ? 'Nobody with this id is in the tree.'
                : 'Something went wrong loading or drawing this part of the tree.'
            }
            action={
              <div className={styles.emptyActions}>
                {!failure.notFound && (
                  <Button
                    size="sm"
                    onClick={() => {
                      setFailure(null);
                      setAttempt((n) => n + 1);
                    }}
                  >
                    Try again
                  </Button>
                )}
                <Link
                  to="/tree/$personId"
                  params={{ personId: 'home' }}
                  search={{ tree }}
                  className={styles.emptyLink}
                >
                  Go to the home person
                </Link>
              </div>
            }
          />
        </div>
      </div>
    );
  }

  const shown = shownResult?.layout ?? shownResult?.fan ?? null;
  return (
    <>
      <TreeCanvas
        ref={canvas}
        label={focusName ? `Family tree centered on ${focusName}` : 'Family tree'}
        busy={busy}
        kind={kind}
        layout={shownResult?.layout ?? null}
        kin={shownResult?.kin ?? NO_KIN}
        fan={shownResult?.fan ?? null}
        focusPersonId={personId}
        person={person}
        popoverKey={popoverKey}
        onCardClick={onCardClick}
        onRefocus={goTo}
        onToggle={onToggle}
        onSwitchParents={onSwitchParents}
        onPrefetch={onPrefetch}
        onInteract={onInteract}
        onViewportChange={viewportStore.set}
        onRendered={onRendered}
      >
        {!shown && (
          <div className={styles.loading} aria-hidden>
            {[4, 2, 2, 3].map((count, row) => (
              <div key={row} className={styles.loadingRow}>
                {Array.from({ length: count }, (_, i) => (
                  <Skeleton key={i} width={120} height={150} className={styles.loadingCard} />
                ))}
              </div>
            ))}
          </div>
        )}
      </TreeCanvas>
      {missing?.focus === personId && (
        <div className={styles.notice} role="status" data-surface="raised">
          Some relatives could not be loaded.
          <Button size="sm" variant="ghost" onClick={() => void retryMissing()}>
            Retry
          </Button>
        </div>
      )}
      {fanCapped && !missing && (
        <div className={styles.notice} role="status" data-surface="raised" data-tone="info">
          The fan shows {MAX_FAN_GENERATIONS} generations.
          <Link
            to="/tree/$personId"
            params={{ personId }}
            search={(prev) => ({ ...prev, layout: 'pedigree' })}
            className={styles.noticeLink}
          >
            Open the pedigree
          </Link>
        </div>
      )}
      <TreeToolbar
        className={styles.toolbar}
        layout={kind}
        onLayoutChange={(layout) =>
          void navigate({
            to: '/tree/$personId',
            params: { personId },
            search: (prev) =>
              cleanSearch({
                tree: prev.tree,
                layout: layout === 'family' ? undefined : layout,
              }),
          })
        }
        layoutMenuOpen={menuOpen}
        onLayoutMenuOpenChange={setMenuOpen}
        onFind={palette.open}
        onHome={() => void goHome()}
        onZoomIn={() => canvas.current?.zoomBy(ZOOM_STEP)}
        onZoomOut={() => canvas.current?.zoomBy(1 / ZOOM_STEP)}
        onFit={() => canvas.current?.fit()}
        minimapVisible={minimapVisible}
        onToggleMinimap={() => setMinimapVisible((v) => !v)}
      />
      {shownResult?.layout && minimapVisible && (
        <TreeMinimap
          onDismiss={() => setMinimapVisible(false)}
          layout={shownResult.layout}
          store={viewportStore}
          person={person}
          onNavigate={(center) => canvas.current?.centerOnPoint(center)}
        />
      )}
      <QuickViewPopover
        person={popoverSummary ? toPersonSummary(popoverSummary, tree) : null}
        birth={lifeEvent(popoverSummary?.birth ?? null)}
        death={lifeEvent(popoverSummary?.death ?? null)}
        anchor={anchor}
        open={Boolean(popoverSummary)}
        onOpenChange={(open) => {
          if (!open) setPopoverKey(null);
        }}
        onMakeFocus={(p) => goTo(p.id)}
        onEdit={(p) => void navigate({ to: '/person/$personId', params: { personId: p.id } })}
      />
    </>
  );
}
