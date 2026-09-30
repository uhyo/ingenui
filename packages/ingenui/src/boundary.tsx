/**
 * Per-block error boundary.
 *
 * AI-generated UI can crash at render time even when it parsed cleanly (a
 * host component throwing on unexpected props, for example). Each `ui+jsx`
 * block is wrapped in one of these so a crash hides **that block only** —
 * never the surrounding Markdown or other blocks — the moment it happens.
 *
 * While the block is still streaming, its content keeps changing; every
 * change bumps `resetKey`, which clears the error state and retries, so a
 * crash caused by a temporarily-truncated tree heals itself as more of the
 * stream arrives. If the final content still crashes, the boundary stays on
 * the fallback and the error is reported through `onError` (which ingenui
 * records as a `render-error` issue for the model). A retry that renders
 * again is reported through `onRecover`.
 */

import { Component } from "react";
import type { ReactNode } from "react";

export interface UiBlockErrorBoundaryProps {
  /** Bump to clear a caught error and re-attempt rendering the children. */
  resetKey: number;
  /** Rendered in place of the block after a crash (default: nothing). */
  fallback?: ReactNode;
  /** Called once per caught error. */
  onError?: (error: unknown) => void;
  /** Called when a retry renders the children again after a crash. */
  onRecover?: () => void;
  children?: ReactNode;
}

interface UiBlockErrorBoundaryState {
  failed: boolean;
  lastResetKey: number;
}

export class UiBlockErrorBoundary extends Component<
  UiBlockErrorBoundaryProps,
  UiBlockErrorBoundaryState
> {
  constructor(props: UiBlockErrorBoundaryProps) {
    super(props);
    this.state = { failed: false, lastResetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<UiBlockErrorBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: UiBlockErrorBoundaryProps,
    state: UiBlockErrorBoundaryState,
  ): Partial<UiBlockErrorBoundaryState> | null {
    // New content for the block: retry.
    if (props.resetKey !== state.lastResetKey) {
      return { failed: false, lastResetKey: props.resetKey };
    }
    return null;
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  override componentDidUpdate(
    _prevProps: UiBlockErrorBoundaryProps,
    prevState: UiBlockErrorBoundaryState,
  ): void {
    if (prevState.failed && !this.state.failed) this.props.onRecover?.();
  }

  override render(): ReactNode {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}
