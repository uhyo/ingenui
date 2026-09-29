/**
 * Incremental Markdown / `ui+jsx` fence splitter.
 *
 * Splits a streamed Markdown document into alternating **markdown** and
 * **ui** regions, where a ui region is the contents of a fenced code block
 * whose info string is exactly `ui+jsx`:
 *
 * ~~~
 * Some *markdown* text.
 *
 * ```ui+jsx
 * <Card title="hi" />
 * ```
 *
 * More markdown.
 * ~~~
 *
 * Design goals, mirroring the JSX parser it feeds:
 *
 * - **Chunking-invariant commits.** Region boundaries and the committed text
 *   of each region depend only on complete lines (plus end-of-stream), never
 *   on how the stream is chunked. A partial line is exposed separately as a
 *   *tentative tail* (`markdownTail`) so it can be rendered eagerly and
 *   replaced when the line completes.
 * - **Eager UI streaming.** Inside a ui block, a partial line is pushed to
 *   the JSX sink character-by-character as soon as it can no longer be the
 *   closing fence, so the JSX parser's frontier advances within a line.
 * - **Fence-aware.** A regular fenced code block in the markdown (```js …)
 *   is tracked so a `ui+jsx` opener *inside* it (e.g. documentation showing
 *   the syntax) is not mistaken for a real UI block.
 *
 * Only backtick fences are recognized (CommonMark also allows `~~~`; that is
 * out of the v1 subset). A closing fence must be at least as long as its
 * opener, per CommonMark.
 */

import { FENCE_OPEN, isFenceClose } from "./fence";

export interface FenceSplitterHandlers {
  /** Committed markdown text — append-only within the current markdown region. */
  markdown(text: string): void;
  /**
   * The current markdown region's tentative tail (a partial line that may
   * still change — or turn out to be a `ui+jsx` fence opener, in which case
   * it never becomes markdown). Replaces the previously reported tail.
   */
  markdownTail(tail: string): void;
  /**
   * A `ui+jsx` fence opened; a new UI block begins (and a markdown region
   * ended). `offset` is where the opening fence line starts in the text
   * written so far.
   */
  openUi(offset: number): void;
  /** JSX source text for the currently open UI block. */
  ui(text: string): void;
  /**
   * The current UI block ended. `terminated` is false when the stream ended
   * before the closing fence was seen.
   */
  closeUi(terminated: boolean): void;
}

export interface FenceSplitter {
  write(chunk: string): void;
  /** Finish the stream: the pending partial line is processed as a final line. */
  end(): void;
  /**
   * The text that, written next, closes the currently open fence (a `ui+jsx`
   * block or a regular code fence), ending the current line first when it is
   * partial — so whatever follows starts on a fresh line of plain Markdown.
   * `""` outside a fence.
   */
  fenceClose(): string;
}

const UI_INFO = "ui+jsx";
/** Opening fence for a UI block: up to 3 spaces, 3+ backticks, `ui+jsx`. */
const UI_OPEN = /^ {0,3}(`{3,})[ \t]*ui\+jsx[ \t]*$/;

/**
 * Could the partial `line` still grow into a fence line — up to 3 spaces, a
 * run of at least `minSize` backticks, blanks, then a remainder accepted by
 * `isRestPrefix`?
 */
function isFencePrefix(
  line: string,
  minSize: number,
  isRestPrefix: (rest: string) => boolean,
): boolean {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  if (i > 3) return false;
  const backtickStart = i;
  while (i < line.length && line[i] === "`") i++;
  // Spaces and backticks only so far: the run may still grow.
  if (i === line.length) return true;
  if (i - backtickStart < minSize) return false;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  return isRestPrefix(line.slice(i));
}

function isUiOpenPrefix(line: string): boolean {
  return isFencePrefix(
    line,
    3,
    (rest) =>
      UI_INFO.startsWith(rest) ||
      (rest.startsWith(UI_INFO) && /^[ \t]*$/.test(rest.slice(UI_INFO.length))),
  );
}

