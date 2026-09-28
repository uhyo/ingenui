/**
 * Incremental JSX text normalization: accumulates one run of child text,
 * applying real JSX parser semantics (Babel/TypeScript) character by
 * character, decode-before-normalize:
 *
 *  - HTML character references (`&amp;`, `&#x1F600;`, …) are decoded; invalid
 *    ones stay verbatim. A possible reference is buffered until it resolves.
 *  - JSX whitespace rules: tabs become spaces, indentation and trailing
 *    whitespace around line breaks are dropped, a line break inside text
 *    collapses to a single joining space, and a whitespace-only run that
 *    contains a line break produces no text at all. Whitespace whose fate
 *    depends on what follows is parked until it resolves.
 *
 * Only the text is handled here; the tokenizer decides where a run starts
 * and ends (`<` / `{`).
 */

import { decodeEntity, MAX_ENTITY_LENGTH } from "./entities";

/**
 * Whether `ch` can extend a buffered character reference: `#` right after the
 * `&`, then alphanumerics (which covers the `x` of hex references).
 */
function isEntityBodyChar(ch: string, buf: string): boolean {
  if (ch === "#") return buf === "&";
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9");
}

export class TextRun {
  /** Text so far: entity-decoded and whitespace-normalized. */
  private text = "";
  /**
   * Whitespace seen since the last text character, not yet committed: kept if
   * more text follows on the same line, dropped if a line break follows.
   */
  private ws = "";
  /**
   * A line break has been seen since the last text character: further
   * whitespace is indentation (dropped) and the next text character joins
   * with a single space.
   */
  private newline = false;
  /** A possible character reference being buffered, starting with its `&`. */
  private entityBuf = "";

  /** Append one raw source character. */
  push(ch: string): void {
    if (this.entityBuf !== "") {
      if (ch === ";") {
        const decoded = decodeEntity(this.entityBuf.slice(1));
        this.appendDecoded(decoded ?? this.entityBuf + ";");
        this.entityBuf = "";
        return;
      }
      if (this.entityBuf.length < MAX_ENTITY_LENGTH && isEntityBodyChar(ch, this.entityBuf)) {
        this.entityBuf += ch;
        return;
      }
      // Not a reference after all: keep it verbatim, then handle `ch`.
      this.flushEntityLiteral();
    }
    if (ch === "&") this.entityBuf = "&";
    else this.appendText(ch);
  }

  /**
   * The renderable text so far. A possible entity and unresolved whitespace
   * are withheld until they resolve.
   */
  pending(): string {
    return this.text;
  }

  /**
   * End the run and return its final text (`""` when it produced none). The
   * run is reset for the next one.
   */
  take(): string {
    if (this.entityBuf !== "") this.flushEntityLiteral();
    // Whitespace at the end of the run's last line is kept; anything parked
    // after a line break is dropped.
    const text = this.newline ? this.text : this.text + this.ws;
    this.text = "";
    this.ws = "";
    this.newline = false;
    return text;
  }

  /** Append one already-decoded character, applying the whitespace rules. */
  private appendText(ch: string): void {
    if (ch === "\n" || ch === "\r") {
      // Whitespace before a line break is line-trailing: dropped.
      this.ws = "";
      this.newline = true;
      return;
    }
    if (ch === " " || ch === "\t") {
      if (!this.newline) this.ws += " ";
      return;
    }
    if (this.newline) {
      if (this.text.length > 0) this.text += " ";
      this.newline = false;
    } else {
      this.text += this.ws;
    }
    this.ws = "";
    this.text += ch;
  }

  private appendDecoded(value: string): void {
    for (const ch of value) this.appendText(ch);
  }

  private flushEntityLiteral(): void {
    this.appendDecoded(this.entityBuf);
    this.entityBuf = "";
  }
}
