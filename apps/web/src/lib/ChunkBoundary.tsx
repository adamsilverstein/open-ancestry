import { Component, type ReactNode } from 'react';

interface ChunkBoundaryProps {
  /** Rendered instead of the children once they fail (a chunk that will not load). */
  fallback: ReactNode;
  children: ReactNode;
  /** Called once when the children fail, e.g. to undo state that waits for them. */
  onError?: () => void;
}

/**
 * Keeps a lazily loaded part of the shell (palette, menus, toasts) from taking
 * the whole app down when its chunk cannot load.
 */
export class ChunkBoundary extends Component<ChunkBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch() {
    this.props.onError?.();
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
