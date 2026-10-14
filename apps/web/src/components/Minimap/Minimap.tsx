import { useEffect, useId, useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { X } from 'lucide-react';
import { cx } from '../../lib/cx';
import { fitTransform, toWorld, type Rect } from '../../lib/minimap';
import type { Sex } from '../../lib/person';
import { useTheme } from '../../lib/useTheme';
import { IconButton } from '../IconButton/IconButton';
import styles from './Minimap.module.css';

export interface MinimapNode extends Rect {
  sex?: Sex;
}

export interface MinimapProps {
  nodes: MinimapNode[];
  /** World bounds of the laid-out tree. */
  bounds: Rect;
  /** Visible part of the tree, in world coordinates. */
  viewport: Rect;
  /** Called with the world point the viewport should center on. */
  onNavigate: (center: { x: number; y: number }) => void;
  onDismiss?: () => void;
  width?: number;
  height?: number;
  className?: string;
}

const sexToken: Record<Sex, string> = {
  M: '--oa-person-male',
  F: '--oa-person-female',
  U: '--oa-person-unknown',
};

/** Tokens are light-dark() pairs, so resolve them through a real color property. */
function resolveColor(el: HTMLElement, token: string): string {
  el.style.transition = 'none';
  el.style.color = `var(${token})`;
  return getComputedStyle(el).color;
}

/** Canvas overview of the whole tree with the viewport rectangle. Click, drag or use arrows. */
export function Minimap({
  nodes,
  bounds,
  viewport,
  onNavigate,
  onDismiss,
  width = 200,
  height = 140,
  className,
}: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const helpId = useId();
  const { theme } = useTheme();
  const transform = useMemo(() => fitTransform(bounds, width, height), [bounds, width, height]);

  // The nodes are drawn into an offscreen layer once per tree, theme or size;
  // viewport moves (every pan frame) only composite it and stroke the rectangle.
  const layer = useRef<{ key: unknown[]; canvas: HTMLCanvasElement } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { scale, offsetX, offsetY } = transform;
    const project = (r: Rect) =>
      [
        offsetX + (r.x - bounds.x) * scale,
        offsetY + (r.y - bounds.y) * scale,
        Math.max(1, r.width * scale),
        Math.max(1, r.height * scale),
      ] as const;

    const key = [nodes, bounds, transform, width, height, theme, dpr];
    if (!layer.current || key.some((value, i) => value !== layer.current!.key[i])) {
      const offscreen = document.createElement('canvas');
      offscreen.width = width * dpr;
      offscreen.height = height * dpr;
      const off = offscreen.getContext('2d');
      if (off) {
        off.setTransform(dpr, 0, 0, dpr, 0, 0);
        const fills = new Map<Sex, string>();
        for (const sex of Object.keys(sexToken) as Sex[]) {
          fills.set(sex, resolveColor(canvas, sexToken[sex]));
        }
        for (const node of nodes) {
          off.fillStyle = fills.get(node.sex ?? 'U')!;
          off.fillRect(...project(node));
        }
      }
      layer.current = { key, canvas: offscreen };
    }

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.drawImage(layer.current.canvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The viewport sits on the canvas color, so it uses the canvas focus color.
    ctx.strokeStyle = resolveColor(canvas, '--oa-focus-canvas');
    ctx.lineWidth = 2;
    ctx.strokeRect(...project(viewport));
  }, [nodes, bounds, viewport, transform, width, height, theme]);

  function navigateTo(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    onNavigate(toWorld(transform, bounds, event.clientX - rect.left, event.clientY - rect.top));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = { x: viewport.width / 4, y: viewport.height / 4 };
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step.x, 0],
      ArrowRight: [step.x, 0],
      ArrowUp: [0, -step.y],
      ArrowDown: [0, step.y],
    };
    const move = delta[event.key];
    if (!move) return;
    event.preventDefault();
    onNavigate({
      x: Math.round(viewport.x + viewport.width / 2 + move[0]),
      y: Math.round(viewport.y + viewport.height / 2 + move[1]),
    });
  }

  return (
    <div className={cx(styles.minimap, className)} data-surface="raised">
      {/* A 2D pan surface has no fitting widget role; application passes arrow keys through. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        role="application"
        aria-roledescription="minimap"
        aria-label="Minimap"
        aria-describedby={helpId}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className={styles.surface}
        onKeyDown={handleKeyDown}
      >
        <canvas
          ref={canvasRef}
          style={{ width, height }}
          onPointerDown={(event) => {
            dragging.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            navigateTo(event);
          }}
          onPointerMove={(event) => dragging.current && navigateTo(event)}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
        />
      </div>
      <p id={helpId} className="oa-visually-hidden">
        Click or drag to move the view. Arrow keys pan.
      </p>
      {onDismiss && (
        <IconButton
          className={styles.dismiss}
          label="Hide minimap"
          size="sm"
          icon={<X size={14} aria-hidden />}
          onClick={onDismiss}
        />
      )}
    </div>
  );
}
