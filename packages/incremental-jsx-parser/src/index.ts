/**
 * React adapter — the primary, documented entry point
 * (`@ingenui/incremental-jsx-parser`).
 *
 * Wraps the framework-agnostic {@link createParser | core} and converts the AST
 * snapshot into a `React.ReactNode`, injecting a `<Pending />` placeholder at
 * the streaming frontier (PLAN.md §3.1, §4.5). The returned object is shaped to
 * be a drop-in for React's `useSyncExternalStore`.
 */

import type { ReactNode } from "react";

import type { JsxErrorEvent, MismatchBehavior, Node } from "./core";
import { createParser, createSchemaChecks } from "./core";
import { createRenderer, resolveComponent, type RenderOptions } from "./render";
import type { JsxStreamSource } from "./stream";
import { pumpStream } from "./stream";

export type {
  Node,
  ElementNode,
  FragmentNode,
  TextNode,
  ExpressionNode,
  VariableNode,
  PendingNode,
  PropValue,
  MismatchBehavior,
  JsxErrorEvent,
  JsxErrorListener,
  SourceLocation,
} from "./core";
export {
  checkProp,
  checkPropValue,
  describeType,
  formatJsxError,
  formatPromptContract,
  isElementAllowed,
  resolveVariablePath,
  resolveVariableType,
} from "./core";
export type {
  ComponentSchemaEntry,
  ElementAllowlist,
  PromptContractOptions,
  PropsDefinition,
  PropTypes,
  SchemaOptions,
  SchemaType,
} from "./core";
export type { JsxStreamSource } from "./stream";
export { Pending, resolveComponentEntry, useIsElementComplete } from "./render";
export type {
  ComponentEntry,
  ComponentSpec,
  DisallowedElementBehavior,
  UnknownComponentBehavior,
} from "./render";

export interface IncrementalJsxParserOptions extends RenderOptions {
  /** Closing-tag mismatch recovery strategy (default: "autoclose"). */
  mismatchedTag?: MismatchBehavior | undefined;
  /**
   * The channel for **recoverable** errors: unified structured JSX-level
   * events (mismatched/unclosed tags, unknown components, unsupported
   * expressions, schema violations), fired synchronously **by the parse of
   * the chunk that completes each error** — before any render, and in every
   * recovery/rendering mode. Each event carries a `location` (line/column + the offending line's
   * text); `formatJsxError` renders it as a ready-to-log report.
   */
  onJsxError?: ((event: JsxErrorEvent) => void) | undefined;
  /**
   * The channel for **unrecoverable** errors: called once if the stream
   * source fails. Parsing stops at the last good snapshot (which stays
   * rendered) and {@link IncrementalJsxParser.done} rejects with the same
   * error.
   */
  onStreamError?: ((error: unknown) => void) | undefined;
}

/**
 * A React-friendly store: drop-in shaped for `useSyncExternalStore`
 * (`subscribe` + `getSnapshot`), plus lifecycle helpers.
 */
export interface IncrementalJsxParser {
  /** Current React snapshot (stable reference until the tree changes). */
  getSnapshot(): ReactNode;
  /** SSR-safe snapshot. */
  getServerSnapshot(): ReactNode;
  /** Subscribe to updates; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Cancel the stream and detach. */
  dispose(): void;
  /** Resolves when the stream completes, rejects on fatal error. */
  readonly done: Promise<void>;
}

/**
 * Create an incremental JSX parser bound to a stream source. The stream is
 * consumed in the background; read {@link IncrementalJsxParser.getSnapshot} for
 * the current React tree and {@link IncrementalJsxParser.subscribe} for updates.
 */
export function createIncrementalJsxParser(
  source: JsxStreamSource,
  options: IncrementalJsxParserOptions = {},
): IncrementalJsxParser {
  // The checks only run when `onJsxError` is set.
  const core = createParser({
    mismatchedTag: options.mismatchedTag,
    onJsxError: options.onJsxError,
    checks: createSchemaChecks(options, (tag) => resolveComponent(options, tag) !== undefined),
  });
  const renderer = createRenderer(options);

  let lastTree: readonly Node[] | undefined;
  let lastNode: ReactNode = null;

  const getSnapshot = (): ReactNode => {
    const tree = core.getTree();
    if (tree === lastTree) return lastNode;
    lastTree = tree;
    lastNode = renderer.render(tree);
    return lastNode;
  };

  const handle = pumpStream(source, {
    write: (chunk) => core.write(chunk),
    end: () => core.end(),
  });

  const done = handle.done.then(
    () => undefined,
    (error: unknown) => {
      options.onStreamError?.(error);
      throw error;
    },
  );

  return {
    getSnapshot,
    getServerSnapshot: getSnapshot,
    subscribe: (listener) => core.subscribe(listener),
    dispose: () => handle.cancel(),
    done,
  };
}
