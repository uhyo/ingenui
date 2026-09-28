/**
 * The renderer-independent AST and the primitives shared by every pipeline
 * stage. Dependency-free, so the tokenizer, tree builder, expression parser,
 * schema, and renderer can all import it without cycles.
 */

/**
 * A node in the renderer-independent AST. Nodes are immutable: a snapshot
 * never changes once handed out, and a closed node is frozen and keeps its
 * identity across snapshots (see `TreeBuilder`).
 */
export type Node =
  | ElementNode
  | FragmentNode
  | TextNode
  | ExpressionNode
  | VariableNode
  | PendingNode;

export interface ElementNode {
  readonly kind: "element";
  readonly id: number;
  readonly tag: string;
  readonly props: Readonly<Record<string, PropValue>>;
  readonly children: readonly Node[];
  readonly status: "open" | "closed";
}

export interface FragmentNode {
  readonly kind: "fragment";
  readonly id: number;
  readonly children: readonly Node[];
  readonly status: "open" | "closed";
}

export interface TextNode {
  readonly kind: "text";
  readonly id: number;
  readonly value: string;
}

export interface ExpressionNode {
  readonly kind: "expression";
  readonly id: number;
  readonly value: unknown;
}

/**
 * A variable reference expression (`{foo}` / `{foo.bar.baz}`). The core only
 * records the dot-notation path; it is resolved at render time against the
 * consumer-supplied `variables` map. It appears as an {@link ExpressionNode}
 * value (child position) or directly as a {@link PropValue} (attribute
 * position).
 */
export interface VariableNode {
  readonly kind: "variable";
  readonly id: number;
  /** Root identifier followed by its member accesses (`a.b.c` → `["a","b","c"]`). */
  readonly path: readonly string[];
}

/**
 * The streaming frontier (PLAN.md §1). While the stream is open there is exactly
 * one of these in the tree, inside the innermost open element. It disappears
 * once the stream ends. The React adapter renders it as `<Pending />`.
 */
export interface PendingNode {
  readonly kind: "pending";
  readonly id: number;
}

/** A resolved prop value (string literal, expression literal, or nested node). */
export type PropValue = string | number | boolean | null | undefined | Node;

/**
 * Stored as an {@link ExpressionNode.value} (or {@link PropValue}) when an
 * expression falls outside the supported subset (PLAN.md §2, §7). It renders
 * as nothing; the error is reported at parse time
 * (`kind: "unsupported-expression"`).
 */
export const UNSUPPORTED_EXPRESSION: unique symbol = Symbol("unsupported-expression");

/** Whether a tag name resolves as a component (Capitalized or `Foo.Bar`). */
export function isComponentName(tag: string): boolean {
  const first = tag.charCodeAt(0);
  return (first >= 65 && first <= 90) || tag.includes(".");
}

/**
 * Path segments that would escape the predefined data (prototype access, the
 * `Function` constructor). The expression parser rejects them as unsupported,
 * and {@link resolveVariablePath} refuses them too, as defense in depth.
 */
export const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Resolve a {@link VariableNode} dot path against a `variables` map — the one
 * canonical lookup, shared by parse-time validation and render-time
 * resolution so the two can never disagree.
 *
 * The root name must be an **own** property of the map (inherited
 * `Object.prototype` members like `toString` are never "predefined"). Each
 * member must be present on the previous value (`in`, prototype chain
 * included; primitives are boxed, so `title.length` resolves on a string),
 * except the {@link FORBIDDEN_SEGMENTS}. `found: true` still covers a
 * `null`/`undefined` *value* — the path itself is valid.
 */
export function resolveVariablePath(
  variables: Record<string, unknown>,
  path: readonly string[],
): { found: true; value: unknown } | { found: false } {
  const [name, ...members] = path;
  if (name === undefined || FORBIDDEN_SEGMENTS.has(name) || !Object.hasOwn(variables, name)) {
    return { found: false };
  }
  let value: unknown = variables[name];
  for (const key of members) {
    if (FORBIDDEN_SEGMENTS.has(key) || value == null || !(key in Object(value))) {
      return { found: false };
    }
    value = (value as Record<string, unknown>)[key];
  }
  return { found: true, value };
}
