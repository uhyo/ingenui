import type { SourceLocation } from "./position";

/**
 * A structured, **recoverable** JSX-level error event (PLAN.md §7), emitted
 * through `onJsxError` **by the `write()` that completes it**, once the chunk is
 * parsed — independent of rendering and of the configured recovery mode — so
 * a stream producer (e.g. an LLM agent) can get instant feedback while the
 * tree still recovers tolerantly. Unrecoverable stream failures are not part
 * of this union; the React adapter reports those through `onStreamError`.
 *
 * Every variant carries a {@link SourceLocation} pointing at the offending
 * construct; {@link formatJsxError} renders `message` + location + the source
 * line with a caret into one report string.
 */
export type JsxErrorEvent =
  | {
      /** A closing tag that does not match the innermost open element. */
      kind: "mismatched-tag";
      /** Human-readable description (safe to feed back to an agent). */
      message: string;
      /** Name of the offending closing tag (`""` for `</>`). */
      tag: string;
      /**
       * Name of the innermost open element it was compared against (`""` for a
       * fragment), or `null` when nothing was open (a stray closing tag).
       */
      expected: string | null;
      /** Where the offending closing tag starts (its `<`). */
      location: SourceLocation;
    }
  | {
      /** A component-like tag (Capitalized / dotted) that failed resolution. */
      kind: "unknown-component";
      message: string;
      tag: string;
      /** Where the unresolved tag starts (its `<`). */
      location: SourceLocation;
    }
  | {
      /** A `{ }` variable reference rejected by the `isKnownVariable` probe. */
      kind: "unknown-variable";
      message: string;
      /** The root identifier of the reference. */
      name: string;
      /** The full dot-notation path (`{a.b.c}` → `["a","b","c"]`). */
      path: readonly string[];
      /** Where the expression starts (its `{`). */
      location: SourceLocation;
    }
  | {
      /** A `{ }` expression outside the supported subset. */
      kind: "unsupported-expression";
      message: string;
      /** Raw source between the braces. */
      expression: string;
      /** Attribute name, when the expression was an attribute value. */
      attribute?: string;
      /** Where the expression starts (its `{`). */
      location: SourceLocation;
    }
  | {
      /** An element still open when the stream ended (auto-closed). */
      kind: "unclosed-tag";
      message: string;
      /** Name of the element left open (`""` for a fragment). */
      tag: string;
      /** Where the unclosed element was opened (its `<`). */
      location: SourceLocation;
    }
  | {
      /** An intrinsic (lowercase) tag rejected by the element allowlist. */
      kind: "disallowed-element";
      message: string;
      tag: string;
      /** Where the rejected tag starts (its `<`). */
      location: SourceLocation;
    }
  | {
      /**
       * A prop rejected by the schema: on an intrinsic element, the per-tag
       * declaration or the built-in host prop rules; on a component, its
       * declared prop catalog. The renderer drops the prop.
       */
      kind: "invalid-prop";
      message: string;
      /** Tag the prop appeared on. */
      tag: string;
      prop: string;
      /** Why it was rejected (as returned by `checkProp`). */
      reason: string;
      /** Where the owning element's opening tag starts (its `<`). */
      location: SourceLocation;
    };

export type JsxErrorListener = (event: JsxErrorEvent) => void;

/** Widest code frame rendered by {@link formatJsxError} before windowing. */
const MAX_FRAME_WIDTH = 80;

/**
 * Render a {@link JsxErrorEvent} as a multi-line report: the `message`, the
 * line/column, and the source line with a caret under the offending column —
 * ready to log or to feed back to the agent producing the stream.
 *
 * ```text
 * Mismatched closing tag </b>; expected </a> (line 2, column 8)
 *
 *   2 |   hello</b>
 *     |        ^
 * ```
 *
 * `lineText` holds the line as far as it had streamed when the error was
 * captured, so the frame may end at the error itself. Long lines are windowed
 * around the caret; leading tabs are preserved so the caret stays aligned.
 */
export function formatJsxError(event: JsxErrorEvent): string {
  const { line, column, lineText } = event.location;
  const header = `${event.message} (line ${line}, column ${column})`;

  let text = lineText;
  // The line may have been truncated before the column.
  let caret = Math.min(Math.max(column, 1), text.length + 1);
  if (text.length > MAX_FRAME_WIDTH) {
    const start = Math.max(
      0,
      Math.min(caret - 1 - Math.floor(MAX_FRAME_WIDTH / 2), text.length - MAX_FRAME_WIDTH),
    );
    const end = start + MAX_FRAME_WIDTH;
    const head = start > 0 ? "…" : "";
    const tail = end < text.length ? "…" : "";
    text = head + text.slice(start, end) + tail;
    caret = caret - start + head.length;
  }
  const padding = text.slice(0, caret - 1).replace(/[^\t]/g, " ");
  const gutter = String(line);
  return `${header}\n\n  ${gutter} | ${text}\n  ${" ".repeat(gutter.length)} | ${padding}^`;
}
