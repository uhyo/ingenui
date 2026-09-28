import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  createParser,
  formatJsxError,
  type JsxErrorEvent,
  type ParserOptions,
  type SchemaChecks,
} from "./core";
import { createIncrementalJsxParser } from "./index";
import { createRenderer } from "./render";
import { Tokenizer } from "./tokenizer";
import { TreeBuilder, type MismatchBehavior } from "./tree-builder";

function html(
  input: string,
  opts: {
    mismatchedTag?: MismatchBehavior;
    end?: boolean;
  } = {},
): string {
  const tk = new Tokenizer();
  const tb = new TreeBuilder({ mismatchedTag: opts.mismatchedTag });
  tb.push(tk.write(input));
  if (opts.end ?? true) {
    tb.push(tk.end());
    tb.end();
  }
  const r = createRenderer({});
  return renderToStaticMarkup(
    createElement(Fragment, null, r.render(tb.snapshot(tk.getPending()))),
  );
}

describe("Error handling — missing close tags", () => {
  it("auto-closes still-open elements at end of stream", () => {
    expect(html("<div><span>hi")).toBe("<div><span>hi</span></div>");
    // This is JSX, not HTML: unclosed siblings nest, then all auto-close at EOF.
    expect(html("<ul><li>a<li>b")).toBe("<ul><li>a<li>b</li></li></ul>");
  });
});

describe("Error handling — mismatched closing tags", () => {
  it("autoclose (default): a non-matching close ends the innermost element", () => {
    expect(html("<a>x</b>")).toBe("<a>x</a>");
  });

  it("autoclose: a matching ancestor closes intermediate elements", () => {
    expect(html("<a><b>x</a>")).toBe("<a><b>x</b></a>");
  });

  it("ignore: non-matching close tags are dropped", () => {
    expect(html("<a>x</b>y", { mismatchedTag: "ignore" })).toBe("<a>xy</a>");
  });

  it("ignores a stray closing tag with nothing open", () => {
    expect(html("</div>foo")).toBe("foo");
  });
});

describe("Error handling — truncated input", () => {
  it("drops a partial child tag", () => {
    expect(html("<div><spa")).toBe("<div></div>");
  });

  it("drops an element whose opening tag never finished", () => {
    expect(html(`<a href="ab`)).toBe("");
  });

  it("drops a truncated expression", () => {
    expect(html("<p>{42")).toBe("<p></p>");
    expect(html("<p>{<b>unfinished")).toBe("<p></p>");
  });
});

type TestOptions = Omit<ParserOptions, "onJsxError" | "checks"> & Partial<SchemaChecks>;

/** Parser options with the given schema checks; the rest accept everything. */
function parserOptions(
  { mismatchedTag, ...checks }: TestOptions,
  onJsxError: (event: JsxErrorEvent) => void,
): ParserOptions {
  return {
    mismatchedTag,
    onJsxError,
    checks: {
      isKnownComponent: () => true,
      isKnownVariable: () => true,
      isAllowedElement: () => true,
      checkProp: () => null,
      ...checks,
    },
  };
}

/** Run `input` through the core parser, collecting unified error events. */
function collectEvents(input: string, opts: TestOptions & { end?: boolean } = {}): JsxErrorEvent[] {
  const events: JsxErrorEvent[] = [];
  const { end = true, ...rest } = opts;
  const p = createParser(parserOptions(rest, (e) => events.push(e)));
  p.write(input);
  if (end) p.end();
  // Note: getTree() is never called — events must not depend on rendering.
  return events;
}

