import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { ChevronDown, ChevronUp, ChevronsLeftRight, ChevronsRightLeft, Users } from 'lucide-react';
import type {
  ExpandDirection,
  FanLayout,
  LayoutEdge,
  LayoutNode,
  ParentFamilyChoice,
  TreeLayout,
} from '@open-ancestry/core';
import { GenerationLabel } from '../components/GenerationLabel/GenerationLabel';
import { PersonCard, personCardLabel } from '../components/PersonCard/PersonCard';
import type { TreeLayout as LayoutKind } from '../components/TreeToolbar/TreeToolbar';
import type { PersonSummary } from '../lib/person';
import { FanChart } from './FanChart';
import { buildRelations, neighbor, type Direction } from './relations';
import { GridIndex } from './spatial';
import {
  centerOn,
  fitBounds,
  interpolate,
  toScreen,
  visibleWorld,
  zoomAt,
  type Rect,
  type Transform,
} from './viewport';
import styles from './TreeView.module.css';

/** Grid cell for virtualization, in world pixels. */
const CELL = 512;
/** Screen pixels mounted beyond each viewport edge. */
const OVERSCAN = 240;
/** Below this zoom cards drop their photo and text: they are too small to read. */
const LOD_SCALE = 0.25;
const ANIMATION_MS = 180;
const FIT_PADDING = 64;
const DRAG_THRESHOLD = 4;

export interface TreeCanvasHandle {
  zoomBy: (factor: number) => void;
  fit: () => void;
  centerOnKey: (key: string) => void;
  centerOnPoint: (point: { x: number; y: number }) => void;
  /** Viewport-relative client rect of a card, for anchoring the quick view. */
  clientRect: (key: string) => DOMRect | null;
  focusCard: (key: string) => void;
}

export interface TreeCanvasProps {
  label: string;
  busy: boolean;
  kind: LayoutKind;
  layout: TreeLayout | null;
  fan: FanLayout | null;
  /** Kinship to the focus card by layout key, computed with the layout. */
  kin: Record<string, string>;
  focusPersonId: string;
  person: (personId: string) => PersonSummary | undefined;
  popoverKey: string | null;
  onCardClick: (node: LayoutNode) => void;
  onRefocus: (personId: string) => void;
  onToggle: (node: LayoutNode, direction: ExpandDirection, expand: boolean) => void;
  onSwitchParents: (personId: string) => void;
  onPrefetch: (personId: string) => void;
  /** Pan or zoom began: transient UI anchored to cards should close. */
  onInteract: () => void;
  onViewportChange: (world: Rect) => void;
  /** The layout is on screen (cards mounted). */
  onRendered: () => void;
  children?: ReactNode;
}

