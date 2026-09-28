/**
 * Parse-time schema validation as pure functions: each takes a parsed
 * construct plus the {@link SchemaChecks} and returns the error events it
 * warrants. The tree builder calls them; it never decides schema policy
 * itself. React-free.
 */

import type { PropValue } from "./ast";
import { isComponentName } from "./ast";
import type { JsxErrorEvent } from "./errors";
import type { SourceLocation } from "./position";
import type { SchemaOptions } from "./schema";
import { checkProp, isElementAllowed, resolveVariableType } from "./schema";

/**
 * The schema predicates consulted at parse time. None of them affects the
 * tree — they only decide which error events are reported.
 */
export interface SchemaChecks {
  /**
   * Opening a component-like tag (see `isComponentName`) this rejects is an
   * `"unknown-component"` error.
   */
  isKnownComponent(tag: string): boolean;
  /**
   * A variable reference whose dot path this rejects is an
   * `"unknown-variable"` error. It receives the full path, so it may validate
   * the root name only or every segment (see `resolveVariablePath`).
   */
  isKnownVariable(path: readonly string[]): boolean;
  /**
   * Opening an intrinsic (non-component) tag this rejects is a
   * `"disallowed-element"` error (see `isElementAllowed`).
   */
  isAllowedElement(tag: string): boolean;
  /**
   * Probed for every prop when an opening tag completes: a non-`null` return
   * is the rejection reason, an `"invalid-prop"` error (see `checkProp`,
   * which the renderer applies to drop the prop).
   */
  checkProp(tag: string, prop: string, value: PropValue): string | null;
}

/**
 * The canonical {@link SchemaChecks} for a schema — the one wiring shared by
 * every parser (the React adapter, and any server-side validator), so the
 * same text and schema always yield the same errors.
 *
 * `isKnownComponent` defaults to "declared in `options.components`"; the
 * React adapter passes its own, which also consults `resolveComponent`.
 */
export function createSchemaChecks(
  options: SchemaOptions,
  isKnownComponent: (tag: string) => boolean = (tag) =>
    options.components !== undefined && Object.hasOwn(options.components, tag),
): SchemaChecks {
  return {
    isKnownComponent,
    isKnownVariable: (path) => resolveVariableType(options, path) !== undefined,
    isAllowedElement: (tag) => isElementAllowed(options.elements, tag),
    checkProp: (tag, prop, value) => checkProp(tag, prop, value, options),
  };
}

/** Shared empty result, so the common (valid) case allocates nothing. */
const NO_ERRORS: readonly JsxErrorEvent[] = Object.freeze([]);

/**
 * The errors of a completed opening tag: an unknown component or disallowed
 * element, then one `"invalid-prop"` per rejected prop (in source order).
 * `location` is the tag's `<`.
 */
export function validateOpeningTag(
  tag: string,
  props: Readonly<Record<string, PropValue>>,
  location: SourceLocation,
  checks: SchemaChecks,
): readonly JsxErrorEvent[] {
  let errors: JsxErrorEvent[] | undefined;
  if (isComponentName(tag)) {
    if (!checks.isKnownComponent(tag)) {
      (errors ??= []).push({
        kind: "unknown-component",
        message: `Unknown component <${tag}>`,
        tag,
        location,
      });
    }
  } else if (!checks.isAllowedElement(tag)) {
    (errors ??= []).push({
      kind: "disallowed-element",
      message: `Disallowed element <${tag}>`,
      tag,
      location,
    });
  }
  for (const [prop, value] of Object.entries(props)) {
    const reason = checks.checkProp(tag, prop, value);
    if (reason !== null) {
      (errors ??= []).push({
        kind: "invalid-prop",
        message: `Invalid prop "${prop}" on <${tag}>: ${reason}`,
        tag,
        prop,
        reason,
        location,
      });
    }
  }
  return errors ?? NO_ERRORS;
}

/**
 * The error of a variable reference (`{a.b.c}` → `["a","b","c"]`), or `null`
 * when it is known. `location` is the expression's `{`.
 */
export function validateVariable(
  path: readonly string[],
  location: SourceLocation,
  checks: SchemaChecks,
): JsxErrorEvent | null {
  if (checks.isKnownVariable(path)) return null;
  return {
    kind: "unknown-variable",
    message: `Unknown variable reference {${path.join(".")}}`,
    name: path[0]!,
    path,
    location,
  };
}