describe("Unified JSX error events (onJsxError)", () => {
  it("reports a mismatched closing tag in every recovery mode", () => {
    for (const mode of ["autoclose", "ignore"] as const) {
      const events = collectEvents("<a>x</b>", { mismatchedTag: mode, end: false });
      expect(events).toMatchObject([
        {
          kind: "mismatched-tag",
          message: "Mismatched closing tag </b>; expected </a>",
          tag: "b",
          expected: "a",
        },
      ]);
    }
  });

  it("keeps recovery behavior unchanged while reporting", () => {
    const tk = new Tokenizer();
    const tb = new TreeBuilder();
    const errors = [...tb.push(tk.write("<a><b>x</a>")), ...tb.end()];
    const r = createRenderer({});
    const markup = renderToStaticMarkup(
      createElement(Fragment, null, r.render(tb.snapshot(tk.getPending()))),
    );
    expect(markup).toBe("<a><b>x</b></a>");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      kind: "mismatched-tag",
      message: "Mismatched closing tag </a>; expected </b>",
      tag: "a",
      expected: "b",
    });
  });

  it("reports a stray closing tag with nothing open (expected: null)", () => {
    expect(collectEvents("</div>foo", { end: false })).toMatchObject([
      {
        kind: "mismatched-tag",
        message: "Stray closing tag </div> with nothing open",
        tag: "div",
        expected: null,
      },
    ]);
  });

  it("reports an unknown component at parse time via isKnownComponent", () => {
    const events = collectEvents("<Known><Nope>x</Nope></Known>", {
      isKnownComponent: (tag) => tag === "Known",
    });
    expect(events).toMatchObject([
      { kind: "unknown-component", message: "Unknown component <Nope>", tag: "Nope" },
    ]);
  });

  it("does not treat lowercase (host) tags as components", () => {
    expect(collectEvents("<div><span/></div>", { isKnownComponent: () => false })).toEqual([]);
  });

  it("reports an unknown variable at parse time via isKnownVariable", () => {
    const events = collectEvents("<p>{known}{user.name}</p>", {
      isKnownVariable: (path) => path[0] === "known",
    });
    expect(events).toMatchObject([
      {
        kind: "unknown-variable",
        message: "Unknown variable reference {user.name}",
        name: "user",
        path: ["user", "name"],
      },
    ]);
  });

  it("hands isKnownVariable the full dot path for nested validation", () => {
    const paths: (readonly string[])[] = [];
    collectEvents("<p>{a.b.c}{x}</p>", {
      isKnownVariable: (path) => {
        paths.push(path);
        return true;
      },
    });
    expect(paths).toEqual([["a", "b", "c"], ["x"]]);
  });

  it("stays silent on variable references without an isKnownVariable probe", () => {
    expect(collectEvents("<p>{user.name}</p>")).toEqual([]);
  });

  it("treats __proto__ / constructor / prototype access as unsupported, not a variable", () => {
    const isKnownVariable = vi.fn(() => true);
    const events = collectEvents("<p>{a.__proto__}{constructor}{a.prototype.b}</p>", {
      isKnownVariable,
    });
    expect(events.map((e) => e.kind)).toEqual([
      "unsupported-expression",
      "unsupported-expression",
      "unsupported-expression",
    ]);
    expect(isKnownVariable).not.toHaveBeenCalled();
  });

  it("reports an unsupported child expression with its raw source", () => {
    expect(collectEvents("<p>{foo()}</p>")).toMatchObject([
      {
        kind: "unsupported-expression",
        message: "Unsupported expression: {foo()}",
        expression: "foo()",
      },
    ]);
  });

  it("reports an unsupported attribute expression with the attribute name", () => {
    expect(collectEvents("<input value={a + b}/>")).toMatchObject([
      {
        kind: "unsupported-expression",
        message: 'Unsupported expression in attribute "value": {a + b}',
        expression: "a + b",
        attribute: "value",
      },
    ]);
  });

  it("stays silent for supported expressions", () => {
    expect(collectEvents(`<p title={"t"}>{42}{"s"}{null}</p>`)).toEqual([]);
  });

  it("reports unclosed tags at end of input, innermost first", () => {
    expect(collectEvents("<div><span>hi")).toMatchObject([
      { kind: "unclosed-tag", message: "Unclosed tag <span> at end of input", tag: "span" },
      { kind: "unclosed-tag", message: "Unclosed tag <div> at end of input", tag: "div" },
    ]);
    expect(collectEvents("<>x")).toMatchObject([
      { kind: "unclosed-tag", message: "Unclosed fragment <> at end of input", tag: "" },
    ]);
    // A cleanly closed document reports nothing.
    expect(collectEvents("<div>ok</div>")).toEqual([]);
  });
});

