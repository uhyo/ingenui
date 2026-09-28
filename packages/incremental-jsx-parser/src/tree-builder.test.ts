import { describe, expect, it } from "vitest";

import type { ElementNode, Node } from "./core";
import { Tokenizer } from "./tokenizer";
import { TreeBuilder } from "./tree-builder";

/** Feed `input` through tokenizer + builder and return the live snapshot. */
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

/** Serialize a snapshot to a compact JSX-ish string for table assertions. */
function ser(nodes: readonly Node[]): string {
  return nodes.map(serNode).join("");
}

function serNode(node: Node): string {
  switch (node.kind) {
    case "text":
      return node.value;
    case "pending":
      return "<Pending/>";
    case "fragment":
      return `<>${ser(node.children)}</>`;
    case "element": {
      const props = Object.entries(node.props)
        .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}=${JSON.stringify(v)}`))
        .join("");
      return `<${node.tag}${props}>${ser(node.children)}</${node.tag}>`;
    }
    case "expression":
      return `{${JSON.stringify(node.value)}}`;
    case "variable":
      return `{${node.path.join(".")}}`;
  }
}

describe("TreeBuilder — §1 frontier table", () => {
  const cases: [received: string, expected: string][] = [
    ["<div>", "<div><Pending/></div>"],
    ["<div>Hello", "<div>Hello<Pending/></div>"],
    ["<div><span>", "<div><span><Pending/></span></div>"],
    ["<div><sp", "<div><Pending/></div>"],
    [`<div title="bo`, "<Pending/>"],
  ];

  for (const [received, expected] of cases) {
    it(`${JSON.stringify(received)} -> ${expected}`, () => {
      expect(ser(build(received))).toBe(expected);
    });
  }

  it("<div>a</div> (eof) -> <div>a</div> (no Pending)", () => {
    expect(ser(build("<div>a</div>", { end: true }))).toBe("<div>a</div>");
  });
});

describe("TreeBuilder — structure", () => {
  it("builds nested elements with the frontier at the innermost open node", () => {
    expect(ser(build("<a><b><c>"))).toBe("<a><b><c><Pending/></c></b></a>");
  });

  it("places the frontier at root level between top-level nodes", () => {
    expect(ser(build("<br/>"))).toBe("<br></br><Pending/>");
  });

  it("handles fragments, freezing them on close like elements", () => {
    expect(ser(build("<><b>x</b>"))).toBe("<><b>x</b><Pending/></>");
    const closed = build("<>x</>", { end: true });
    expect(ser(closed)).toBe("<>x</>");
    expect(Object.isFrozen(closed[0])).toBe(true);
  });

  it("collects string and boolean-shorthand props", () => {
    const [el] = build(`<input type="text" disabled>`) as [ElementNode];
    expect(el.tag).toBe("input");
    expect(el.props).toEqual({ type: "text", disabled: true });
  });

  it("auto-closes still-open nodes on end()", () => {
    expect(ser(build("<div><span>hi", { end: true }))).toBe("<div><span>hi</span></div>");
  });

  it("self-closing elements do not go on the open stack", () => {
    expect(ser(build("<div><br/>after"))).toBe("<div><br></br>after<Pending/></div>");
  });
});

describe("TreeBuilder — incrementality", () => {
  it("freezes closed nodes and preserves their identity across snapshots", () => {
    const tk = new Tokenizer();
    const tb = new TreeBuilder();

    const feed = (s: string) => {
      tb.push(tk.write(s));
    };

    feed("<div><span>a</span>");
    const s1 = tb.snapshot(tk.getPending());
    const span1 = (s1[0] as ElementNode).children[0]!;
    expect(span1.kind).toBe("element");
    expect(Object.isFrozen(span1)).toBe(true);

    feed("more text");
    const s2 = tb.snapshot(tk.getPending());
    const span2 = (s2[0] as ElementNode).children[0]!;

    // The closed <span> subtree is reused by reference (memoization-friendly);
    expect(span2).toBe(span1);
    // ...while the open <div> on the frontier path is rebuilt each snapshot.
    expect(s2[0]).not.toBe(s1[0]);
  });

  it("assigns monotonically increasing ids and a stable Pending key", () => {
    // <a> stays open, <b> closes inside it, so the frontier sits inside <a>.
    const nodes = build("<a><b></b>");
    const a = nodes[0] as ElementNode;
    const b = a.children[0] as ElementNode;
    expect(a.id).toBe(0);
    expect(b.id).toBe(1);
    const pending = a.children[1]!;
    expect(pending.kind).toBe("pending");
    expect(pending.id).toBe(-1);
  });

  it("keeps the partial-text key stable as the run grows, into its commit", () => {
    const tk = new Tokenizer();
    const tb = new TreeBuilder();
    const feed = (s: string) => {
      tb.push(tk.write(s));
    };

    feed("<p>Hel");
    const id1 = ((tb.snapshot(tk.getPending())[0] as ElementNode).children[0] as Node).id;
    feed("lo");
    const id2 = ((tb.snapshot(tk.getPending())[0] as ElementNode).children[0] as Node).id;
    expect(id2).toBe(id1);

    feed("</p>");
    const committed = (tb.snapshot(tk.getPending())[0] as ElementNode).children[0] as Node;
    expect(committed.kind).toBe("text");
    expect(committed.id).toBe(id1);
  });
});

describe("TreeBuilder — purity", () => {
  it("snapshot() is a pure read: calling it does not affect the ids assigned", () => {
    const input = "<p>Hello <b>world</b> and {x}</p>";
    const withSnapshots = (() => {
      const tk = new Tokenizer();
      const tb = new TreeBuilder();
      for (const ch of input) {
        tb.push(tk.write(ch));
        tb.snapshot(tk.getPending());
        tb.snapshot(tk.getPending());
      }
      tb.push(tk.end());
      tb.end();
      return tb.snapshot({ type: "none" });
    })();
    expect(withSnapshots).toEqual(build(input, { end: true }));
  });

  it("never changes a node it handed out", () => {
    const tk = new Tokenizer();
    const tb = new TreeBuilder();
    tb.push(tk.write("<div><p>a"));
    const before = tb.snapshot(tk.getPending());
    const json = JSON.stringify(before);
    tb.push(tk.write("b</p><p>c</p>"));
    tb.push(tk.end());
    tb.end();
    expect(JSON.stringify(before)).toBe(json);
    const after = tb.snapshot({ type: "none" });
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen((after[0] as ElementNode).children)).toBe(true);
  });

  it("returns the errors each call produced instead of calling a listener", () => {
    const tk = new Tokenizer();
    const tb = new TreeBuilder({
      checks: {
        isKnownComponent: () => false,
        isKnownVariable: () => true,
        isAllowedElement: () => true,
        checkProp: () => null,
      },
    });
    expect(tb.push(tk.write("<a>"))).toEqual([]);
    expect(tb.push(tk.write("<Nope/></b>")).map((e) => e.kind)).toEqual([
      "unknown-component",
      "mismatched-tag",
    ]);
    expect(tb.end().map((e) => e.kind)).toEqual([]);
  });

  it("reports unclosed tags from end(), innermost first", () => {
    const tk = new Tokenizer();
    const tb = new TreeBuilder();
    tb.push(tk.write("<a><>x"));
    tb.push(tk.end());
    expect(tb.end().map((e) => e.kind === "unclosed-tag" && e.tag)).toEqual(["", "a"]);
  });
});
