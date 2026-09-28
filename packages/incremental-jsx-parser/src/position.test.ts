import { describe, expect, it } from "vitest";

import type { Mark, SourceLocation } from "./position";
import { PositionTracker } from "./position";

/** Exposes the protected API the tokenizer uses. */
class Tracker extends PositionTracker {
  override advance(ch: string): void {
    super.advance(ch);
  }
  override mark(): Mark {
    return super.mark();
  }
  override location(mark: Mark): SourceLocation {
    return super.location(mark);
  }
  override here(): SourceLocation {
    return super.here();
  }
}

/**
 * The straightforward per-character model the tracker computes lazily: the
 * location of every code point, with its line text as streamed up to and
 * including it.
 */
function referenceLocations(text: string): SourceLocation[] {
  const out: SourceLocation[] = [];
  let line = 1;
  let column = 1;
  let offset = 0;
  let lineText = "";
  for (const ch of text) {
    if (ch !== "\n" && ch !== "\r" && lineText.length < 500) lineText += ch;
    out.push({ line, column, offset, lineText });
    offset += ch.length;
    if (ch === "\n") {
      line++;
      column = 1;
      lineText = "";
    } else {
      column += ch.length;
    }
  }
  return out;
}

/** Ask the tracker for every character's location. */
function trackedLocations(text: string): SourceLocation[] {
  const tracker = new Tracker();
  const out: SourceLocation[] = [];
  for (const ch of text) {
    tracker.advance(ch);
    out.push(tracker.here());
  }
  return out;
}

const SAMPLE = `<a b="c">\r\n  text 😀 {x}\n\n${"y".repeat(498)}😀zz\n\tend`;

describe("PositionTracker", () => {
  it("matches the per-character model", () => {
    expect(trackedLocations(SAMPLE)).toEqual(referenceLocations(SAMPLE));
  });

  it("resolves a mark to its line as streamed through the current character", () => {
    const tracker = new Tracker();
    let mark;
    for (const ch of "x<a b>") {
      tracker.advance(ch);
      if (ch === "<") mark = tracker.mark();
    }
    expect(tracker.location(mark!)).toEqual({ line: 1, column: 2, offset: 1, lineText: "x<a b>" });
  });

  it("keeps a mark's starting line once the construct spans lines", () => {
    const tracker = new Tracker();
    let mark;
    for (const ch of "  {a\n  .b\n}") {
      tracker.advance(ch);
      if (ch === "{") mark = tracker.mark();
    }
    expect(tracker.location(mark!)).toEqual({ line: 1, column: 3, offset: 2, lineText: "  {a" });
  });
});