describe("Error locations (line / column / lineText)", () => {
  it("locates a mismatched closing tag at its `<`", () => {
    expect(collectEvents("<a>\n  hello</b>", { end: false })).toEqual([
      {
        kind: "mismatched-tag",
        message: "Mismatched closing tag </b>; expected </a>",
        tag: "b",
        expected: "a",
        location: { line: 2, column: 8, offset: 11, lineText: "  hello</b>" },
      },
    ]);
  });

  it("locates unclosed tags at their opening `<`", () => {
    expect(collectEvents("<div>\n  <span>hi").map((e) => e.location)).toEqual([
      { line: 2, column: 3, offset: 8, lineText: "  <span>" },
      { line: 1, column: 1, offset: 0, lineText: "<div>" },
    ]);
  });

  it("captures the whole opening tag in lineText once it completes", () => {
    // The line has streamed past the tag name by the time `>` / `/>` arrives;
    // errors about the element should show the full opening tag.
    const events = collectEvents(`<Widget title="x"/>`, { isKnownComponent: () => false });
    expect(events[0]?.location).toEqual({
      line: 1,
      column: 1,
      offset: 0,
      lineText: `<Widget title="x"/>`,
    });
    expect(collectEvents(`<div id='a'>x`)[0]?.location).toEqual({
      line: 1,
      column: 1,
      offset: 0,
      lineText: "<div id='a'>",
    });
  });

  it("locates an unknown component at its opening `<`", () => {
    const events = collectEvents("<Known>\n  <Nope>x</Nope>\n</Known>", {
      isKnownComponent: (tag) => tag === "Known",
    });
    expect(events[0]?.location).toEqual({
      line: 2,
      column: 3,
      offset: 10,
      lineText: "  <Nope>",
    });
  });

  it("locates an unsupported expression at its `{`", () => {
    expect(collectEvents("<p>{foo()}</p>")[0]?.location).toEqual({
      line: 1,
      column: 4,
      offset: 3,
      lineText: "<p>{foo()}",
    });
    expect(collectEvents("<input value={a + b}/>")[0]?.location).toEqual({
      line: 1,
      column: 14,
      offset: 13,
      lineText: "<input value={a + b}",
    });
  });

  it("reports errors inside a nested JSX expression at the enclosing `{`", () => {
    expect(collectEvents("<p>{<Nope/>}</p>", { isKnownComponent: () => false })).toEqual([
      {
        kind: "unknown-component",
        message: "Unknown component <Nope>",
        tag: "Nope",
        location: { line: 1, column: 4, offset: 3, lineText: "<p>{<Nope/>}" },
      },
    ]);
  });

  it("emits the same events and locations regardless of how the input is chunked", () => {
    const input = "<a>\n  <B>x</c>\n  {fn()}\n</a>";
    const opts = { isKnownComponent: () => false };
    const reference = collectEvents(input, opts);
    expect(reference.map((e) => e.kind)).toEqual([
      "unknown-component",
      "mismatched-tag",
      "unsupported-expression",
    ]);
    for (let i = 1; i < input.length; i++) {
      const events: JsxErrorEvent[] = [];
      const p = createParser(parserOptions(opts, (e) => events.push(e)));
      p.write(input.slice(0, i));
      p.write(input.slice(i));
      p.end();
      expect(events).toEqual(reference);
    }
  });
});

