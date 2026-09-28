import { createElement, Fragment, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Node } from "./core";
import { createRenderer, useIsElementComplete, type RenderOptions } from "./render";
import { Tokenizer } from "./tokenizer";
import { TreeBuilder } from "./tree-builder";

/** Build a live AST snapshot from a JSX string. */
function build(input: string, opts?: { end?: boolean }): readonly Node[] {
  const tk = new Tokenizer();
  const tb = new TreeBuilder();
  tb.push(tk.write(input));
  if (opts?.end) {
    tb.push(tk.end());
    tb.end();
  }
  return tb.snapshot(tk.getPending());
}

/** Render a snapshot to static HTML. */
function toHtml(nodes: readonly Node[], options?: RenderOptions): string {
  const r = createRenderer(options);
  return renderToStaticMarkup(createElement(Fragment, null, r.render(nodes)));
}

function Card({ children }: { children?: ReactNode }): ReactNode {
  return createElement("div", { className: "card" }, children);
}

function Other(): ReactNode {
  return createElement("em", null, "map");
}

function Spinner(): ReactNode {
  return createElement("i", { className: "spin" });
}

describe("React adapter — basics", () => {
  it("renders intrinsic elements with text", () => {
    expect(toHtml(build("<div>Hello</div>", { end: true }))).toBe("<div>Hello</div>");
  });

  it("renders attributes (string + boolean shorthand)", () => {
    expect(toHtml(build(`<input type="text" disabled/>`, { end: true }))).toBe(
      `<input type="text" disabled=""/>`,
    );
  });

  it("renders fragments transparently", () => {
    expect(toHtml(build("<><b>a</b><i>b</i></>", { end: true }))).toBe("<b>a</b><i>b</i>");
  });

  it("default Pending renders nothing", () => {
    expect(toHtml(build("<div>hi"))).toBe("<div>hi</div>");
  });

  it("uses a custom Pending at the frontier", () => {
    expect(toHtml(build("<div>hi"), { Pending: Spinner })).toBe(
      `<div>hi<i class="spin"></i></div>`,
    );
  });
});

describe("React adapter — component resolution", () => {
  it("resolves capitalized tags through the components map", () => {
    expect(toHtml(build("<Card>inside</Card>", { end: true }), { components: { Card } })).toBe(
      `<div class="card">inside</div>`,
    );
  });

  it("consults resolveComponent first, falling back to the map", () => {
    const resolveComponent = vi.fn((name: string) => (name === "Card" ? Card : undefined));
    expect(
      toHtml(build("<Card>x</Card><Other/>", { end: true }), {
        resolveComponent,
        components: { Card: Other, Other },
      }),
    ).toBe(`<div class="card">x</div><em>map</em>`);
    expect(resolveComponent).toHaveBeenCalledWith("Other");
  });

  it("unknown component -> Pending by default", () => {
    expect(toHtml(build("<Nope>x</Nope>", { end: true }), { Pending: Spinner })).toBe(
      `<i class="spin"></i>`,
    );
  });

  it("unknown component -> passthrough renders as a host tag", () => {
    expect(
      toHtml(build("<Nope>x</Nope>", { end: true }), { onUnknownComponent: "passthrough" }),
    ).toBe(`<Nope>x</Nope>`);
  });

  it("unknown component -> skip renders nothing", () => {
    // The unresolved tag itself is reported at parse time via onJsxError.
    expect(toHtml(build("<Nope>x</Nope>", { end: true }), { onUnknownComponent: "skip" })).toBe("");
  });
});

describe("React adapter — keys & memoization", () => {
  it("assigns node ids as React keys", () => {
    const r = createRenderer();
    const out = r.render(build("<div>hi")) as ReactElement[];
    expect(out[0]!.key).toBe("0"); // <div> id 0
  });

  it("reuses the React element of a closed subtree across snapshots", () => {
    const tk = new Tokenizer();
    const tb = new TreeBuilder();
    const feed = (s: string) => {
      tb.push(tk.write(s));
    };
    const r = createRenderer();

    feed("<div><span>a</span>");
    const out1 = r.render(tb.snapshot(tk.getPending())) as ReactElement[];
    const span1 = (out1[0]!.props as { children: ReactNode[] }).children[0];

    feed("more");
    const out2 = r.render(tb.snapshot(tk.getPending())) as ReactElement[];
    const span2 = (out2[0]!.props as { children: ReactNode[] }).children[0];

    // The closed <span> renders to the very same React element object...
    expect(span2).toBe(span1);
    // ...while the open <div> on the frontier is a fresh element each snapshot.
    expect(out2[0]).not.toBe(out1[0]);
  });
});

describe("React adapter — element completion (useIsElementComplete)", () => {
  function Status({ children }: { children?: ReactNode }): ReactNode {
    return createElement("p", { "data-complete": String(useIsElementComplete()) }, children);
  }
  const options: RenderOptions = { components: { Status } };

  it("is false while the component element is open", () => {
    expect(toHtml(build("<Status>hi"), options)).toBe(`<p data-complete="false">hi</p>`);
  });

  it("is true once the closing tag arrives, even mid-stream", () => {
    expect(toHtml(build("<div><Status>hi</Status>"), options)).toBe(
      `<div><p data-complete="true">hi</p></div>`,
    );
  });

  it("is true for a self-closing component", () => {
    expect(toHtml(build("<div><Status/>"), options)).toBe(
      `<div><p data-complete="true"></p></div>`,
    );
  });

  it("is true for an element auto-closed at the end of the stream", () => {
    expect(toHtml(build("<Status>hi", { end: true }), options)).toBe(
      `<p data-complete="true">hi</p>`,
    );
  });

  it("reflects the nearest component element when nested", () => {
    expect(toHtml(build("<Status><div><Status>a</Status><Status>b"), options)).toBe(
      `<p data-complete="false"><div><p data-complete="true">a</p>` +
        `<p data-complete="false">b</p></div></p>`,
    );
  });

  it("is true for components in nested JSX props (buffered until complete)", () => {
    function Box({ icon }: { icon?: ReactNode }): ReactNode {
      return createElement("div", null, icon);
    }
    expect(toHtml(build("<Box icon={<Status/>}>"), { components: { Box, Status } })).toBe(
      `<div><p data-complete="true"></p></div>`,
    );
  });

  it("defaults to true outside a parser-rendered tree", () => {
    expect(renderToStaticMarkup(createElement(Status))).toBe(`<p data-complete="true"></p>`);
  });

  it("keeps the component element key on the wrapper", () => {
    const out = createRenderer(options).render(build("<Status>hi")) as ReactElement[];
    expect(out[0]!.key).toBe("0");
  });
});
