import { describe, expect, it } from "vitest";

import type { SourceLocation } from "./position";
import { Tokenizer, type Pending, type Token } from "./tokenizer";

/** Tokenize `input` split into chunks of the given sizes, collecting all tokens. */
function tokenize(input: string, chunkSizes?: number[]): Token[] {
  const tk = new Tokenizer();
  const tokens: Token[] = [];
  if (chunkSizes) {
    let offset = 0;
    for (const size of chunkSizes) {
      tokens.push(...tk.write(input.slice(offset, offset + size)));
      offset += size;
    }
    tokens.push(...tk.write(input.slice(offset)));
  } else {
    tokens.push(...tk.write(input));
  }
  tokens.push(...tk.end());
  return tokens;
}

/** Strip source locations, for shape-only assertions on the token stream. */
function bare(tokens: Token[]): unknown[] {
  return tokens.map((token) => {
    const { loc: _loc, ...rest } = token as Token & { loc?: SourceLocation };
    if (rest.type === "attribute" && rest.value.type === "expression") {
      const { loc: _valueLoc, ...value } = rest.value;
      return { ...rest, value };
    }
    return rest;
  });
}

/** Split `input` into chunks of exactly `size` characters. */
function fixedChunks(input: string, size: number): number[] {
  const sizes: number[] = [];
  for (let i = 0; i < input.length; i += size) sizes.push(size);
  return sizes;
}

describe("Tokenizer — emission", () => {
  it("tokenizes a simple element with text", () => {
    expect(bare(tokenize("<div>Hello</div>"))).toEqual([
      { type: "openTagStart", name: "div" },
      { type: "openTagEnd" },
      { type: "text", value: "Hello" },
      { type: "closeTag", name: "div" },
    ]);
  });

  it("tokenizes nested elements", () => {
    expect(bare(tokenize("<div><span>hi</span></div>"))).toEqual([
      { type: "openTagStart", name: "div" },
      { type: "openTagEnd" },
      { type: "openTagStart", name: "span" },
      { type: "openTagEnd" },
      { type: "text", value: "hi" },
      { type: "closeTag", name: "span" },
      { type: "closeTag", name: "div" },
    ]);
  });

  it("tokenizes self-closing elements", () => {
    expect(bare(tokenize("<br />"))).toEqual([
      { type: "openTagStart", name: "br" },
      { type: "selfClose" },
    ]);
    expect(bare(tokenize("<br/>"))).toEqual([
      { type: "openTagStart", name: "br" },
      { type: "selfClose" },
    ]);
  });

  it("tokenizes fragments", () => {
    expect(bare(tokenize("<>x</>"))).toEqual([
      { type: "openTagStart", name: "" },
      { type: "openTagEnd" },
      { type: "text", value: "x" },
      { type: "closeTag", name: "" },
    ]);
  });

  it("tokenizes string attributes (both quote styles)", () => {
    expect(bare(tokenize(`<a href="x" title='y'>`))).toEqual([
      { type: "openTagStart", name: "a" },
      { type: "attribute", name: "href", value: { type: "string", value: "x" } },
      { type: "attribute", name: "title", value: { type: "string", value: "y" } },
      { type: "openTagEnd" },
    ]);
  });

  it("tokenizes boolean shorthand attributes before `>`, `/>`, and another attribute", () => {
    expect(bare(tokenize(`<input disabled type="text" required>`))).toEqual([
      { type: "openTagStart", name: "input" },
      { type: "attribute", name: "disabled", value: { type: "boolean" } },
      { type: "attribute", name: "type", value: { type: "string", value: "text" } },
      { type: "attribute", name: "required", value: { type: "boolean" } },
      { type: "openTagEnd" },
    ]);
    expect(bare(tokenize(`<hr noshade/>`))).toEqual([
      { type: "openTagStart", name: "hr" },
      { type: "attribute", name: "noshade", value: { type: "boolean" } },
      { type: "selfClose" },
    ]);
  });

  it("allows whitespace around `=` and before a closing tag's `>`", () => {
    expect(bare(tokenize(`<a x = "1" y\n={2}>t</a >`))).toEqual([
      { type: "openTagStart", name: "a" },
      { type: "attribute", name: "x", value: { type: "string", value: "1" } },
      { type: "attribute", name: "y", value: { type: "expression", raw: "2" } },
      { type: "openTagEnd" },
      { type: "text", value: "t" },
      { type: "closeTag", name: "a" },
    ]);
  });

  it("keeps quotes-internal characters verbatim", () => {
    expect(bare(tokenize(`<a t="a<b>{c}">`))).toEqual([
      { type: "openTagStart", name: "a" },
      { type: "attribute", name: "t", value: { type: "string", value: "a<b>{c}" } },
      { type: "openTagEnd" },
    ]);
  });

  it("flushes trailing text on end()", () => {
    expect(bare(tokenize("hello"))).toEqual([{ type: "text", value: "hello" }]);
  });

  it("decodes entities in string attribute values", () => {
    expect(bare(tokenize(`<a title="a &amp; b&#33;" alt='&lt;&nope;&gt;'>`))).toEqual([
      { type: "openTagStart", name: "a" },
      { type: "attribute", name: "title", value: { type: "string", value: "a & b!" } },
      { type: "attribute", name: "alt", value: { type: "string", value: "<&nope;>" } },
      { type: "openTagEnd" },
    ]);
  });

  it("keeps attribute value whitespace raw (only entities are decoded)", () => {
    expect(bare(tokenize(`<a title="  a\n  b  ">`))).toEqual([
      { type: "openTagStart", name: "a" },
      { type: "attribute", name: "title", value: { type: "string", value: "  a\n  b  " } },
      { type: "openTagEnd" },
    ]);
  });

  it("allows capitalized, hyphenated, and dotted names", () => {
    expect(bare(tokenize("<Card><my-el></my-el><Icons.Star/></Card>"))).toEqual([
      { type: "openTagStart", name: "Card" },
      { type: "openTagEnd" },
      { type: "openTagStart", name: "my-el" },
      { type: "openTagEnd" },
      { type: "closeTag", name: "my-el" },
      { type: "openTagStart", name: "Icons.Star" },
      { type: "selfClose" },
      { type: "closeTag", name: "Card" },
    ]);
  });
});