describe("formatJsxError", () => {
  it("renders message, position and a caret code frame", () => {
    const [event] = collectEvents("<a>hello</b>", { end: false });
    expect(formatJsxError(event!)).toBe(
      "Mismatched closing tag </b>; expected </a> (line 1, column 9)\n" +
        "\n" +
        "  1 | <a>hello</b>\n" +
        "    |         ^",
    );
  });

  it("preserves tabs in the caret padding", () => {
    const out = formatJsxError({
      kind: "mismatched-tag",
      message: "boom",
      tag: "b",
      expected: "a",
      location: { line: 3, column: 6, offset: 20, lineText: "\t<a>x</b>" },
    });
    expect(out).toBe("boom (line 3, column 6)\n\n  3 | \t<a>x</b>\n    | \t    ^");
  });

  it("windows very long lines around the caret", () => {
    const lineText = "x".repeat(149) + "X" + "x".repeat(50);
    const out = formatJsxError({
      kind: "unclosed-tag",
      message: "boom",
      tag: "a",
      location: { line: 1, column: 150, offset: 149, lineText },
    });
    const lines = out.split("\n");
    expect(lines[2]).toContain("…");
    expect(lines[2]!.length).toBeLessThan(100);
    const caret = lines[3]!.indexOf("^");
    expect(lines[2]![caret]).toBe("X");
  });
});

async function* streamOf(...chunks: string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk;
}

describe("Unified JSX error events — React adapter wiring", () => {
  it("reports an unknown component as soon as it is parsed, before any render", async () => {
    const events: JsxErrorEvent[] = [];
    const parser = createIncrementalJsxParser(streamOf("<Card>", "hi</Card>"), {
      components: {},
      onUnknownComponent: "passthrough", // tolerance mode does not silence the event
      onJsxError: (e) => events.push(e),
    });
    await parser.done;
    // getSnapshot() was never called: the event arrived at parse time.
    expect(events).toMatchObject([
      { kind: "unknown-component", message: "Unknown component <Card>", tag: "Card" },
    ]);
  });

  it("resolves through resolveComponent and the components map", async () => {
    const events: JsxErrorEvent[] = [];
    const parser = createIncrementalJsxParser(streamOf("<A/><B/><C/>"), {
      components: { A: () => null },
      resolveComponent: (name) => (name === "B" ? () => null : undefined),
      onJsxError: (e) => events.push(e),
    });
    await parser.done;
    expect(events).toMatchObject([
      { kind: "unknown-component", message: "Unknown component <C>", tag: "C" },
    ]);
  });

  it("validates every path segment against the variables map at parse time", async () => {
    const events: JsxErrorEvent[] = [];
    const parser = createIncrementalJsxParser(
      streamOf("<p>{user.name}{user.na", "me.length}{user.nmae}{nope}</p>"),
      {
        variables: { user: { name: "uhyo" } },
        onJsxError: (e) => events.push(e),
      },
    );
    await parser.done;
    // {user.name} and {user.name.length} (a boxed string member) resolve;
    // the typo'd member and the unknown root are both reported.
    expect(events).toMatchObject([
      {
        kind: "unknown-variable",
        message: "Unknown variable reference {user.nmae}",
        name: "user",
        path: ["user", "nmae"],
      },
      { kind: "unknown-variable", message: "Unknown variable reference {nope}", name: "nope" },
    ]);
  });

  it("reports a member access through a null/undefined intermediate", async () => {
    const events: JsxErrorEvent[] = [];
    const parser = createIncrementalJsxParser(streamOf("<p>{user.gone.deep}</p>"), {
      variables: { user: { gone: null } },
      onJsxError: (e) => events.push(e),
    });
    await parser.done;
    expect(events).toMatchObject([{ kind: "unknown-variable", path: ["user", "gone", "deep"] }]);
  });

  it("does not probe resolveComponent at parse time without an onJsxError listener", async () => {
    const resolveComponent = vi.fn(() => undefined);
    const parser = createIncrementalJsxParser(streamOf("<Foo/>"), { resolveComponent });
    await parser.done;
    expect(resolveComponent).not.toHaveBeenCalled();
  });
});
