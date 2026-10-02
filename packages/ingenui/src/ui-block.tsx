/**
 * The runtime of one `ui+jsx` block: its JSX source is pushed through a
 * channel into its own `createIncrementalJsxParser` (so it streams with a
 * live `<Pending />` frontier), rendered inside a per-block error boundary.
 * The block reports its parse errors and render crashes as issues, and keeps
 * its status (state, issues, crash) as an immutable value for the app's
 * block wrapper.
 */

import { Fragment } from "react";
import type { ReactNode } from "react";

import type {
  IncrementalJsxParser,
  IncrementalJsxParserOptions,
} from "@ingenui/incremental-jsx-parser";
import { createIncrementalJsxParser } from "@ingenui/incremental-jsx-parser";

import { UiBlockErrorBoundary } from "./boundary";
import { createPushChannel } from "./channel";
import type { GenUiIssue } from "./issues";

/**
 * Where a block's source stands:
 * - `"streaming"`: its fence is open and its source is still arriving;
 * - `"closed"`: its closing fence arrived;
 * - `"unterminated"`: the message ended before its closing fence (the
 *   stream ended or failed, or the server stopped it mid-block).
 */
export type UiBlockState = "streaming" | "closed" | "unterminated";

/** The issues a block's wrapper sees: the ones found in the block itself. */
export type UiBlockIssue = Extract<GenUiIssue, { kind: "jsx-error" | "render-error" }>;

/** A block's status, as its wrapper sees it. Replaced (never mutated) on change. */
export interface UiBlockStatus {
  /** 0-based, in document order (the issues' `blockIndex`). */
  readonly blockIndex: number;
  readonly state: UiBlockState;
  /**
   * The block's `jsx-error` and `render-error` issues so far, in the order
   * they were found (an unclosed fence shows as `state: "unterminated"`).
   */
  readonly issues: readonly UiBlockIssue[];
  /**
   * Whether the block crashed while rendering: the error boundary shows the
   * fallback from then on (a crash is final). Its `render-error` is in
   * `issues`.
   */
  readonly crashed: boolean;
}

/** What `GenUiMessageOptions.wrapUiBlock` receives for each block. */
export interface UiBlockWrapperProps extends UiBlockStatus {
  /**
   * The block's default rendering: the live tree inside its error boundary
   * (nothing after a crash, or the deprecated `renderUiError` fallback). A
   * wrapper may leave it out, e.g. to render its own fallback when
   * `crashed`.
   */
  readonly children: ReactNode;
}

export interface UiBlockView {
  /** Rendered in place of the block after a crash. */
  fallback: ReactNode;
  /** Wraps the block's rendering (see `GenUiMessageOptions.wrapUiBlock`). */
  wrap?: ((props: UiBlockWrapperProps) => ReactNode) | undefined;
}

export interface UiBlockCallbacks {
  /** Called for each of the block's issues. */
  onIssue(issue: GenUiIssue): void;
  /** Called whenever the block's tree or status changes. */
  onUpdate(): void;
}

export interface UiBlock {
  /** Feed the next piece of the block's JSX source. */
  write(text: string): void;
  /**
   * The block's source is complete: its closing fence arrived (`terminated`),
   * or the message ended without one. The caller re-renders.
   */
  close(terminated: boolean): void;
  /**
   * The block's element: its live tree inside the error boundary, wrapped by
   * the view's `wrap`. A stable reference while neither the tree nor the
   * status changes.
   */
  render(): ReactNode;
  /** Resolves when the block's parser has consumed all of its source. */
  readonly done: Promise<void>;
  dispose(): void;
}

export function createUiBlock(
  blockIndex: number,
  parserOptions: IncrementalJsxParserOptions,
  { onIssue, onUpdate }: UiBlockCallbacks,
  { fallback, wrap }: UiBlockView = { fallback: null },
): UiBlock {
  let status: UiBlockStatus = { blockIndex, state: "streaming", issues: [], crashed: false };
  const addIssue = (issue: UiBlockIssue): void => {
    status = { ...status, issues: [...status.issues, issue] };
    onIssue(issue);
  };

  const channel = createPushChannel();
  const parser: IncrementalJsxParser = createIncrementalJsxParser(channel.source, {
    ...parserOptions,
    // The parser reports errors before notifying, so the update below
    // renders the new status.
    onJsxError: (event) => addIssue({ kind: "jsx-error", blockIndex, event }),
  });

  /** Bumped on every parser update. */
  let version = 0;
  parser.subscribe(() => {
    version++;
    onUpdate();
  });

  const onRenderError = (error: unknown): void => {
    if (status.crashed) return;
    addIssue({ kind: "render-error", blockIndex, error });
    status = { ...status, crashed: true };
    onUpdate();
  };

  let rendered: { version: number; status: UiBlockStatus; node: ReactNode } | undefined;

  return {
    write: (text) => channel.push(text),
    close(terminated) {
      channel.close();
      if (status.state === "streaming") {
        status = { ...status, state: terminated ? "closed" : "unterminated" };
      }
    },
    render() {
      if (
        rendered?.status === status &&
        // A crashed block's tree is no longer shown.
        (rendered.version === version || status.crashed)
      ) {
        return rendered.node;
      }
      const boundary = (
        <UiBlockErrorBoundary key={`ui-${blockIndex}`} fallback={fallback} onError={onRenderError}>
          {parser.getSnapshot()}
        </UiBlockErrorBoundary>
      );
      const node = wrap ? (
        <Fragment key={`ui-${blockIndex}`}>{wrap({ ...status, children: boundary })}</Fragment>
      ) : (
        boundary
      );
      rendered = { version, status, node };
      return node;
    },
    done: parser.done,
    dispose: () => parser.dispose(),
  };
}
