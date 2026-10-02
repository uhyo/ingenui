/**
 * Per-block error boundary.
 *
 * AI-generated UI can crash at render time even when it parsed cleanly (a
 * host component throwing on unexpected props, for example). Each `ui+jsx`
 * block is wrapped in one of these so a crash hides **that block only** —
 * never the surrounding Markdown or other blocks — the moment it happens.
 *
 * A crash is final: the boundary stays on the fallback for good, and the
 * error is reported through `onError` (which ingenui records as a
 * `render-error` issue for the model). Retrying as more of the stream
 * arrives would rarely help: an element only appears once its opening tag is
 * complete, so its props are final; only its children still grow, and a
 * component that needs them complete can check `useIsElementComplete()`.
 */

import { Component } from "react";
import type { ReactNode } from "react";

export interface UiBlockErrorBoundaryProps {
  /** Rendered in place of the block after a crash (default: nothing). */
  fallback?: ReactNode;
  /** Called once per caught error. */
  onError?: (error: unknown) => void;
  children?: ReactNode;
}

interface UiBlockErrorBoundaryState {
  failed: boolean;
}

export class UiBlockErrorBoundary extends Component<
  UiBlockErrorBoundaryProps,
  UiBlockErrorBoundaryState
> {
  override state: UiBlockErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): UiBlockErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}
