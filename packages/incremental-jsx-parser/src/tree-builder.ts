/**
 * Tree builder & frontier model (PLAN.md §4.3–§4.4).
 *
 * Consumes the {@link Token} stream and maintains:
 *  - the committed AST (top-level node list), where every node is immutable
 *    and a *closed* node keeps its identity forever (the append-only property
 *    that makes the parser incremental rather than a re-parse per chunk), and
 *  - a stack of currently open elements/fragments. These are builder-private
 *    {@link OpenFrame}s; a frame only becomes a (frozen) node when it closes.
 *
 * {@link TreeBuilder.snapshot} produces the live tree by materializing the open
 * path with the single frontier — any partial text plus one
 * {@link PendingNode} — inside the innermost open node. Closed subtrees are
 * shared, so they keep their identity across snapshots.
 *
 * Errors are **data**: {@link TreeBuilder.push} and {@link TreeBuilder.end}
 * return the JSX error events their tokens produced (the builder calls no
 * listener). Schema errors come from the pure functions in `validate.ts`.
 */

import type { ElementNode, FragmentNode, Node, PendingNode, PropValue, VariableNode } from "./ast";
import { UNSUPPORTED_EXPRESSION } from "./ast";
import type { JsxErrorEvent } from "./errors";
import { parseExpression, type ParsedExpression } from "./expression";
import type { SourceLocation } from "./position";
import type { AttrValue, Pending, Token } from "./tokenizer";
import { Tokenizer } from "./tokenizer";
import type { SchemaChecks } from "./validate";
import { validateOpeningTag, validateVariable } from "./validate";

/**
 * How to repair the tree when a closing tag does not match the innermost open
 * element. Purely a recovery strategy — the mismatch is always reported as a
 * `"mismatched-tag"` error regardless of the mode.
 */
export type MismatchBehavior = "autoclose" | "ignore";

export interface TreeBuilderOptions {
  /** Closing-tag mismatch recovery strategy (default: "autoclose"). */
  mismatchedTag?: MismatchBehavior | undefined;
  /**
   * Schema checks run on every opening tag and variable reference. Absent =
   * no schema errors are reported (structural errors always are).
   */
  checks?: SchemaChecks | undefined;
}

/** Only one frontier marker exists at a time, so its key is fixed. */
const PENDING_NODE: PendingNode = Object.freeze({ kind: "pending", id: -1 });
/** Wraps multiple top-level nodes of nested JSX; ids there are local anyway. */
const NESTED_FRAGMENT_ID = -2;

const NO_CHILDREN: readonly Node[] = Object.freeze([]);
const NO_ERRORS: readonly JsxErrorEvent[] = Object.freeze([]);

/** An opening tag being assembled between `openTagStart` and its `>`. */
interface Building {
  name: string;
  props: Record<string, PropValue>;
  loc: SourceLocation;
}

/**
 * An open element (`tag` non-empty) or fragment (`tag === ""`). Its children
 * grow in place until it closes; a snapshot copies them, so no node handed
 * out ever changes.
 */
interface OpenFrame {
  readonly id: number;
  readonly tag: string;
  readonly props: Readonly<Record<string, PropValue>>;
  readonly children: Node[];
  /** The opening tag's location (for error events). */
  readonly loc: SourceLocation;
}

export class TreeBuilder {
  private readonly mismatchedTag: MismatchBehavior;
  private readonly checks: SchemaChecks | undefined;

  private nextId = 0;
  /** Committed top-level nodes. */
  private readonly roots: Node[] = [];
  /** Outermost first; the last is the frontier's parent. */
  private readonly openStack: OpenFrame[] = [];
  private building: Building | null = null;
  /** Errors produced by the current {@link push} / {@link end} call. */
  private errors: JsxErrorEvent[] = [];
  private ended = false;

  constructor(options: TreeBuilderOptions = {}) {
    this.mismatchedTag = options.mismatchedTag ?? "autoclose";
    this.checks = options.checks;
  }

  /**
   * Apply completed tokens to the committed tree; returns the error events
   * they produced, in source order.
   */
  push(tokens: readonly Token[]): readonly JsxErrorEvent[] {
    for (const token of tokens) this.apply(token);
    return this.takeErrors();
  }