describe("Tokenizer — source locations", () => {
  it("locates tags on a single line (loc points at `<`)", () => {
    expect(tokenize("<div>hi</div>")).toEqual<Token[]>([
      {
        type: "openTagStart",
        name: "div",
        loc: { line: 1, column: 1, offset: 0, lineText: "<div>" },
      },
      { type: "openTagEnd", loc: { line: 1, column: 5, offset: 4, lineText: "<div>" } },
      { type: "text", value: "hi" },
      {
        type: "closeTag",
        name: "div",
        loc: { line: 1, column: 8, offset: 7, lineText: "<div>hi</div>" },
      },
    ]);
  });

  it("tracks lines and columns across newlines", () => {
    // The indentation-only runs between the tags produce no text tokens
    // (JSX whitespace rules), but they still advance lines and columns.
    const tokens = tokenize("<div>\n  <p>x</p>\n</div>");
    expect(tokens).toEqual<Token[]>([
      {
        type: "openTagStart",
        name: "div",
        loc: { line: 1, column: 1, offset: 0, lineText: "<div>" },
      },
      { type: "openTagEnd", loc: { line: 1, column: 5, offset: 4, lineText: "<div>" } },
      {
        type: "openTagStart",
        name: "p",
        loc: { line: 2, column: 3, offset: 8, lineText: "  <p>" },
      },
      { type: "openTagEnd", loc: { line: 2, column: 5, offset: 10, lineText: "  <p>" } },
      { type: "text", value: "x" },
      {
        type: "closeTag",
        name: "p",
        loc: { line: 2, column: 7, offset: 12, lineText: "  <p>x</p>" },
      },
      {
        type: "closeTag",
        name: "div",
        loc: { line: 3, column: 1, offset: 17, lineText: "</div>" },
      },
    ]);
  });

  it("keeps the starting line's text for a tag that spans lines", () => {
    const tokens = tokenize(`<div\nid="x">a</div>`);
    expect(tokens[0]).toEqual<Token>({
      type: "openTagStart",
      name: "div",
      loc: { line: 1, column: 1, offset: 0, lineText: "<div" },
    });
    expect(tokens[4]).toEqual<Token>({
      type: "closeTag",
      name: "div",
      loc: { line: 2, column: 9, offset: 13, lineText: `id="x">a</div>` },
    });
  });

  it("locates a child expression at its `{`", () => {
    expect(tokenize("{42}")).toEqual<Token[]>([
      { type: "expr", raw: "42", loc: { line: 1, column: 1, offset: 0, lineText: "{42}" } },
    ]);
  });

  it("keeps the `{` line for an expression that spans lines", () => {
    const tokens = tokenize("<p>{\n1 +\n2}</p>");
    expect(tokens[2]).toEqual<Token>({
      type: "expr",
      raw: "\n1 +\n2",
      loc: { line: 1, column: 4, offset: 3, lineText: "<p>{" },
    });
    expect(tokens[3]).toEqual<Token>({
      type: "closeTag",
      name: "p",
      loc: { line: 3, column: 3, offset: 11, lineText: "2}</p>" },
    });
  });

  it("locates an attribute expression value at its `{`", () => {
    expect(tokenize("<a x={1}/>")[1]).toEqual<Token>({
      type: "attribute",
      name: "x",
      value: {
        type: "expression",
        raw: "1",
        loc: { line: 1, column: 6, offset: 5, lineText: "<a x={1}" },
      },
    });
  });

  it("counts columns and offsets in UTF-16 code units", () => {
    // 😀 is one code point but two UTF-16 units.
    expect(tokenize("😀<b/>")[1]).toEqual<Token>({
      type: "openTagStart",
      name: "b",
      loc: { line: 1, column: 3, offset: 2, lineText: "😀<b/" },
    });
  });
});

