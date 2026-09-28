import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { resolveVariablePath, UNSUPPORTED_EXPRESSION, type Node } from "./core";
import { parseExpression } from "./expression";
import { createRenderer, type RenderOptions } from "./render";
import type { SourceLocation } from "./position";
import { Tokenizer, type Token } from "./tokenizer";
import { TreeBuilder } from "./tree-builder";

/** Tokenize `input`, stripping source locations for shape-only assertions. */
function tokenize(input: string): unknown[] {
  const tk = new Tokenizer();
  return [...tk.write(input), ...tk.end()].map((token) => {
    const { loc: _loc, ...rest } = token as Token & { loc?: SourceLocation };
    if (rest.type === "attribute" && rest.value.type === "expression") {
      const { loc: _valueLoc, ...value } = rest.value;
      return { ...rest, value };
    }
    return rest;
  });
}

function build(input: string): readonly Node[] {
  const tk = new Tokenizer();
  const tb = new TreeBuilder();
  tb.push(tk.write(input));
  tb.push(tk.end());
  tb.end();
  return tb.snapshot({ type: "none" });
}

function toHtml(input: string, options?: RenderOptions): string {
  const r = createRenderer(options);
  return renderToStaticMarkup(createElement(Fragment, null, r.render(build(input))));
}

function Box({ label }: { label?: ReactNode }): ReactNode {
  return createElement("div", { className: "box" }, label);
}

const noJsx = (): undefined => undefined;
const variableNode = (path: readonly string[]): Node => ({ kind: "variable", id: 0, path });

describe("parseExpression — literals", () => {
  it("parses numbers", () => {
    expect(parseExpression("42", noJsx)).toBe(42);
    expect(parseExpression("3.14", noJsx)).toBe(3.14);
    expect(parseExpression("-1", noJsx)).toBe(-1);
    expect(parseExpression("1e3", noJsx)).toBe(1000);
    expect(parseExpression(".5", noJsx)).toBe(0.5);
  });

  it("parses keyword literals", () => {
    expect(parseExpression("true", noJsx)).toBe(true);
    expect(parseExpression("false", noJsx)).toBe(false);
    expect(parseExpression("null", noJsx)).toBe(null);
    expect(parseExpression("undefined", noJsx)).toBe(undefined);
  });

  it("parses string and template literals (no substitutions)", () => {
    expect(parseExpression(`"hi"`, noJsx)).toBe("hi");
    expect(parseExpression(`'hi'`, noJsx)).toBe("hi");
    expect(parseExpression("`tpl`", noJsx)).toBe("tpl");
    expect(parseExpression("``", noJsx)).toBe("");
  });

  it("decodes escape sequences in string literals", () => {
    expect(parseExpression(String.raw`"a\nb\tc\rd\0"`, noJsx)).toBe("a\nb\tc\rd\0");
    expect(parseExpression(String.raw`'it\'s' `, noJsx)).toBe("it's");
    expect(parseExpression(String.raw`"back\\slash \"q\""`, noJsx)).toBe('back\\slash "q"');
    // Any other escaped character stands for itself.
    expect(parseExpression(String.raw`"\a\{"`, noJsx)).toBe("a{");
  });

  it("rejects a literal with anything after its closing quote", () => {
    expect(parseExpression(`"a"b`, noJsx)).toBe(UNSUPPORTED_EXPRESSION);
    expect(parseExpression(`"unterminated`, noJsx)).toBe(UNSUPPORTED_EXPRESSION);
  });

  it("trims surrounding whitespace", () => {
    expect(parseExpression("  42  ", noJsx)).toBe(42);
    expect(parseExpression("", noJsx)).toBe(undefined);
  });

  it("flags unsupported expressions", () => {
    expect(parseExpression("foo()", noJsx)).toBe(UNSUPPORTED_EXPRESSION);
    expect(parseExpression("a + b", noJsx)).toBe(UNSUPPORTED_EXPRESSION);
    expect(parseExpression("{ a: 1 }", noJsx)).toBe(UNSUPPORTED_EXPRESSION);
    expect(parseExpression("`a${b}c`", noJsx)).toBe(UNSUPPORTED_EXPRESSION);
    expect(parseExpression(`'a' + 'b'`, noJsx)).toBe(UNSUPPORTED_EXPRESSION);
  });

  it("delegates JSX expressions to the parseJsx callback", () => {
    const node: Node = { kind: "text", id: 0, value: "x" };
    const parseJsx = vi.fn(() => node);
    expect(parseExpression("<b>x</b>", parseJsx)).toBe(node);
    expect(parseJsx).toHaveBeenCalledWith("<b>x</b>");
  });
});

