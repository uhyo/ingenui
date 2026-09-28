/**
 * Incremental, resumable JSX tokenizer (PLAN.md §4.2).
 *
 * A character-level state machine that retains partial state across chunk
 * boundaries: it can be cut off mid-tag, mid-attribute, or mid-text and resume
 * cleanly when more characters arrive. The key correctness property
 * (PLAN.md §5) is that the emitted token stream does not depend on how the
 * input is split into chunks.
 *
 * Two concerns live in their own modules so this one is only the lexing state
 * machine: child text is normalized to real JSX semantics (entities,
 * whitespace) by a {@link TextRun}, and source positions are tracked by the
 * {@link PositionTracker} base class.
 *
 * {@link Tokenizer.getPending} describes the half-read construct at the
 * cursor. Only partial *text* is renderable; a partial tag/attribute
 * contributes nothing visible until it completes, which is what the frontier
 * model in PLAN.md §1 relies on. A possible entity (`&am…`) and whitespace
 * whose fate depends on what follows are likewise withheld from the pending
 * text until they resolve.
 */

import { decodeEntities } from "./entities";
import { PositionTracker } from "./position";
import type { Mark, SourceLocation } from "./position";
import { TextRun } from "./text-run";

export type AttrValue =
  | { type: "string"; value: string }
  /** Boolean shorthand: `disabled` desugars to `disabled={true}`. */
  | { type: "boolean" }
  /** `attr={...}`; `raw` is the inner source, `loc` the `{`. */
  | { type: "expression"; raw: string; loc: SourceLocation };

export type Token =
  /** `name` is `""` for a fragment (`<>`). `loc` is the `<`. */
  | { type: "openTagStart"; name: string; loc: SourceLocation }
  | { type: "attribute"; name: string; value: AttrValue }
  /** `>` terminating an opening tag. `loc` is the `>`. */
  | { type: "openTagEnd"; loc: SourceLocation }
  /** `/>` terminating a self-closing element. `loc` is the `>`. */
  | { type: "selfClose"; loc: SourceLocation }
  /** `name` is `""` for a fragment close (`</>`). `loc` is the `<`. */
  | { type: "closeTag"; name: string; loc: SourceLocation }
  | { type: "text"; value: string }
  /** A child expression container; `raw` is the inner source, `loc` the `{`. */
  | { type: "expr"; raw: string; loc: SourceLocation };

/** The half-read construct at the cursor; see PLAN.md §1. */
export type Pending =
  /** Nothing renderable is pending (idle, or mid-tag/-attribute). */
  | { type: "none" }
  /** A run of child text accumulated so far but not yet terminated. */
  | { type: "text"; value: string };

