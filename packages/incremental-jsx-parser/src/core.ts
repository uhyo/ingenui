/**
 * Framework-agnostic incremental JSX parser core
 * (`@ingenui/incremental-jsx-parser/core`): a push-based store emitting a
 * renderer-independent AST snapshot. The React adapter (the package root
 * entry) is a thin layer on top. This module has **zero** React dependency.
 */

import type { Node } from "./ast";
import type { JsxErrorEvent, JsxErrorListener } from "./errors";
import { Tokenizer } from "./tokenizer";
import type { MismatchBehavior } from "./tree-builder";
import { TreeBuilder } from "./tree-builder";
import type { SchemaChecks } from "./validate";

export type {
  ElementNode,
  ExpressionNode,
  FragmentNode,
  Node,
  PendingNode,
  PropValue,
  TextNode,
  VariableNode,
} from "./ast";
export {
  FORBIDDEN_SEGMENTS,
  isComponentName,
  resolveVariablePath,
  UNSUPPORTED_EXPRESSION,
} from "./ast";
export type { JsxErrorEvent, JsxErrorListener } from "./errors";
export { formatJsxError } from "./errors";
export type { MismatchBehavior } from "./tree-builder";
export type { SourceLocation } from "./position";
export {
  checkProp,
  checkPropValue,
  describeType,
  formatPromptContract,
  isElementAllowed,
  resolveVariableType,
} from "./schema";
export type {
  ComponentSchemaEntry,
  ElementAllowlist,
  PromptContractOptions,
  PropsDefinition,
  PropTypes,
  SchemaOptions,
  SchemaType,
} from "./schema";
export { pumpStream } from "./stream";
export { createSchemaChecks, validateOpeningTag, validateVariable } from "./validate";
export type { SchemaChecks } from "./validate";
export type { JsxStreamSource, StreamHandle, StreamSink } from "./stream";

/** Options for the low-level {@link createParser}. */
export interface ParserOptions {
  /** Closing-tag mismatch recovery strategy (default: "autoclose"). */
  mismatchedTag?: MismatchBehavior | undefined;
  /**
   * The unified structured error channel: called synchronously, at parse time,
   * for every JSX-level error — whatever recovery mode is configured. Each
   * `write()` / `end()` reports the errors it completed, in source order,
   * before notifying subscribers.
   */
  onJsxError?: JsxErrorListener | undefined;
  /**
   * The schema checks behind the schema errors (unknown components and
   * variables, disallowed elements, invalid props); see
   * {@link createSchemaChecks}. Only consulted when `onJsxError` is set.
   */
  checks?: SchemaChecks | undefined;
}

export type Listener = () => void;
export type Unsubscribe = () => void;

/** The low-level, push-based parser store. */
export interface Parser {
  /** Feed a string chunk into the parser. */
  write(chunk: string): void;
  /** Signal end of stream; drops the trailing `Pending` frontier. */
  end(): void;
  /** Current immutable AST snapshot (top-level node list). */
  getTree(): readonly Node[];
  /** Subscribe to snapshot updates; returns an unsubscribe function. */
  subscribe(listener: Listener): Unsubscribe;
}

/**
 * Create a low-level, push-based incremental JSX parser.
 *
 * Feed it with {@link Parser.write}, finish with {@link Parser.end}, and read
 * the live AST with {@link Parser.getTree}. Subscribers are notified once per
 * processed chunk (PLAN.md §4.6); {@link Parser.getTree} returns a stable
 * reference until the next change, so it is safe with `useSyncExternalStore`.
 */
export function createParser(options: ParserOptions = {}): Parser {
  const { onJsxError } = options;
  const tokenizer = new Tokenizer();
  const builder = new TreeBuilder({
    mismatchedTag: options.mismatchedTag,
    checks: onJsxError && options.checks,
  });
  const listeners = new Set<Listener>();

  let version = 0;
  let cachedVersion = -1;
  let cached: readonly Node[] = [];
  let ended = false;

  const report = (errors: readonly JsxErrorEvent[]): void => {
    // Most chunks complete no error; skip the loop for them.
    if (errors.length === 0 || !onJsxError) return;
    for (let i = 0; i < errors.length; i++) onJsxError(errors[i]!);
  };

  const changed = (): void => {
    version++;
    // Deleting from a Set during iteration is safe, so a listener may
    // unsubscribe itself from within the notification.
    for (const listener of listeners) listener();
  };

  return {
    write(chunk) {
      if (ended || chunk.length === 0) return;
      report(builder.push(tokenizer.write(chunk)));
      changed();
    },
    end() {
      if (ended) return;
      const errors = builder.push(tokenizer.end());
      const unclosed = builder.end();
      ended = true;
      report(errors);
      report(unclosed);
      changed();
    },
    getTree() {
      if (cachedVersion !== version) {
        cached = builder.snapshot(tokenizer.getPending());
        cachedVersion = version;
      }
      return cached;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