describe("parseExpression — variable references", () => {
  it("delegates identifiers and dot paths to the parseVariable callback", () => {
    const parseVariable = vi.fn(variableNode);
    expect(parseExpression("user", noJsx, parseVariable)).toMatchObject({ kind: "variable" });
    expect(parseVariable).toHaveBeenLastCalledWith(["user"]);
    parseExpression("user.name.first", noJsx, parseVariable);
    expect(parseVariable).toHaveBeenLastCalledWith(["user", "name", "first"]);
    parseExpression(" a . b ", noJsx, parseVariable);
    expect(parseVariable).toHaveBeenLastCalledWith(["a", "b"]);
    parseExpression("$_0.x1", noJsx, parseVariable);
    expect(parseVariable).toHaveBeenLastCalledWith(["$_0", "x1"]);
  });

  it("is unsupported without a parseVariable callback", () => {
    expect(parseExpression("user", noJsx)).toBe(UNSUPPORTED_EXPRESSION);
  });

  it("keeps keyword literals ahead of variable parsing", () => {
    const parseVariable = vi.fn(variableNode);
    expect(parseExpression("true", noJsx, parseVariable)).toBe(true);
    expect(parseExpression("null", noJsx, parseVariable)).toBe(null);
    expect(parseVariable).not.toHaveBeenCalled();
  });

  it("rejects anything beyond dot notation", () => {
    const parseVariable = vi.fn(variableNode);
    for (const src of ["a-b", "a.b()", "foo.", ".foo", "a[0]", "1abc", "a?.b", "a. .b"]) {
      expect(parseExpression(src, noJsx, parseVariable)).toBe(UNSUPPORTED_EXPRESSION);
    }
    expect(parseVariable).not.toHaveBeenCalled();
  });

  it("rejects __proto__ / constructor / prototype at any position", () => {
    const parseVariable = vi.fn(variableNode);
    for (const src of [
      "__proto__",
      "constructor",
      "a.__proto__",
      "a.__proto__.b",
      "a.constructor.name",
      "a.prototype",
    ]) {
      expect(parseExpression(src, noJsx, parseVariable)).toBe(UNSUPPORTED_EXPRESSION);
    }
    expect(parseVariable).not.toHaveBeenCalled();
  });
});

describe("Tokenizer — expression containers", () => {
  it("emits a child expr token with raw inner source", () => {
    expect(tokenize("<p>{ 42 }</p>")).toContainEqual({ type: "expr", raw: " 42 " });
  });

  it("emits an attribute expression token", () => {
    expect(tokenize("<a x={1}>")).toContainEqual({
      type: "attribute",
      name: "x",
      value: { type: "expression", raw: "1" },
    });
  });

  it("ignores braces and the closing brace inside string literals", () => {
    expect(tokenize(`<p>{"}"}</p>`)).toContainEqual({ type: "expr", raw: `"}"` });
    expect(tokenize(`<p>{ {a:1} }</p>`)).toContainEqual({ type: "expr", raw: " {a:1} " });
  });

  it("captures nested JSX (with its own braces) as one expression", () => {
    expect(tokenize("<p>{<b>{1}</b>}</p>")).toContainEqual({
      type: "expr",
      raw: "<b>{1}</b>",
    });
  });
});

describe("React adapter — expressions in children", () => {
  it("renders number and string literals", () => {
    expect(toHtml("<p>{42}</p>")).toBe("<p>42</p>");
    expect(toHtml(`<p>{'hi'}</p>`)).toBe("<p>hi</p>");
    expect(toHtml("<p>a{1}b{2}c</p>")).toBe("<p>a1b2c</p>");
  });

  it("renders booleans/null/undefined as nothing", () => {
    expect(toHtml("<p>{true}</p>")).toBe("<p></p>");
    expect(toHtml("<p>{null}</p>")).toBe("<p></p>");
    expect(toHtml("<p>{undefined}</p>")).toBe("<p></p>");
  });

  it("renders nested JSX expressions", () => {
    expect(toHtml("<p>{<b>x</b>}</p>")).toBe("<p><b>x</b></p>");
    expect(toHtml("<p>before {<i>mid</i>} after</p>")).toBe("<p>before <i>mid</i> after</p>");
  });

  it("renders sibling nodes in one nested JSX expression as a fragment", () => {
    expect(toHtml("<p>{<b>a</b><i>b</i>}</p>")).toBe("<p><b>a</b><i>b</i></p>");
  });
});

describe("React adapter — expressions in props", () => {
  it("renders number and boolean prop values", () => {
    expect(toHtml(`<input maxLength={5}/>`)).toBe(`<input maxLength="5"/>`);
    expect(toHtml(`<input disabled={true}/>`)).toBe(`<input disabled=""/>`);
    expect(toHtml(`<input disabled={false}/>`)).toBe(`<input/>`);
  });

  it("renders a nested JSX prop value", () => {
    expect(toHtml(`<Box label={<b>hi</b>}/>`, { components: { Box } })).toBe(
      `<div class="box"><b>hi</b></div>`,
    );
  });
});