interface Visible {
  source: TreeLayout | FanLayout | null;
  nodes: number[];
  edges: number[];
  lod: boolean;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = (p: number) => 1 - (1 - p) ** 3;

function edgeRect(edge: LayoutEdge): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of edge.points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

type EdgeStyle = 'solid' | 'dashed' | 'half';
function edgeStyle(edge: LayoutEdge): EdgeStyle {
  if (edge.child && edge.rel && edge.rel !== 'biological' && edge.rel !== 'unknown')
    return 'dashed';
  if (edge.half) return 'half';
  return 'solid';
}

const toggleLabel: Record<ExpandDirection, [string, string]> = {
  up: ['Show parents of', 'Hide parents of'],
  down: ['Show children of', 'Hide children of'],
  siblings: ['Show siblings of', 'Hide siblings of'],
};

interface CardProps {
  node: LayoutNode;
  person: PersonSummary;
  label: string;
  tabbable: boolean;
  expanded: boolean;
  lod: boolean;
  alternate: ParentFamilyChoice | undefined;
}

/** One card with its chevrons. Events are delegated to the canvas. */
const TreeCard = memo(function TreeCard({
  node,
  person,
  label,
  tabbable,
  expanded,
  lod,
  alternate,
}: CardProps) {
  const tabIndex = tabbable ? 0 : -1;
  const common = {
    'data-key': node.key,
    'data-generation': node.generation,
    'aria-label': label,
    'aria-haspopup': node.isDuplicate ? undefined : ('dialog' as const),
    'aria-expanded': node.isDuplicate ? undefined : expanded,
    tabIndex,
    style: { left: node.x, top: node.y },
  };
  const toggles: [ExpandDirection, boolean, boolean][] = [
    ['up', node.canExpandUp, node.canCollapseUp],
    ['down', node.canExpandDown, node.canCollapseDown],
    ['siblings', node.canExpandSiblings, node.canCollapseSiblings],
  ];
  return (
    <>
      {lod ? (
        <button
          type="button"
          className={styles.lodCard}
          data-sex={person.sex}
          data-focus={node.isFocus || undefined}
          {...common}
        />
      ) : (
        <PersonCard
          person={person}
          focusPerson={node.isFocus}
          duplicate={node.isDuplicate}
          className={styles.card}
          {...common}
        />
      )}
      {!lod &&
        toggles.map(([direction, canExpand, canCollapse]) => {
          if (!canExpand && !canCollapse) return null;
          const expand = !canCollapse;
          const Icon =
            direction === 'siblings'
              ? expand
                ? ChevronsLeftRight
                : ChevronsRightLeft
              : (direction === 'up') === expand
                ? ChevronUp
                : ChevronDown;
          return (
            <button
              key={direction}
              type="button"
              className={styles.chevron}
              data-chevron={direction}
              data-expand={expand}
              data-node={node.key}
              tabIndex={tabIndex}
              aria-label={`${toggleLabel[direction][expand ? 0 : 1]} ${person.name}`}
              style={{
                left: direction === 'siblings' ? node.x - 14 : node.x + node.width / 2 - 12,
                top:
                  direction === 'up'
                    ? node.y - 14
                    : direction === 'down'
                      ? node.y + node.height - 10
                      : node.y + node.height / 2 - 12,
              }}
            >
              <Icon size={14} aria-hidden />
            </button>
          );
        })}
      {!lod && alternate && !node.isDuplicate && (
        <button
          type="button"
          className={styles.switcher}
          data-switch={node.personId}
          tabIndex={tabIndex}
          aria-label={`Switch parents of ${person.name} (showing set ${alternate.families.indexOf(alternate.selected) + 1} of ${alternate.families.length})`}
          style={{ left: node.x + node.width - 30, top: node.y - 14 }}
        >
          <Users size={12} aria-hidden />
          {alternate.families.indexOf(alternate.selected) + 1}/{alternate.families.length}
        </button>
      )}
    </>
  );
});

/**
 * Pan/zoom surface with virtualized cards. The transform lives in a ref and is
 * written straight to the DOM, so panning never re-renders React; cards mount
 * only when the grid cells around the viewport change.
 */
export const TreeCanvas = forwardRef<TreeCanvasHandle, TreeCanvasProps>(function TreeCanvas(
  {
    label,
    busy,
    kind,
    layout,
    fan,
    kin,
    focusPersonId,
    person,
    popoverKey,
    onCardClick,
    onRefocus,
    onToggle,
    onSwitchParents,
    onPrefetch,
    onInteract,
    onViewportChange,
    onRendered,
    children,
  },
  ref,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const transform = useRef<Transform>({ x: 0, y: 0, scale: 1 });
  const size = useRef({ width: 0, height: 0 });
  const frame = useRef(0);
  const animation = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastCells = useRef('');
  const previous = useRef<{ layout: TreeLayout | null; kind: LayoutKind; focus: string } | null>(
    null,
  );
  const renderedFor = useRef<unknown>(null);
  const pendingFocus = useRef<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [visible, setVisible] = useState<Visible>({
    source: null,
    nodes: [],
    edges: [],
    lod: false,
  });

  const source = layout ?? fan;
  const nodeIndex = useMemo(() => new GridIndex(layout?.nodes ?? [], CELL), [layout]);
  const edgeIndex = useMemo(
    () => new GridIndex((layout?.edges ?? []).map(edgeRect), CELL),
    [layout],
  );
  const relations = useMemo(() => (layout ? buildRelations(layout) : null), [layout]);

  // Latest props for callbacks that must stay stable.
  const latest = useRef({ onInteract, onViewportChange, onPrefetch, layout, fan });
  latest.current = { onInteract, onViewportChange, onPrefetch, layout, fan };

  const measure = useCallback(() => {
    const el = viewportRef.current;
    if (el) size.current = { width: el.clientWidth, height: el.clientHeight };
    return size.current;
  }, []);

  const updateVisible = useCallback(
    (force = false) => {
      const { layout: current, fan: currentFan } = latest.current;
      const t = transform.current;
      const { width, height } = size.current;
      latest.current.onViewportChange(visibleWorld(t, width, height));
      const world = visibleWorld(t, width, height);
      const pad = OVERSCAN / t.scale;
      const c0 = Math.floor((world.x - pad) / CELL);
      const r0 = Math.floor((world.y - pad) / CELL);
      const c1 = Math.floor((world.x + world.width + pad) / CELL);
      const r1 = Math.floor((world.y + world.height + pad) / CELL);
      const lod = t.scale < LOD_SCALE;
      const key = `${c0},${r0},${c1},${r1},${lod}`;
      if (!force && key === lastCells.current) return;
      lastCells.current = key;
      const rect = {
        x: c0 * CELL,
        y: r0 * CELL,
        width: (c1 - c0 + 1) * CELL,
        height: (r1 - r0 + 1) * CELL,
      };
      setVisible({
        source: current ?? currentFan,
        nodes: nodeIndex.query(rect),
        edges: edgeIndex.query(rect),
        lod,
      });
    },
    [nodeIndex, edgeIndex],
  );

  const apply = useCallback(
    (t: Transform) => {
      transform.current = t;
      const world = worldRef.current;
      if (world) {
        world.style.transform = `translate3d(${t.x}px, ${t.y}px, 0) scale(${t.scale})`;
        world.dataset.x = String(t.x);
        world.dataset.y = String(t.y);
        world.dataset.scale = String(t.scale);
      }
      if (!frame.current) {
        frame.current = requestAnimationFrame(() => {
          frame.current = 0;
          updateVisible();
        });
      }
    },
    [updateVisible],
  );

  /** Promotes the world to its own layer while moving; crisp re-raster when idle. */
  const moving = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    world.style.willChange = 'transform';
    clearTimeout(idle.current);
    idle.current = setTimeout(() => {
      world.style.willChange = '';
    }, 200);
  }, []);