  /**
   * Finalize the stream: close any still-open nodes and drop the frontier.
   * Each auto-closed node is an `"unclosed-tag"` error, innermost first.
   */
  end(): readonly JsxErrorEvent[] {
    while (this.openStack.length > 0) {
      const { tag, loc } = this.openStack[this.openStack.length - 1]!;
      this.errors.push({
        kind: "unclosed-tag",
        message:
          tag === ""
            ? "Unclosed fragment <> at end of input"
            : `Unclosed tag <${tag}> at end of input`,
        tag,
        location: loc,
      });
      this.closeTop();
    }
    this.building = null;
    this.ended = true;
    Object.freeze(this.roots);
    return this.takeErrors();
  }

  /**
   * The live tree: committed nodes plus the frontier (partial text + a single
   * {@link PendingNode}) while the stream is open. After {@link end} the
   * committed roots are returned directly. A pure read.
   */
  snapshot(pending: Pending): readonly Node[] {
    if (this.ended) return this.roots;

    // Partial text is necessarily the next node to be committed (anything
    // else first commits the text run), so it previews the next id.
    const frontier: Node[] =
      pending.type === "text"
        ? [{ kind: "text", id: this.nextId, value: pending.value }, PENDING_NODE]
        : [PENDING_NODE];

    const stack = this.openStack;
    if (stack.length === 0) return [...this.roots, ...frontier];

    // Materialize the open path bottom-up; each open node's last child is the
    // open node below it.
    const deepest = stack[stack.length - 1]!;
    let child = toNode(deepest, [...deepest.children, ...frontier], "open");
    for (let i = stack.length - 2; i >= 0; i--) {
      const frame = stack[i]!;
      child = toNode(frame, [...frame.children, child], "open");
    }
    return [...this.roots, child];
  }

  private apply(token: Token): void {
    switch (token.type) {
      case "openTagStart": {
        this.building = { name: token.name, props: {}, loc: token.loc };
        return;
      }
      case "attribute": {
        if (this.building) {
          this.building.props[token.name] = this.attrToProp(token.name, token.value);
        }
        return;
      }
      case "openTagEnd": {
        const frame = this.completeOpeningTag(token.loc);
        if (frame) this.openStack.push(frame);
        return;
      }
      case "selfClose": {
        const frame = this.completeOpeningTag(token.loc);
        if (frame) this.appendChild(freeze(toNode(frame, NO_CHILDREN, "closed")));
        return;
      }
      case "closeTag": {
        this.closeTag(token.name, token.loc);
        return;
      }
      case "text": {
        this.appendChild(Object.freeze({ kind: "text", id: this.nextId++, value: token.value }));
        return;
      }
      case "expr": {
        const value = this.parseExpr(token.raw, token.loc);
        this.appendChild(Object.freeze({ kind: "expression", id: this.nextId++, value }));
        return;
      }
    }
  }

  private takeErrors(): readonly JsxErrorEvent[] {
    if (this.errors.length === 0) return NO_ERRORS;
    const errors = this.errors;
    this.errors = [];
    return errors;
  }

  private attrToProp(name: string, value: AttrValue): PropValue {
    switch (value.type) {
      case "string":
        return value.value;
      case "boolean":
        return true;
      case "expression":
        // UNSUPPORTED_EXPRESSION is kept as a prop value; the renderer drops it.
        return this.parseExpr(value.raw, value.loc, name) as PropValue;
    }
  }

  /** Parse a `{ }` expression, reporting an unsupported one. */
  private parseExpr(raw: string, loc: SourceLocation, attribute?: string): ParsedExpression {
    const value = parseExpression(
      raw,
      (src) => this.parseJsx(src, loc),
      (path) => this.createVariable(path, loc),
    );
    if (value === UNSUPPORTED_EXPRESSION) {
      this.errors.push({
        kind: "unsupported-expression",
        message:
          attribute === undefined
            ? `Unsupported expression: {${raw}}`
            : `Unsupported expression in attribute "${attribute}": {${raw}}`,
        expression: raw,
        ...(attribute !== undefined && { attribute }),
        location: loc,
      });
    }
    return value;
  }

