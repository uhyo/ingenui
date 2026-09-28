import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Node } from "./core";
import { createRenderer } from "./render";
import { Tokenizer } from "./tokenizer";
import { TreeBuilder } from "./tree-builder";

// A homegrown, seeded generator of in-spec JSX (no external fast-check dep).
// The properties under test: the final parsed result must be independent of
// how the input string is split into chunks (PLAN §9.6), and every
// intermediate snapshot keeps a single frontier (PLAN §1).

function makeRng(seed: number): () => number {
  let s = seed % 0x7fffffff;
  if (s <= 0) s += 0x7ffffffe;
  return () => {
    s = (s * 48271) % 0x7fffffff;
    return (s - 1) / 0x7ffffffe;
  };
}

type Rng = () => number;

const NAMES = ["div", "span", "p", "b", "i", "section"];
const ATTR_NAMES = ["id", "title", "data-x"];
const WORD = "abcdefghij";

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function genWord(rng: Rng): string {
  const n = 1 + Math.floor(rng() * 5);
  let s = "";
  for (let i = 0; i < n; i++) s += WORD[Math.floor(rng() * WORD.length)];
  return s;
}

// Entities (valid, unknown, and unterminated) and newline/indent separators
// exercise the tokenizer's resumable entity decoding and JSX whitespace
// normalization across arbitrary chunk boundaries.
const ENTITIES = ["&amp;", "&lt;", "&nbsp;", "&#65;", "&#x1F600;", "&nope;", "&amp"];
const SEPARATORS = [" ", " ", "  ", "\n", "\n  ", " \n\t "];

function genText(rng: Rng): string {
  const parts = 1 + Math.floor(rng() * 3);
  const words: string[] = [];
  for (let i = 0; i < parts; i++) {
    words.push(rng() < 0.2 ? pick(rng, ENTITIES) : genWord(rng));
  }
  return words.join(pick(rng, SEPARATORS));
}

function genAttrs(rng: Rng): string {
  const n = Math.floor(rng() * 3);
  let out = "";
  for (let i = 0; i < n; i++) {
    const name = pick(rng, ATTR_NAMES);
    const r = rng();
    if (r < 0.34) out += ` ${name}="${genWord(rng)}"`;
    else if (r < 0.67) out += ` ${name}={${Math.floor(rng() * 1000)}}`;
    else out += ` ${name}`;
  }
  return out;
}

function genExpression(rng: Rng, depth: number): string {
  const r = rng();
  if (r < 0.4) return `{${Math.floor(rng() * 1000)}}`;
  if (r < 0.7) return `{"${genWord(rng)}"}`;
  if (depth > 0 && r < 0.9) return `{${genElement(rng, depth - 1)}}`;
  return `{${pick(rng, ["true", "false", "null"])}}`;
}

function genChild(rng: Rng, depth: number): string {
  const r = rng();
  if (depth <= 0 || r < 0.4) return genText(rng);
  if (r < 0.75) return genElement(rng, depth - 1);
  return genExpression(rng, depth - 1);
}

function genChildren(rng: Rng, depth: number): string {
  const n = Math.floor(rng() * 4);
  let out = "";
  for (let i = 0; i < n; i++) out += genChild(rng, depth);
  return out;
}

function genElement(rng: Rng, depth: number): string {
  const fragment = rng() < 0.15;
  if (fragment) return `<>${genChildren(rng, depth)}</>`;

  const name = pick(rng, NAMES);
  const attrs = genAttrs(rng);
  if (depth <= 0 || rng() < 0.3) return `<${name}${attrs}/>`;
  return `<${name}${attrs}>${genChildren(rng, depth)}</${name}>`;
}

/**
 * The single-frontier invariant (PLAN §1): exactly one `Pending` node, the
 * last child of the innermost open element (or at the root when nothing is
 * open). Returns a description of the violation, or null.
 */
function frontierViolation(nodes: readonly Node[]): string | null {
  let pendings = 0;
  const count = (list: readonly Node[]): void => {
    for (const node of list) {
      if (node.kind === "pending") pendings++;
      else if (node.kind === "element" || node.kind === "fragment") count(node.children);
    }
  };
  count(nodes);
  if (pendings !== 1) return `expected exactly one Pending, found ${pendings}`;

  // Walk the open path: each level ends in an open container or the Pending.
  let level = nodes;
  for (;;) {
    const last = level.at(-1);
    if (last?.kind === "pending") return null;
    if ((last?.kind === "element" || last?.kind === "fragment") && last.status === "open") {
      level = last.children;
      continue;
    }
    return "Pending is not the last child of the innermost open element";
  }
}

function parse(input: string, chunkSizes: number[]): readonly Node[] {
  const tk = new Tokenizer();
  const tb = new TreeBuilder();
  let offset = 0;
  for (const size of chunkSizes) {
    tb.push(tk.write(input.slice(offset, offset + size)));
    offset += size;
    const violation = frontierViolation(tb.snapshot(tk.getPending()));
    if (violation) throw new Error(`${violation} after ${JSON.stringify(input.slice(0, offset))}`);
  }
  tb.push(tk.write(input.slice(offset)));
  tb.push(tk.end());
  tb.end();
  return tb.snapshot({ type: "none" });
}

function html(nodes: readonly Node[]): string {
  return renderToStaticMarkup(createElement(Fragment, null, createRenderer({}).render(nodes)));
}

function randomSplits(rng: Rng, length: number): number[] {
  const sizes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    const take = 1 + Math.floor(rng() * Math.min(6, remaining));
    sizes.push(take);
    remaining -= take;
  }
  return sizes;
}

describe("Fuzz — chunking invariance (PLAN §9.6) and single frontier (PLAN §1)", () => {
  it("parses identically regardless of chunk boundaries, with one frontier throughout", () => {
    for (let trial = 0; trial < 300; trial++) {
      const rng = makeRng(trial * 2654435761 + 1);
      const input = genChildren(rng, 4) || "<div>fallback</div>";
      const whole = html(parse(input, []));

      // 1-char chunks.
      expect(
        html(
          parse(
            input,
            Array.from({ length: input.length }, () => 1),
          ),
        ),
      ).toBe(whole);

      // Several random splits.
      for (let k = 0; k < 4; k++) {
        expect(html(parse(input, randomSplits(rng, input.length)))).toBe(whole);
      }
    }
  });
});