  const stopAnimation = () => {
    cancelAnimationFrame(animation.current);
    if (worldRef.current) delete worldRef.current.dataset.animating;
  };

  const animateTo = useCallback(
    (target: Transform) => {
      stopAnimation();
      if (reducedMotion()) {
        apply(target);
        return;
      }
      const from = transform.current;
      const start = performance.now();
      // Lets tests (and anything else) wait for the view to settle.
      if (worldRef.current) worldRef.current.dataset.animating = '';
      const step = (now: number) => {
        const p = Math.min(1, (now - start) / ANIMATION_MS);
        moving();
        apply(interpolate(from, target, ease(p)));
        if (p < 1) animation.current = requestAnimationFrame(step);
        else stopAnimation();
      };
      animation.current = requestAnimationFrame(step);
    },
    [apply, moving],
  );

  const centeredOnFocus = useCallback((t: Transform): Transform => {
    const { width, height } = size.current;
    const { layout: current, fan: currentFan } = latest.current;
    const focus = current?.nodes.find((n) => n.isFocus);
    if (focus)
      return centerOn(t, focus.x + focus.width / 2, focus.y + focus.height / 2, width, height);
    if (currentFan) {
      const b = currentFan.bounds;
      return centerOn(t, b.minX + b.width / 2, b.minY + b.height / 2, width, height);
    }
    return t;
  }, []);

  const nodeByKey = useCallback((key: string) => relations?.nodes.get(key) ?? null, [relations]);

  const ensureOnScreen = useCallback(
    (key: string) => {
      const node = nodeByKey(key);
      if (!node) return;
      const { width, height } = size.current;
      const r = toScreen(transform.current, node);
      const margin = 24;
      if (
        r.x >= margin &&
        r.y >= margin &&
        r.x + r.width <= width - margin &&
        r.y + r.height <= height - margin
      )
        return;
      animateTo(
        centerOn(
          transform.current,
          node.x + node.width / 2,
          node.y + node.height / 2,
          width,
          height,
        ),
      );
    },
    [nodeByKey, animateTo],
  );