/** Concatenated text-token values for `input` (normally a single token). */
function textOf(input: string): string {
  return tokenize(input)
    .filter((token) => token.type === "text")
    .map((token) => token.value)
    .join("");
}

describe("Tokenizer — JSX whitespace rules", () => {
  it("strips indentation and joins lines with a single space", () => {
    expect(textOf("<p>hello\n  world</p>")).toBe("hello world");
    expect(textOf("<p>\n  hello\n  world\n</p>")).toBe("hello world");
  });

  it("collapses blank lines into the single joining space", () => {
    expect(textOf("<p>a\n\n\n   b</p>")).toBe("a b");
  });

  it("drops whitespace at the end of a non-final line", () => {
    expect(textOf("<p>a  \t \n  b</p>")).toBe("a b");
  });

  it("keeps whitespace on a single line (start, middle, and end)", () => {
    expect(textOf("<p>  a  b  </p>")).toBe("  a  b  ");
    expect(textOf("<p> </p>")).toBe(" ");
    expect(textOf("<p>a <b>c</b></p>")).toBe("a c");
  });

  it("converts tabs to spaces", () => {
    expect(textOf("<p>a\tb</p>")).toBe("a b");
    expect(textOf("<p>a\t\tb</p>")).toBe("a  b");
  });

  it("treats CRLF and lone CR as line breaks", () => {
    expect(textOf("<p>a\r\n  b</p>")).toBe("a b");
    expect(textOf("<p>a\r  b</p>")).toBe("a b");
  });

  it("drops a trailing line break at end of input", () => {
    expect(textOf("a\n")).toBe("a");
    expect(textOf("a  ")).toBe("a  ");
  });

  it("keeps non-breaking spaces (they are not JSX whitespace)", () => {
    expect(textOf("<p>\n  &nbsp;\n</p>")).toBe(" ");
  });
});

describe("Tokenizer — entity decoding in text", () => {
  it("decodes named entities", () => {
    expect(textOf("<p>a &amp; b</p>")).toBe("a & b");
    expect(textOf("<p>&lt;div&gt;</p>")).toBe("<div>");
    expect(textOf("<p>&copy;&nbsp;&hellip;</p>")).toBe("© …");
  });

  it("decodes numeric entities (decimal and lowercase-x hex, like Babel)", () => {
    expect(textOf("<p>&#65;&#x41;&#X61;</p>")).toBe("AA&#X61;");
    expect(textOf("<p>&#x1F600;</p>")).toBe("😀");
  });

  it("a decoded `<` or `{` is text, not markup", () => {
    expect(bare(tokenize("<p>&lt;b&gt;&#123;x&#125;</p>"))).toEqual([
      { type: "openTagStart", name: "p" },
      { type: "openTagEnd" },
      { type: "text", value: "<b>{x}" },
      { type: "closeTag", name: "p" },
    ]);
  });

  it("keeps invalid or unknown references verbatim", () => {
    expect(textOf("<p>&nope; &#; &#xZZ; &#xD800;</p>")).toBe("&nope; &#; &#xZZ; &#xD800;");
    expect(textOf("<p>a & b &lt c</p>")).toBe("a & b &lt c");
    expect(textOf("<p>fish &amp chips</p>")).toBe("fish &amp chips");
  });

  it("flushes an unterminated reference verbatim at a tag or at end of input", () => {
    expect(textOf("a &amp")).toBe("a &amp");
    expect(bare(tokenize("<p>a &am</p>"))).toContainEqual({ type: "text", value: "a &am" });
  });

  it("decoded whitespace goes through the whitespace rules", () => {
    // `&#32;`/`&#10;`/`&#9;` decode to space / newline / tab, which then
    // normalize exactly like literal characters (matching Babel's order:
    // entity decoding happens before whitespace cleaning).
    expect(textOf("<p>a&#10;  b</p>")).toBe("a b");
    expect(textOf("<p>a&#9;b</p>")).toBe("a b");
    expect(textOf("<p>a&#32;&#32;b</p>")).toBe("a  b");
  });
});

