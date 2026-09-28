/**
 * The runtime of one `ui+jsx` block: its JSX source is pushed through a
 * channel into its own `createIncrementalJsxParser` (so it streams with a
 * live `<Pending />` frontier), rendered inside a per-block error boundary.
 * The block reports its parse errors and render crashes as issues.
 */

import type { ReactNode } from "react";

import type {
  IncrementalJsxParser,
  IncrementalJsxParserOptions,
} from "@ingenui/incremental-jsx-parser";
import { createIncrementalJsxParser } from "@ingenui/incremental-jsx-parser";

import { UiBlockErrorBoundary } from "./boundary";
import { createPushChannel } from "./channel";
import type { GenUiIssue } from "./issues";
import { describeError } from "./issues";

export interface UiBlockCallbacks {
  /** Called for each of the block's issues. */
  onIssue(issue: GenUiIssue): void;
  /** Called whenever the block's tree changes. */
  onUpdate(): void;
}

export interface UiBlock {
  /** Feed the next piece of the block's JSX source. */
  write(text: string): void;
  /** The block's source is complete (its closing fence, or the stream's end). */
  close(): void;
  /** The block's element: its live tree inside the error boundary. */
  render(fallback: ReactNode): ReactNode;
  /** Resolves when the block's parser has consumed all of its source. */
  readonly done: Promise<void>;
  dispose(): void;
}

export function createUiBlock(
  blockIndex: number,
  parserOptions: IncrementalJsxParserOptions,
  { onIssue, onUpdate }: UiBlockCallbacks,
): UiBlock {
  const channel = createPushChannel();
  const parser: IncrementalJsxParser = createIncrementalJsxParser(channel.source, {
    ...parserOptions,
    onJsxError: (event) => onIssue({ kind: "jsx-error", blockIndex, event }),
  });

  /** Bumped on every parser update; resets the block's error boundary. */
  let version = 0;
  parser.subscribe(() => {
    version++;
    onUpdate();
  });

  // Report each distinct crash once, not on every retry.
  let lastRenderError: string | undefined;
  const onRenderError = (error: unknown): void => {
    const described = describeError(error);
    if (described === lastRenderError) return;
    lastRenderError = described;
    onIssue({ kind: "render-error", blockIndex, error });
  };

  return {
    write: (text) => channel.push(text),
    close: () => channel.close(),
    render: (fallback) => (
      <UiBlockErrorBoundary
        key={`ui-${blockIndex}`}
        resetKey={version}
        fallback={fallback}
        onError={onRenderError}
      >
        {parser.getSnapshot()}
      </UiBlockErrorBoundary>
    ),
    done: parser.done,
    dispose: () => parser.dispose(),
  };
}