  private createVariable(rawPath: readonly string[], loc: SourceLocation): VariableNode {
    const path = Object.freeze(rawPath);
    if (this.checks) {
      const error = validateVariable(path, loc, this.checks);
      if (error) this.errors.push(error);
    }
    return Object.freeze({ kind: "variable", id: this.nextId++, path });
  }

  /** Parse nested JSX from an expression with a fresh, self-contained parse. */
  private parseJsx(src: string, loc: SourceLocation): Node | undefined {
    const tokenizer = new Tokenizer();
    const builder = new TreeBuilder({ checks: this.checks });
    const errors = [
      ...builder.push(tokenizer.write(src)),
      ...builder.push(tokenizer.end()),
      ...builder.end(),
    ];
    // Positions inside the buffered expression are relative to its own
    // source, so nested errors are reported at the enclosing `{` instead.
    for (const error of errors) this.errors.push({ ...error, location: loc });
    const nodes = builder.snapshot({ type: "none" });
    if (nodes.length <= 1) return nodes[0];
    return freeze({
      kind: "fragment",
      id: NESTED_FRAGMENT_ID,
      children: [...nodes],
      status: "closed",
    });
  }

  /** Complete the opening tag being assembled; `end` is the location of its `>`. */
  private completeOpeningTag(end: SourceLocation): OpenFrame | null {
    const building = this.building;
    this.building = null;
    if (!building) return null;

    // When the tag ends on the line it started, that line has streamed further
    // since `openTagStart`: adopt the fuller text so error frames show the
    // whole opening tag.
    let loc = building.loc;
    if (end.line === loc.line && end.lineText.length > loc.lineText.length) {
      loc = { ...loc, lineText: end.lineText };
    }

    const { name, props } = building;
    if (name !== "" && this.checks) {
      const errors = validateOpeningTag(name, props, loc, this.checks);
      for (const error of errors) this.errors.push(error);
    }
    return { id: this.nextId++, tag: name, props: Object.freeze(props), children: [], loc };
  }

  /**
   * Handle a closing tag, honoring the {@link MismatchBehavior} when it does not
   * match the innermost open element (PLAN.md §7).
   */
  private closeTag(name: string, loc: SourceLocation): void {
    const stack = this.openStack;
    if (stack.length === 0) {
      this.errors.push({
        kind: "mismatched-tag",
        message: `Stray closing tag </${name}> with nothing open`,
        tag: name,
        expected: null,
        location: loc,
      });
      return;
    }

    const expected = stack[stack.length - 1]!.tag;
    if (expected === name) {
      this.closeTop();
      return;
    }

    this.errors.push({
      kind: "mismatched-tag",
      message: `Mismatched closing tag </${name}>; expected </${expected}>`,
      tag: name,
      expected,
      location: loc,
    });
    if (this.mismatchedTag === "autoclose") {
      // Close down to a matching ancestor if there is one; otherwise treat the
      // tag as closing the innermost element.
      const matchIndex = stack.findLastIndex((frame) => frame.tag === name);
      const target = matchIndex >= 0 ? matchIndex : stack.length - 1;
      while (stack.length > target) this.closeTop();
    }
  }

  /** Pop the innermost open frame and commit it as a frozen, closed node. */
  private closeTop(): void {
    const frame = this.openStack.pop();
    if (frame) this.appendChild(freeze(toNode(frame, frame.children, "closed")));
  }

  private appendChild(node: Node): void {
    const parent = this.openStack[this.openStack.length - 1];
    if (parent) {
      parent.children.push(node);
    } else {
      this.roots.push(node);
    }
  }
}

/** The node an {@link OpenFrame} stands for, with the given children. */
function toNode(
  frame: OpenFrame,
  children: readonly Node[],
  status: "open" | "closed",
): ElementNode | FragmentNode {
  if (frame.tag === "") return { kind: "fragment", id: frame.id, children, status };
  return { kind: "element", id: frame.id, tag: frame.tag, props: frame.props, children, status };
}

function freeze<T extends ElementNode | FragmentNode>(node: T): T {
  Object.freeze(node.children);
  return Object.freeze(node);
}