function pendingAfter(input: string): Pending {
  const tk = new Tokenizer();
  tk.write(input);
  return tk.getPending();
}

describe("Tokenizer — getPending (frontier)", () => {
  it("reports no pending in an idle/complete state", () => {
    expect(pendingAfter("<div>")).toEqual<Pending>({ type: "none" });
  });

  it("reports partial text", () => {
    expect(pendingAfter("<div>Hello")).toEqual<Pending>({ type: "text", value: "Hello" });
  });

  it("reports no pending mid-tag (partial open tag is hidden)", () => {
    expect(pendingAfter("<div><sp")).toEqual<Pending>({ type: "none" });
  });

  it("reports no pending mid-attribute", () => {
    expect(pendingAfter(`<div title="bo`)).toEqual<Pending>({ type: "none" });
  });

  it("withholds a possibly-incomplete entity from the pending text", () => {
    expect(pendingAfter("<p>hi &am")).toEqual<Pending>({ type: "text", value: "hi" });
    expect(pendingAfter("<p>hi &amp;")).toEqual<Pending>({ type: "text", value: "hi &" });
  });

  it("withholds unresolved whitespace from the pending text", () => {
    // Whether the parked whitespace survives depends on what follows.
    expect(pendingAfter("<p>a\n  ")).toEqual<Pending>({ type: "text", value: "a" });
    expect(pendingAfter("<p>a\n  b")).toEqual<Pending>({ type: "text", value: "a b" });
    expect(pendingAfter("<p>\n  ")).toEqual<Pending>({ type: "none" });
  });
});

describe("Tokenizer — chunking invariance (PLAN §5)", () => {
  // Locations are part of every compared token, so this suite also checks that
  // line/column/lineText do not depend on chunk boundaries. Arbitrary
  // (non-uniform) splits of generated input are covered by fuzz.test.ts.
  const inputs = [
    "<div>Hello</div>",
    "<div><span>hi</span> world</div>",
    `<a href="x" title='y' disabled>text</a>`,
    "<><b>bold</b> and <i>italic</i></>",
    "<br /><hr/><img />",
    "plain text only",
    "<Card><Button label='ok' primary /></Card>",
    `<a x = "1" y\n={2}>t</a >`,
    "  <div>  spaced  </div>  ",
    `<a t="a<b>{c}">deep</a>`,
    "<div>\n  <p a={1}>x</p>\n  {42}\n</div>",
    `<div title={"a}b"}>x{42}y{<b k='}'>z</b>}</div>`,
    "<ul>\n<li>one\n<li>two\n</ul>",
    "<p>hello\n  world &amp; more</p>",
    "<div>\n\t<p>&lt;tag&gt; &#x1F600;</p>\n\t \n</div>",
    "<p>broken &amp and &nope; &#xG; &#</p>",
    `<a title="a &amp; b">x &amp</a>`,
    // Size-1 chunks split the surrogate pair of 😀.
    "<p>café 😀 漢字</p>",
  ];

  for (const input of inputs) {
    it(`is invariant for: ${JSON.stringify(input)}`, () => {
      const whole = tokenize(input);
      // Every fixed chunk size, including 1-char chunks.
      for (let size = 1; size <= input.length; size++) {
        expect(tokenize(input, fixedChunks(input, size))).toEqual(whole);
      }
    });
  }
});
