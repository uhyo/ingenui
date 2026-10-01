/**
 * `createGenUiMessage` — the heart of ingenui.
 *
 * One *message* is one streamed AI response: Markdown text with any number of
 * `ui+jsx` fenced blocks. The stream is split incrementally (see
 * `splitter.ts`); Markdown regions render through the (pluggable) Markdown
 * renderer, and each `ui+jsx` block is piped into its own
 * `createIncrementalJsxParser` so it streams with a live `<Pending />`
 * frontier, wrapped in a per-block error boundary (and, optionally, the
 * app's own block wrapper).
 *
 * The returned store is shaped like the underlying parser's — a drop-in for
 * `useSyncExternalStore` — plus the feedback surface: every parse error,
 * render crash, and unclosed fence is collected as a {@link GenUiIssue}, and
 * `getIssueReport()` turns them into the text to send back to the model.
 *
 * Three layers, kept apart:
 *  - **model** — the message's regions, a value derived from the splitter's
 *    reports (collected per chunk as events) by a pure reducer
 *    (`message-model.ts`);
 *  - **runtime** — one parser per `ui+jsx` block (`ui-block.tsx`), fed by
 *    the same events (a block's text merged into one write per chunk);
 *  - **view** — {@link renderMessage}, a function of the model and the
 *    blocks, with per-region Markdown memoization.
 *
 * This module is the imperative shell tying them to the stream and the store.
 */

import { Fragment } from "react";
import type { ComponentType, ReactNode } from "react";

import type {
  IncrementalJsxParser,
  IncrementalJsxParserOptions,
} from "@ingenui/incremental-jsx-parser";
import type { JsxStreamSource } from "@ingenui/incremental-jsx-parser/core";
import { pumpStream } from "@ingenui/incremental-jsx-parser/core";

import type { ActionEvent, ActionsDefinition } from "./actions";
import { withActionsVariable } from "./actions";
import type { GenUiIssue } from "./issues";
import { formatIssueReport } from "./issues";
import { renderMarkdown as renderMarkdownDefault } from "./markdown";
import type { MarkdownRegion, MessageModel, SplitEvent } from "./message-model";
import {
  applySplitEvents,
  createSplitEventCollector,
  EMPTY_MESSAGE,
  endMessage,
} from "./message-model";
import { createFenceSplitter } from "./splitter";
import type { UiBlock, UiBlockWrapperProps } from "./ui-block";
import { createUiBlock } from "./ui-block";

/** Passed to a custom {@link GenUiMessageOptions.renderMarkdown}. */
export interface MarkdownRenderContext {
  /** The region may still grow: its last line is the streaming frontier. */
  streaming: boolean;
}

export interface GenUiMessageOptions extends Omit<
  IncrementalJsxParserOptions,
  "onJsxError" | "onStreamError"