  const focusCard = useCallback(
    (key: string) => {
      setActiveKey(key);
      pendingFocus.current = key;
      ensureOnScreen(key);
      // Already mounted: focus now. Otherwise the commit effect below does.
      const el = viewportRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
      if (el) {
        el.focus({ preventScroll: true });
        pendingFocus.current = null;
      }
    },
    [ensureOnScreen],
  );

  useImperativeHandle(
    ref,
    () => ({
      zoomBy(factor) {
        const { width, height } = measure();
        latest.current.onInteract();
        animateTo(zoomAt(transform.current, width / 2, height / 2, factor));
      },
      fit() {
        const { width, height } = measure();
        const bounds = latest.current.layout?.bounds ?? latest.current.fan?.bounds;
        if (!bounds) return;
        latest.current.onInteract();
        animateTo(fitBounds(bounds, width, height, FIT_PADDING));
      },
      centerOnKey(key) {
        const node = nodeByKey(key);
        if (!node) return;
        const { width, height } = measure();
        animateTo(
          centerOn(
            transform.current,
            node.x + node.width / 2,
            node.y + node.height / 2,
            width,
            height,
          ),
        );
      },
      centerOnPoint({ x, y }) {
        const { width, height } = measure();
        stopAnimation();
        latest.current.onInteract();
        apply(centerOn(transform.current, x, y, width, height));
      },
      clientRect(key) {
        const node = nodeByKey(key);
        const el = viewportRef.current;
        if (!node || !el) return null;
        const box = el.getBoundingClientRect();
        const r = toScreen(transform.current, node);
        return new DOMRect(box.left + r.x, box.top + r.y, r.width, r.height);
      },
      focusCard,
    }),
    [animateTo, apply, focusCard, measure, nodeByKey],
  );