function isFenceClosePrefix(line: string, size: number): boolean {
  return isFencePrefix(line, size, (rest) => rest === "");
}

type Mode =
  | { kind: "markdown" }
  /** Inside a regular fenced code block within the markdown. */
  | { kind: "markdown-fence"; size: number }
  | { kind: "ui"; size: number };

export function createFenceSplitter(handlers: FenceSplitterHandlers): FenceSplitter {
  let mode: Mode = { kind: "markdown" };
  /** The current line, as far as it has arrived (never contains `\n`). */
  let line = "";
  /** (ui mode) Whether `line` has already been flushed to the `ui` sink. */
  let lineFlushed = false;
  let lastTail = "";
  let ended = false;
  /** Length of the text written before the chunk remainder being processed. */
  let consumed = 0;
  /** Offset where the current line starts. */
  let lineStart = 0;

  const setTail = (tail: string): void => {
    if (tail !== lastTail) {
      lastTail = tail;
      handlers.markdownTail(tail);
    }
  };

  /** Append partial-line text (no `\n` inside). */
  const appendPartial = (text: string): void => {
    if (text === "") return;
    if (mode.kind === "ui") {
      if (lineFlushed) {
        handlers.ui(text);
        return;
      }
      line += text;
      if (!isFenceClosePrefix(line, mode.size)) {
        handlers.ui(line);
        lineFlushed = true;
        line = "";
      }
      return;
    }
    line += text;
  };

  /**
   * The current line is complete. `eof` marks the final, unterminated line at
   * end of stream (committed without a trailing newline).
   */
  const completeLine = (eof: boolean): void => {
    const full = line;
    const flushed = lineFlushed;
    line = "";
    lineFlushed = false;
    const nl = eof ? "" : "\n";

    if (mode.kind === "ui") {
      // A line flushed early can no longer be a closing fence.
      if (!flushed && isFenceClose(full, mode.size)) {
        mode = { kind: "markdown" };
        handlers.closeUi(true);
        return;
      }
      handlers.ui(flushed ? nl : full + nl);
      return;
    }

    if (mode.kind === "markdown-fence") {
      if (isFenceClose(full, mode.size)) mode = { kind: "markdown" };
      handlers.markdown(full + nl);
      return;
    }

    const uiOpen = UI_OPEN.exec(full);
    if (uiOpen) {
      mode = { kind: "ui", size: uiOpen[1]!.length };
      setTail("");
      handlers.openUi(lineStart);
      return;
    }
    const fenceOpen = FENCE_OPEN.exec(full);
    if (fenceOpen) mode = { kind: "markdown-fence", size: fenceOpen[1]!.length };
    handlers.markdown(full + nl);
  };

  return {
    write(chunk) {
      if (ended) return;
      let rest = chunk;
      for (;;) {
        const nl = rest.indexOf("\n");
        if (nl === -1) {
          appendPartial(rest);
          consumed += rest.length;
          break;
        }
        appendPartial(rest.slice(0, nl));
        completeLine(false);
        consumed += nl + 1;
        lineStart = consumed;
        rest = rest.slice(nl + 1);
      }
      setTail(mode.kind === "ui" || (mode.kind === "markdown" && isUiOpenPrefix(line)) ? "" : line);
    },
    end() {
      if (ended) return;
      ended = true;
      if (line !== "" || lineFlushed) completeLine(true);
      setTail("");
      if (mode.kind === "ui") {
        mode = { kind: "markdown" };
        handlers.closeUi(false);
      }
    },
    fenceClose() {
      if (ended || mode.kind === "markdown") return "";
      const fence = `${"`".repeat(mode.size)}\n`;
      if (line === "" && !lineFlushed) return fence;
      // A partial line that already is a closing fence only needs its newline.
      if (!lineFlushed && isFenceClose(line, mode.size)) return "\n";
      return `\n${fence}`;
    },
  };
}