const enum State {
  Text,
  TagOpen,
  TagName,
  BeforeAttrName,
  AttrName,
  AfterAttrName,
  BeforeAttrValue,
  AttrValueString,
  SelfClose,
  CloseTagName,
  CloseTagEnd,
  Expression,
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

function isNameStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isNameChar(ch: string): boolean {
  return isNameStart(ch) || (ch >= "0" && ch <= "9") || ch === "-" || ch === ".";
}

/**
 * A resumable JSX tokenizer. Feed chunks with {@link write}, signal the end of
 * the stream with {@link end}, and read the current frontier with
 * {@link getPending}.
 */
export class Tokenizer extends PositionTracker {
  private state: State = State.Text;
  /** The child text run being accumulated (in {@link State.Text}). */
  private readonly text = new TextRun();
  /** Tag name (open or close). */
  private name = "";
  private attrName = "";
  private attrValue = "";
  private quote = "";
  /** Re-process the current character in the new state. */
  private reconsume = false;

  private tagMark: Mark | null = null;
  private exprMark: Mark | null = null;

  // Expression container (`{ ... }`) scanning state.
  /** Raw source between the outer braces. */
  private exprRaw = "";
  /** Brace nesting depth; 0 means the matching `}` has been found. */
  private exprDepth = 0;
  /** The quote currently open inside the expression (empty if none). */
  private exprQuote = "";
  private exprEscape = false;
  /** The expression is the value of {@link attrName} (vs a child). */
  private exprIsAttr = false;

  /** Feed a string chunk; returns the tokens completed by this chunk. */
  write(chunk: string): Token[] {
    const out: Token[] = [];
    for (const ch of chunk) {
      this.advance(ch);
      do {
        this.reconsume = false;
        this.step(ch, out);
      } while (this.reconsume);
    }
    return out;
  }

  /**
   * Signal end of input. Flushes any trailing text run; an incomplete tag or
   * attribute is discarded (it never became renderable).
   */
  end(): Token[] {
    const out: Token[] = [];
    if (this.state === State.Text) this.flushText(out);
    return out;
  }

  /** The half-read construct at the cursor (PLAN.md §1). */
  getPending(): Pending {
    if (this.state === State.Text) {
      const value = this.text.pending();
      if (value.length > 0) return { type: "text", value };
    }
    return { type: "none" };
  }

  private takeTagLoc(): SourceLocation {
    const loc = this.location(this.tagMark!);
    this.tagMark = null;
    return loc;
  }

  private emitAttribute(out: Token[], value: AttrValue): void {
    out.push({ type: "attribute", name: this.attrName, value });
    this.attrName = "";
  }

  private emitCloseTag(out: Token[]): void {
    out.push({ type: "closeTag", name: this.name, loc: this.takeTagLoc() });
    this.name = "";
    this.state = State.Text;
  }

  private step(ch: string, out: Token[]): void {
    switch (this.state) {
      case State.Text: {
        if (ch === "<") {
          this.flushText(out);
          this.tagMark = this.mark();
          this.state = State.TagOpen;
        } else if (ch === "{") {
          this.flushText(out);
          this.startExpression(false);
        } else {
          this.text.push(ch);
        }
        return;
      }

      case State.TagOpen: {
        if (ch === "/") {
          this.name = "";
          this.state = State.CloseTagName;
        } else if (ch === ">") {
          out.push({ type: "openTagStart", name: "", loc: this.takeTagLoc() });
          out.push({ type: "openTagEnd", loc: this.here() });
          this.state = State.Text;
        } else if (isNameStart(ch)) {
          this.name = ch;
          this.state = State.TagName;
        }
        // Anything else is leniently ignored (here and in the states below).
        return;
      }

      case State.TagName: {
        if (isNameChar(ch)) {
          this.name += ch;
        } else {
          out.push({ type: "openTagStart", name: this.name, loc: this.takeTagLoc() });
          this.name = "";
          this.state = State.BeforeAttrName;
          this.reconsume = true;
        }
        return;
      }

      case State.BeforeAttrName: {
        if (ch === ">") {
          out.push({ type: "openTagEnd", loc: this.here() });
          this.state = State.Text;
        } else if (ch === "/") {
          this.state = State.SelfClose;
        } else if (isNameStart(ch)) {
          this.attrName = ch;
          this.state = State.AttrName;
        }
        return;
      }

      case State.AttrName: {
        if (isNameChar(ch)) {
          this.attrName += ch;
        } else if (ch === "=") {
          this.state = State.BeforeAttrValue;
        } else if (isWhitespace(ch)) {
          this.state = State.AfterAttrName;
        } else {
          this.emitAttribute(out, { type: "boolean" });
          this.state = State.BeforeAttrName;
          this.reconsume = true;
        }
        return;
      }

      case State.AfterAttrName: {
        if (ch === "=") {
          this.state = State.BeforeAttrValue;
        } else if (!isWhitespace(ch)) {
          // A new attribute, `>` or `/`: the previous bare name was boolean.
          this.emitAttribute(out, { type: "boolean" });
          this.state = State.BeforeAttrName;
          this.reconsume = true;
        }
        return;
      }

      case State.BeforeAttrValue: {
        if (ch === '"' || ch === "'") {
          this.quote = ch;
          this.attrValue = "";
          this.state = State.AttrValueString;
        } else if (ch === "{") {
          this.startExpression(true);
        }
        // Unquoted values are out of scope.
        return;
      }

      case State.AttrValueString: {
        if (ch === this.quote) {
          this.emitAttribute(out, { type: "string", value: decodeEntities(this.attrValue) });
          this.state = State.BeforeAttrName;
        } else {
          this.attrValue += ch;
        }
        return;
      }

      case State.SelfClose: {
        if (ch === ">") {
          out.push({ type: "selfClose", loc: this.here() });
          this.state = State.Text;
        }
        return;
      }

      case State.CloseTagName: {
        if (isNameChar(ch)) {
          this.name += ch;
        } else if (ch === ">") {
          this.emitCloseTag(out);
        } else if (isWhitespace(ch)) {
          this.state = State.CloseTagEnd;
        }
        return;
      }

      case State.CloseTagEnd: {
        if (ch === ">") this.emitCloseTag(out);
        return;
      }

      case State.Expression: {
        // Inside a string/template literal, braces and other quotes do not
        // affect nesting.
        if (this.exprQuote) {
          if (this.exprEscape) this.exprEscape = false;
          else if (ch === "\\") this.exprEscape = true;
          else if (ch === this.exprQuote) this.exprQuote = "";
        } else if (ch === '"' || ch === "'" || ch === "`") {
          this.exprQuote = ch;
        } else if (ch === "{") {
          this.exprDepth++;
        } else if (ch === "}" && --this.exprDepth === 0) {
          this.finishExpression(out);
          return;
        }
        this.exprRaw += ch;
        return;
      }
    }
  }

  private flushText(out: Token[]): void {
    const value = this.text.take();
    if (value.length > 0) out.push({ type: "text", value });
  }

  private startExpression(isAttr: boolean): void {
    this.exprMark = this.mark();
    this.exprRaw = "";
    this.exprDepth = 1;
    this.exprQuote = "";
    this.exprEscape = false;
    this.exprIsAttr = isAttr;
    this.state = State.Expression;
  }

  private finishExpression(out: Token[]): void {
    const loc = this.location(this.exprMark!);
    this.exprMark = null;
    if (this.exprIsAttr) {
      this.emitAttribute(out, { type: "expression", raw: this.exprRaw, loc });
      this.state = State.BeforeAttrName;
    } else {
      out.push({ type: "expr", raw: this.exprRaw, loc });
      this.state = State.Text;
    }
    this.exprRaw = "";
  }
}
