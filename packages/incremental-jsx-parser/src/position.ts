/**
 * Source-position bookkeeping for the tokenizer: line/column/offset tracking
 * and per-line context for error frames, kept apart from the lexing state
 * machine. Dependency-free.
 *
 * The tokenizer makes one small {@link PositionTracker.advance} call per
 * character; everything else happens only where a token records a location.
 * It *extends* the tracker rather than holding one: the fields then live on
 * the tokenizer object itself, which keeps the per-character path as fast as
 * inline code (a separate object measurably slowed large chunks down).
 */

/**
 * A location in the streamed source, attached to the tokens (and, through
 * them, the `JsxErrorEvent`s) that can anchor an error message.
 *
 * `column` and `offset` count UTF-16 code units, matching JavaScript string
 * indexing. `lineText` is the content of the source line as far as it had
 * streamed when the construct completed — for a single-line construct that is
 * the whole line up to and including it; the tail of the line may not have
 * arrived yet. Very long lines are truncated at {@link MAX_LINE_TEXT}.
 */
export interface SourceLocation {
  /** 1-based line number. */
  line: number;
  /** 1-based column (UTF-16 code units). */
  column: number;
  /** 0-based offset from the start of the stream (UTF-16 code units). */
  offset: number;
  /** Content of the line, as streamed so far when captured (no newline). */
  lineText: string;
}

/** Cap on retained per-line context, so a pathological single line stays bounded. */
const MAX_LINE_TEXT = 500;

/**
 * The recorded start of a construct (`<` of a tag, `{` of an expression).
 * Resolve it with {@link PositionTracker.location} once the construct
 * completes: a construct spanning lines still reports its *starting* line.
 */
export interface Mark {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  /** Snapshotted by the tracker when the mark's line ends; `null` until then. */
  lineText: string | null;
}

/**
 * Tracks the position of the character being processed: a base class for the
 * tokenizer (see the module doc). Call {@link advance} with each character
 * before processing it. The state is private, so a subclass only sees the
 * protected API.
 */
export class PositionTracker {
  // The position of the current character.
  private line = 1;
  private column = 1;
  private offset = 0;
  /** Content of the current line through the current character (capped). */
  private lineText = "";
  /** UTF-16 length of the current character (0 before the first one). */
  private currentLength = 0;
  /** The current character is a line break: the next one starts a new line. */
  private atLineBreak = false;
  /**
   * Marks on the current line, awaiting its final text: the first
   * `lineMarkCount` entries (the array is reused across lines).
   */
  private readonly lineMarks: Mark[] = [];
  private lineMarkCount = 0;

  /**
   * Make `ch` the current character. It joins the line text right away, so a
   * token emitted on a delimiter (`>`, `}`) captures a `lineText` that
   * contains the whole construct. A line break's effect is deferred to the
   * next character, so the break itself still belongs to its line.
   */
  protected advance(ch: string): void {
    this.offset += this.currentLength;
    if (this.atLineBreak) {
      this.endLine();
    } else {
      this.column += this.currentLength;
    }
    this.currentLength = ch.length;
    if (ch === "\n") {
      this.atLineBreak = true;
    } else if (ch !== "\r" && this.lineText.length < MAX_LINE_TEXT) {
      this.lineText += ch;
    }
  }

  /** Mark the position of the current character. */
  protected mark(): Mark {
    const mark: Mark = {
      line: this.line,
      column: this.column,
      offset: this.offset,
      lineText: null,
    };
    this.lineMarks[this.lineMarkCount++] = mark;
    return mark;
  }

  /**
   * The location of `mark`: its line text runs through the current character
   * while the mark's line is still streaming.
   */
  protected location(mark: Mark): SourceLocation {
    const { line, column, offset } = mark;
    return { line, column, offset, lineText: mark.lineText ?? this.lineText };
  }

  /** The location of the current character. */
  protected here(): SourceLocation {
    return { line: this.line, column: this.column, offset: this.offset, lineText: this.lineText };
  }

  private endLine(): void {
    // Snapshot the finished line into the marks waiting for it.
    for (let i = 0; i < this.lineMarkCount; i++) this.lineMarks[i]!.lineText = this.lineText;
    this.lineMarkCount = 0;
    this.lineText = "";
    this.line++;
    this.column = 1;
    this.atLineBreak = false;
  }
}