> {
  /**
   * The actions the model may wire into the UI (`onClick={actions.submit}`).
   * Exposed to every `ui+jsx` block as the predefined variable `actions`
   * (each entry declared as `"function"`), overriding any `actions` key in
   * `variables`. See `actions.ts` for the convention.
   */
  actions?: ActionsDefinition | undefined;
  /**
   * Let the model **define its own actions** by referencing them (the
   * default): any `actions.<name>` resolves — an undeclared name becomes a
   * notify-only action (`declared: false` on its {@link ActionEvent}) that
   * emits the canonical message and runs no host code. Pass `false` to opt
   * out and keep the action vocabulary host-owned: a reference outside
   * `actions` is then reported as an `unknown-variable` issue (and with no
   * `actions` declared, the variable does not exist at all).
   */
  dynamicActions?: boolean | undefined;
  /**
   * Called when the user triggers an action. `event.message` is the canonical
   * text to send to the model as the next request.
   */
  onAction?: ((event: ActionEvent) => void) | undefined;
  /**
   * Called for every issue as it is found — JSX parse errors, render crashes,
   * unclosed fences. The same issues accumulate on the message
   * (`getIssues()` / `getIssueReport()`).
   */
  onIssue?: ((issue: GenUiIssue) => void) | undefined;
  /**
   * The channel for **unrecoverable** errors: called once if the stream
   * source fails. Content received so far stays rendered (open blocks are
   * finalized best-effort) and {@link GenUiMessage.done} rejects with the
   * same error.
   */
  onStreamError?: ((error: unknown) => void) | undefined;
  /**
   * Replace the built-in Markdown renderer for the non-UI regions.
   * `context.streaming` is `true` while the region may still grow (it holds
   * the stream's frontier), so a renderer can show unterminated markup
   * optimistically.
   */
  renderMarkdown?: ((markdown: string, context: MarkdownRenderContext) => ReactNode) | undefined;
  /**
   * Rendered in place of a `ui+jsx` block whose UI crashed at render time
   * (default: nothing — the block is hidden). Called once per block, when it
   * opens.
   *
   * @deprecated Use {@link GenUiMessageOptions.wrapUiBlock}:
   * `({ blockIndex, crashed, children }) => crashed ? fallback : children`.
   */
  renderUiError?: ((blockIndex: number) => ReactNode) | undefined;
  /**
   * Wrap each `ui+jsx` block's rendering, e.g. to collapse or grey out a
   * block with issues, or to show a fallback for a crashed one. Receives the
   * block's status — `blockIndex`, `state` (`"streaming"` / `"closed"` /
   * `"unterminated"`), its `jsx-error` / `render-error` `issues` so far,
   * whether it `crashed` (final) — and `children`, the default rendering.
   * The built-in error boundary stays inside `children`; the wrapper itself
   * is host code and is not guarded.
   *
   * Called again only when the block's tree or status changes: a settled
   * block keeps its element identity.
   */
  wrapUiBlock?: ((props: UiBlockWrapperProps) => ReactNode) | undefined;
}

/**
 * A React-friendly store for one streamed message (the same shape as the
 * parser's store), plus its feedback surface.
 */
export interface GenUiMessage extends IncrementalJsxParser {
  /** Resolves when the stream (and every UI block) completes; rejects on a fatal stream error. */
  readonly done: Promise<void>;
  /** The issues collected so far (a snapshot copy). */
  getIssues(): readonly GenUiIssue[];
  /**
   * The issues formatted as one report addressed to the generating model —
   * the "response to the AI" for a message that had problems — or `null`
   * when the message was clean. Meant to be read after {@link done}.
   */
  getIssueReport(): string | null;
}

/** How {@link renderMessage} renders each part of a message. */
interface MessageView {
  /** A markdown region; `streaming` when it holds the stream's frontier. */
  markdown(region: MarkdownRegion, streaming: boolean): ReactNode;
  /** The frontier placeholder shown after a streaming markdown region. */
  Pending: ComponentType<unknown> | undefined;
}

/** The message's children: its regions in order, plus the frontier. */
function renderMessage(
  model: MessageModel,
  blocks: readonly UiBlock[],
  view: MessageView,
): ReactNode[] {
  const { regions, streaming } = model;
  const children: ReactNode[] = [];
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i]!;
    if (region.kind === "ui") {
      children.push(blocks[region.blockIndex]!.render());
    } else if (region.committed !== "" || region.tail !== "") {
      // Only the last region can still grow.
      children.push(view.markdown(region, streaming && i === regions.length - 1));
    }
  }
  // Inside a UI block, the block's own parser renders the frontier.
  if (streaming && !model.inUi && view.Pending) {
    children.push(<view.Pending key="pending" />);
  }
  return children;
}

/**
 * Memoize `renderMarkdown` per region value (regions are immutable, so a
 * settled region keeps a stable element identity — cheap React
 * reconciliation, like the parser's frozen subtrees).
 */