describe("resolveVariablePath", () => {
  const variables = {
    user: { profile: { city: "Tokyo" }, none: null },
    title: "abc",
    zero: 0,
    nothing: undefined,
  };

  it("resolves roots and nested members", () => {
    expect(resolveVariablePath(variables, ["title"])).toEqual({ found: true, value: "abc" });
    expect(resolveVariablePath(variables, ["user", "profile", "city"])).toEqual({
      found: true,
      value: "Tokyo",
    });
    expect(resolveVariablePath(variables, ["zero"])).toEqual({ found: true, value: 0 });
  });

  it("finds members through boxed primitives and the prototype chain", () => {
    expect(resolveVariablePath(variables, ["title", "length"])).toEqual({
      found: true,
      value: 3,
    });
  });

  it("treats a path to a nullish value as found — the path itself is valid", () => {
    expect(resolveVariablePath(variables, ["user", "none"])).toEqual({
      found: true,
      value: null,
    });
    expect(resolveVariablePath(variables, ["nothing"])).toEqual({
      found: true,
      value: undefined,
    });
  });

  it("misses unknown roots, missing members, and members of nullish values", () => {
    expect(resolveVariablePath(variables, ["nope"])).toEqual({ found: false });
    expect(resolveVariablePath(variables, ["user", "missing"])).toEqual({ found: false });
    expect(resolveVariablePath(variables, ["user", "none", "deep"])).toEqual({ found: false });
    expect(resolveVariablePath(variables, ["nothing", "deep"])).toEqual({ found: false });
    expect(resolveVariablePath(variables, [])).toEqual({ found: false });
  });

  it("refuses forbidden segments and inherited roots (defense in depth)", () => {
    // The expression parser already rejects these paths; the exported helper
    // must refuse them too when called directly.
    expect(resolveVariablePath(variables, ["user", "__proto__"])).toEqual({ found: false });
    expect(resolveVariablePath(variables, ["user", "constructor"])).toEqual({ found: false });
    expect(resolveVariablePath(variables, ["title", "constructor", "name"])).toEqual({
      found: false,
    });
    expect(resolveVariablePath(variables, ["__proto__"])).toEqual({ found: false });
    // Roots must be own properties — Object.prototype members are not predefined.
    expect(resolveVariablePath(variables, ["toString"])).toEqual({ found: false });
    expect(resolveVariablePath(variables, ["hasOwnProperty"])).toEqual({ found: false });
  });
});

describe("React adapter — variable references", () => {
  const variables = {
    name: "uhyo",
    count: 3,
    user: { profile: { city: "Tokyo" }, none: null },
    home: "/index",
  };

  it("renders a bare identifier from the variables map", () => {
    expect(toHtml("<p>{name}</p>", { variables })).toBe("<p>uhyo</p>");
    expect(toHtml("<p>{count} items</p>", { variables })).toBe("<p>3 items</p>");
  });

  it("renders dot-notation member access", () => {
    expect(toHtml("<p>{user.profile.city}</p>", { variables })).toBe("<p>Tokyo</p>");
  });

  it("renders variable references in props", () => {
    expect(toHtml("<a href={home}>x</a>", { variables })).toBe(`<a href="/index">x</a>`);
    expect(toHtml("<Box label={user.profile.city}/>", { variables, components: { Box } })).toBe(
      `<div class="box">Tokyo</div>`,
    );
  });

  it("renders an unknown root variable as nothing", () => {
    expect(toHtml("<p>{nope}</p>", { variables })).toBe("<p></p>");
    expect(toHtml("<p>{nope.deep}</p>", { variables })).toBe("<p></p>");
    expect(toHtml("<p>{name}</p>")).toBe("<p></p>"); // no variables map at all
  });

  it("resolves a missing or nullish member to nothing (null-safe walk)", () => {
    expect(toHtml("<p>{user.missing}</p>", { variables })).toBe("<p></p>");
    expect(toHtml("<p>{user.none.deep}</p>", { variables })).toBe("<p></p>");
    expect(toHtml("<p>{user.missing.deep}</p>", { variables })).toBe("<p></p>");
  });
});

describe("React adapter — unsupported expressions", () => {
  // The errors themselves are reported at parse time via onJsxError
  // ("unsupported-expression"); rendering just degrades silently.
  it("renders nothing (children)", () => {
    expect(toHtml("<p>{foo()}</p>")).toBe("<p></p>");
  });

  it("drops the prop (attributes)", () => {
    expect(toHtml(`<input value={a + b}/>`)).toBe(`<input/>`);
  });
});