  // New layout: place the view, then mount what is visible before paint.
  useLayoutEffect(() => {
    if (!source) return;
    measure();
    const prev = previous.current;
    previous.current = { layout, kind, focus: focusPersonId };
    if (!prev || prev.kind !== kind) {
      stopAnimation();
      apply(centeredOnFocus(transform.current));
    } else if (prev.focus !== focusPersonId) {
      if (keepFocus.current) {
        keepFocus.current = false;
        pendingFocus.current = focusPersonId;
      }
      // Re-focus: jump so the new focus card is where it was, then glide it to the center.
      const old = prev.layout?.nodes.find((n) => n.key === focusPersonId);
      stopAnimation();
      if (old && layout) {
        const t = transform.current;
        apply({ x: t.x + old.x * t.scale, y: t.y + old.y * t.scale, scale: t.scale });
        animateTo(centeredOnFocus(transform.current));
      } else {
        apply(centeredOnFocus(transform.current));
      }
    }
    updateVisible(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // The active card starts on the focus person and resets when it leaves the layout.
  useEffect(() => {
    setActiveKey(focusPersonId);
  }, [focusPersonId]);
  const active = activeKey && relations?.nodes.has(activeKey) ? activeKey : focusPersonId;

  useLayoutEffect(() => {
    if (visible.source && visible.source === source && renderedFor.current !== source) {
      renderedFor.current = source;
      onRendered();
    }
    const key = pendingFocus.current;
    if (key) {
      const el = viewportRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
      if (el) {
        el.focus({ preventScroll: true });
        pendingFocus.current = null;
      }
    }
  });

  // Size changes re-run virtualization.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      measure();
      updateVisible(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, updateVisible]);

  // Wheel pans; ctrl/cmd + wheel (and trackpad pinch, which arrives as ctrl + wheel) zooms.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      stopAnimation();
      latest.current.onInteract();
      moving();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.current.height : 1;
      const t = transform.current;
      if (event.ctrlKey || event.metaKey) {
        const box = el.getBoundingClientRect();
        const factor = Math.exp(-event.deltaY * unit * 0.0025);
        apply(zoomAt(t, event.clientX - box.left, event.clientY - box.top, factor));
      } else {
        apply({ x: t.x - event.deltaX * unit, y: t.y - event.deltaY * unit, scale: t.scale });
      }
    };
    // Safari reports trackpad pinch as gesture events.
    let gestureScale = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureScale = 1;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const e = event as Event & { scale: number; clientX: number; clientY: number };
      const box = el.getBoundingClientRect();
      apply(
        zoomAt(
          transform.current,
          e.clientX - box.left,
          e.clientY - box.top,
          e.scale / gestureScale,
        ),
      );
      gestureScale = e.scale;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
    };
  }, [apply, moving]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      stopAnimation();
      clearTimeout(idle.current);
    },
    [],
  );

  // ----- pointer: drag to pan, two fingers to pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; t: Transform; moved: boolean } | null>(null);
  const pinch = useRef<{ distance: number; t: Transform } | null>(null);
  const suppressClick = useRef(false);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    stopAnimation();
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) {
      drag.current = { x: event.clientX, y: event.clientY, t: transform.current, moved: false };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), t: transform.current };
      drag.current = null;
    }
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const el = viewportRef.current!;
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const box = el.getBoundingClientRect();
      const factor = Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.distance;
      moving();
      apply(zoomAt(pinch.current.t, (a.x + b.x) / 2 - box.left, (a.y + b.y) / 2 - box.top, factor));
      return;
    }
    const d = drag.current;
    if (!d) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      d.moved = true;
      el.setPointerCapture(event.pointerId);
      latest.current.onInteract();
    }
    moving();
    apply({ x: d.t.x + dx, y: d.t.y + dy, scale: d.t.scale });
  }

  function onPointerEnd(event: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (drag.current?.moved) suppressClick.current = true;
    if (pointers.current.size === 0) drag.current = null;
  }

  /** Re-focus from inside the canvas: keyboard focus follows to the new focus card. */
  const keepFocus = useRef(false);
  function refocus(personId: string) {
    keepFocus.current = Boolean(viewportRef.current?.contains(document.activeElement));
    onRefocus(personId);
  }

  // ----- delegated card events.
  const nodeOf = (target: EventTarget | null) => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>('[data-key]');
    return el ? nodeByKey(el.dataset.key!) : null;
  };

  // A drag ends with a click on whatever was under the pointer; swallow it.
  function onClickCapture(event: MouseEvent<HTMLDivElement>) {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.stopPropagation();
    event.preventDefault();
  }

  function onClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const chevron = target.closest<HTMLElement>('[data-chevron]');
    if (chevron) {
      const node = nodeByKey(chevron.dataset.node!);
      if (node) {
        setActiveKey(node.key);
        onToggle(
          node,
          chevron.dataset.chevron as ExpandDirection,
          chevron.dataset.expand === 'true',
        );
      }
      return;
    }
    const switcher = target.closest<HTMLElement>('[data-switch]');
    if (switcher) {
      onSwitchParents(switcher.dataset.switch!);
      return;
    }
    const node = nodeOf(target);
    if (node) {
      setActiveKey(node.key);
      onCardClick(node);
    }
  }

  function onDoubleClick(event: MouseEvent<HTMLDivElement>) {
    const node = nodeOf(event.target);
    if (node && !node.isDuplicate && !node.isFocus) refocus(node.personId);
  }

  const hover = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  function onPointerOver(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.moved) return;
    const node = nodeOf(event.target);
    if (!node || hover.current?.key === node.key) return;
    if (hover.current) clearTimeout(hover.current.timer);
    hover.current = {
      key: node.key,
      timer: setTimeout(() => latest.current.onPrefetch(node.personId), 120),
    };
  }

  const arrows: Record<string, Direction> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
  };

  const lastMove = useRef<{ from: string; to: string; direction: Direction } | null>(null);
  const opposite: Record<Direction, Direction> = {
    up: 'down',
    down: 'up',
    left: 'right',
    right: 'left',
  };

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    const node = target.dataset.key ? nodeByKey(target.dataset.key) : null;
    if (!node || !relations) return;
    const direction = arrows[event.key];
    if (direction) {
      // Reversing a move returns to where it came from (down after up goes back).
      const last = lastMove.current;
      const next =
        last &&
        last.to === node.key &&
        opposite[last.direction] === direction &&
        relations.nodes.has(last.from)
          ? last.from
          : neighbor(relations, node.key, direction);
      lastMove.current = next ? { from: node.key, to: next, direction } : null;
      if (!next) return;
      event.preventDefault();
      focusCard(next);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (node.isDuplicate || node.isFocus) onCardClick(node);
      else refocus(node.personId);
    } else if (event.key === ' ') {
      event.preventDefault();
      if (!event.repeat) onCardClick(node);
    }
  }

  function onKeyUp(event: KeyboardEvent<HTMLDivElement>) {
    // The button would also "click" on Space release; keydown already handled it.
    if (event.key === ' ' && (event.target as HTMLElement).dataset.key) event.preventDefault();
  }

  // Keyboard focus landing on a card off screen (Tab, screen reader) brings it into view.
  function onFocus(event: FocusEvent<HTMLDivElement>) {
    const key = (event.target as HTMLElement).dataset.key;
    if (key) {
      setActiveKey(key);
      ensureOnScreen(key);
    }
  }

  // ----- render.
  const focusName = person(focusPersonId)?.name ?? '';

  const shown = visible.source === layout && layout ? visible : null;
  const cardIndexes = useMemo(() => {
    if (!shown || !layout) return [];
    const list = shown.nodes.slice();
    const activeIndex = layout.nodes.findIndex((n) => n.key === active);
    // The roving tab stop is always in the DOM, even when scrolled away.
    if (activeIndex >= 0 && !list.includes(activeIndex)) list.push(activeIndex);
    return list;
  }, [shown, layout, active]);

  const edgePaths = useMemo(() => {
    if (!shown || !layout) return null;
    const d: Record<EdgeStyle, string[]> = { solid: [], dashed: [], half: [] };
    for (const i of shown.edges) {
      const edge = layout.edges[i]!;
      const [first, ...rest] = edge.points;
      if (!first) continue;
      d[edgeStyle(edge)].push(
        `M${first[0]} ${first[1]}${rest.map(([x, y]) => `L${x} ${y}`).join('')}`,
      );
    }
    return d;
  }, [shown, layout]);

  return (
    // A 2D pan surface has no fitting widget role; application passes keys through.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={viewportRef}
      role="application"
      aria-roledescription="family tree"
      aria-label={label}
      aria-busy={busy}
      className={styles.viewport}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onPointerOver={onPointerOver}
      onClickCapture={onClickCapture}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onFocus={onFocus}
    >
      <div
        ref={worldRef}
        className={styles.world}
        data-testid="tree-world"
        data-node-count={layout?.nodes.length ?? fan?.segments.length ?? 0}
      >
        {layout?.labels.map((l) => (
          <div
            key={l.generation}
            className={l.anchor === 'right-middle' ? styles.labelGutter : styles.labelColumn}
            style={{ left: l.x, top: l.y }}
          >
            <GenerationLabel>{l.text}</GenerationLabel>
          </div>
        ))}
        {edgePaths && (
          <svg className={styles.edges} data-testid="tree-edges" aria-hidden>
            <path className={styles.edgeSolid} d={edgePaths.solid.join('')} />
            <path className={styles.edgeDashed} d={edgePaths.dashed.join('')} />
            <path className={styles.edgeHalf} d={edgePaths.half.join('')} />
          </svg>
        )}
        {layout &&
          shown &&
          cardIndexes.map((i) => {
            const node = layout.nodes[i]!;
            const p = person(node.personId);
            if (!p) return null;
            const relation = kin[node.key];
            const cardLabel = personCardLabel({
              person: p,
              focusPerson: node.isFocus,
              duplicate: node.isDuplicate,
            });
            return (
              <TreeCard
                key={node.key}
                node={node}
                person={p}
                label={relation ? `${cardLabel}, ${relation} of ${focusName}` : cardLabel}
                tabbable={node.key === active}
                expanded={popoverKey === node.key}
                lod={shown.lod}
                alternate={layout.alternateParentFamilies[node.personId]}
              />
            );
          })}
        {fan && visible.source === fan && (
          <FanChart fan={fan} focusPersonId={focusPersonId} person={person} onRefocus={refocus} />
        )}
      </div>
      {children}
    </div>
  );
});