function memoizeMarkdown(
  renderMarkdown: NonNullable<GenUiMessageOptions["renderMarkdown"]>,
): MessageView["markdown"] {
  const cache = new WeakMap<MarkdownRegion, { streaming: boolean; node: ReactNode }>();
  return (region, streaming) => {
    const cached = cache.get(region);
    if (cached?.streaming === streaming) return cached.node;
    const node = (
      <Fragment key={`md-${region.id}`}>
        {renderMarkdown(region.committed + region.tail, { streaming })}
      </Fragment>
    );
    cache.set(region, { streaming, node });
    return node;
  };
}

/**
 * Create a message store bound to a stream source (a byte or string
 * `ReadableStream`, or any `AsyncIterable` of either — the same sources the
 * JSX parser accepts). The stream is consumed in the background; read
 * {@link GenUiMessage.getSnapshot} for the current tree and subscribe for
 * updates.
 */
export function createGenUiMessage(
  source: JsxStreamSource,
  options: GenUiMessageOptions = {},
): GenUiMessage {
  const {
    onIssue,
    onStreamError,
    renderMarkdown = renderMarkdownDefault,
    renderUiError,
    wrapUiBlock,
    ...rest
  } = options;
  const parserOptions: IncrementalJsxParserOptions = withActionsVariable(rest);

  const listeners = new Set<() => void>();
  let version = 0;
  const bump = (): void => {
    version++;
    for (const listener of listeners) listener();
  };

  const issues: GenUiIssue[] = [];
  const recordIssue = (issue: GenUiIssue): void => {
    issues.push(issue);
    onIssue?.(issue);
  };

  let model: MessageModel = EMPTY_MESSAGE;
  /** Indexed by block index; the last one is the open block while `model.inUi`. */
  const blocks: UiBlock[] = [];

  const collector = createSplitEventCollector();
  const splitter = createFenceSplitter(collector.handlers);

  const apply = (events: readonly SplitEvent[]): void => {
    model = applySplitEvents(model, events);
    // One write per block per chunk: fewer parser updates to render.
    let uiText = "";
    const flushUi = (): void => {
      if (uiText !== "") blocks.at(-1)?.write(uiText);
      uiText = "";
    };
    for (const event of events) {
      switch (event.type) {
        case "openUi":
          blocks.push(
            createUiBlock(
              blocks.length,
              parserOptions,
              { onIssue: recordIssue, onUpdate: bump },
              { fallback: renderUiError?.(blocks.length) ?? null, wrap: wrapUiBlock },
            ),
          );
          break;
        case "ui":
          uiText += event.text;
          break;
        case "closeUi":
          flushUi();
          blocks.at(-1)?.close(event.terminated);
          if (!event.terminated) {
            recordIssue({ kind: "unclosed-fence", blockIndex: blocks.length - 1 });
          }
          break;
      }
    }
    flushUi();
  };

  const view: MessageView = {
    markdown: memoizeMarkdown(renderMarkdown),
    Pending: parserOptions.Pending,
  };

  let renderedVersion = -1;
  let renderedNode: ReactNode = null;
  const getSnapshot = (): ReactNode => {
    if (version !== renderedVersion) {
      renderedVersion = version;
      renderedNode = renderMessage(model, blocks, view);
    }
    return renderedNode;
  };

  const handle = pumpStream(source, {
    write(chunk) {
      splitter.write(chunk);
      apply(collector.take());
      bump();
    },
    end() {
      splitter.end();
      apply(collector.take());
      model = endMessage(model);
      bump();
    },
  });

  const done = handle.done.then(
    async () => {
      // The blocks' own pumps drain asynchronously.
      await Promise.all(blocks.map((block) => block.done));
    },
    (error: unknown) => {
      // Finalize the open block best-effort so its parser settles; the
      // received content stays rendered.
      if (model.inUi) blocks.at(-1)?.close(false);
      model = endMessage(model);
      onStreamError?.(error);
      bump();
      throw error;
    },
  );

  return {
    getSnapshot,
    getServerSnapshot: getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      handle.cancel();
      blocks.at(-1)?.close(false);
      for (const block of blocks) block.dispose();
    },
    done,
    getIssues: () => issues.slice(),
    getIssueReport: () => formatIssueReport(issues),
  };
}
