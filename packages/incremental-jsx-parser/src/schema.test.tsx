import { fireEvent, render } from "@testing-library/react";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  checkProp,
  checkPropValue,
  createParser,
  formatPromptContract,
  isElementAllowed,
  resolveVariableType,
  UNSUPPORTED_EXPRESSION,
} from "./core";
import type { JsxErrorEvent, PropValue, SchemaOptions, VariableNode } from "./core";
import { createIncrementalJsxParser } from "./index";
import { createRenderer, type RenderOptions } from "./render";

/** Parse a complete input and render it to static HTML. */
function toHtml(input: string, options?: RenderOptions): string {
  const core = createParser();
  core.write(input);
  core.end();
  const renderer = createRenderer(options);
  return renderToStaticMarkup(createElement(Fragment, null, renderer.render(core.getTree())));
}

function variable(...path: string[]): VariableNode {
  return { kind: "variable", id: 1, path };
}

describe("isElementAllowed", () => {
  it("allows everything when no allowlist is configured", () => {
    expect(isElementAllowed(undefined, "script")).toBe(true);
  });

  it("checks membership for the list form", () => {
    expect(isElementAllowed(["div", "span"], "div")).toBe(true);
    expect(isElementAllowed(["div", "span"], "script")).toBe(false);
  });

  it("checks keys for the record form", () => {
    expect(isElementAllowed({ div: true, a: ["href"] }, "a")).toBe(true);
    expect(isElementAllowed({ div: true }, "iframe")).toBe(false);
  });

  it("never governs component-like tags (that is what `components` is for)", () => {
    expect(isElementAllowed(["div"], "Card")).toBe(true);
    expect(isElementAllowed(["div"], "Icons.Star")).toBe(true);
  });

  it("does not treat inherited object members as allowlisted tags", () => {
    expect(isElementAllowed({ div: true }, "toString")).toBe(false);
  });
});

describe("checkProp — built-in rules", () => {
  it("exempts component tags and the unsupported-expression sentinel", () => {
    expect(checkProp("Card", "style", "red")).toBeNull();
    expect(checkProp("div", "style", UNSUPPORTED_EXPRESSION as unknown as PropValue)).toBeNull();
  });

  it("always rejects the HTML-injection and React-internal props", () => {
    for (const prop of ["dangerouslySetInnerHTML", "srcDoc", "srcdoc", "ref", "key", "children"]) {
      expect(checkProp("div", prop, "x"), prop).not.toBeNull();
    }
  });

  it("rejects string styles but accepts a variable resolving to an object", () => {
    const options = { variables: { theme: { card: { color: "red" }, oops: "red" } } };
    expect(checkProp("div", "style", "color:red", options)).not.toBeNull();
    expect(checkProp("div", "style", variable("theme", "card"), options)).toBeNull();
    expect(checkProp("div", "style", variable("theme", "oops"), options)).not.toBeNull();
    // Unresolvable → renders as undefined; already reported as unknown-variable.
    expect(checkProp("div", "style", variable("nope"), options)).toBeNull();
  });

  it("rejects on* handlers unless they reference a predefined variable", () => {
    expect(checkProp("button", "onClick", "alert(1)")).not.toBeNull();
    expect(checkProp("button", "onclick", "alert(1)")).not.toBeNull();
    expect(checkProp("button", "onClick", variable("actions", "go"))).toBeNull();
  });

  it("rejects unsafe URL schemes, including obfuscated ones", () => {
    expect(checkProp("a", "href", "javascript:alert(1)")).not.toBeNull();
    expect(checkProp("a", "href", " JaVaScRiPt:alert(1)")).not.toBeNull();
    expect(checkProp("a", "href", "java\u0000script:alert(1)")).not.toBeNull();
    expect(checkProp("iframe", "src", "data:text/html,<script>")).not.toBeNull();
    expect(checkProp("a", "href", "https://example.com/")).toBeNull();
    expect(checkProp("a", "href", "/relative?q=javascript:")).toBeNull();
  });

  it("enforces a per-tag prop allowlist from the record form", () => {
    const options = { elements: { a: ["href"] } } as const;
    expect(checkProp("a", "href", "/x", options)).toBeNull();
    expect(checkProp("a", "id", "z", options)).not.toBeNull();
    // List form and `true` entries allow any prop (built-ins still apply).
    expect(checkProp("a", "id", "z", { elements: ["a"] })).toBeNull();
  });
});

describe("checkPropValue — the lightweight type system", () => {
  it("accepts matching literals and rejects mismatches", () => {
    expect(checkPropValue("hi", "string")).toBeNull();
    expect(checkPropValue(42, "number")).toBeNull();
    expect(checkPropValue(true, "boolean")).toBeNull();
    expect(checkPropValue(42, "string")).not.toBeNull();
    expect(checkPropValue("hi", "boolean")).not.toBeNull();
  });

  it("treats nullish values and the `any` type as always fine", () => {
    expect(checkPropValue(null, "function")).toBeNull();
    expect(checkPropValue(undefined, "object")).toBeNull();
    expect(checkPropValue("whatever", "any")).toBeNull();
  });

  it("supports union types", () => {
    expect(checkPropValue("a", ["string", "number"])).toBeNull();
    expect(checkPropValue(1, ["string", "number"])).toBeNull();
    expect(checkPropValue(true, ["string", "number"])).not.toBeNull();
  });

  it("`node` accepts nested JSX and renderable primitives", () => {
    const jsx: PropValue = {
      kind: "element",
      id: 1,
      tag: "b",
      props: {},
      children: [],
      status: "closed",
    };
    expect(checkPropValue(jsx, "node")).toBeNull();
    expect(checkPropValue("text", "node")).toBeNull();
    expect(checkPropValue(7, "node")).toBeNull();
    expect(checkPropValue(jsx, "string")).not.toBeNull();
  });

  it("`url` scheme-checks literal strings but trusts variable references", () => {
    expect(checkPropValue("https://example.com/", "url")).toBeNull();
    expect(checkPropValue("javascript:alert(1)", "url")).not.toBeNull();
    // A variable is the integrator's own data — only its string-ness is checked.
    expect(checkPropValue(variable("link"), "url", { variables: { link: "x:y" } })).toBeNull();
    expect(checkPropValue(variable("n"), "url", { variables: { n: 3 } })).not.toBeNull();
  });

  it("checks variable references by resolved type, declared types winning over values", () => {
    const options: SchemaOptions = {
      variables: { user: { name: "Ada" } },
      variableTypes: { user: { name: "string" } },
    };
    expect(checkPropValue(variable("user", "name"), "string", options)).toBeNull();
    expect(checkPropValue(variable("user", "name"), "number", options)).not.toBeNull();
    const declared: SchemaOptions = {
      variables: { n: "looks-like-a-string" },
      variableTypes: { n: "number" },
    };
    expect(checkPropValue(variable("n"), "number", declared)).toBeNull();
  });
});

describe("resolveVariableType", () => {
  it("walks declared shapes and falls back to value inference", () => {
    const options: SchemaOptions = {
      variables: { user: { name: "Ada", extra: 1 } },
      variableTypes: { user: { name: "string" }, actions: { go: "function" } },
    };
    expect(resolveVariableType(options, ["user", "name"])).toBe("string");
    // Not covered by the declaration → inferred from the value.
    expect(resolveVariableType(options, ["user", "extra"])).toBe("number");
    // Declared without a value → still typed (and thus "known").
    expect(resolveVariableType(options, ["actions", "go"])).toBe("function");
    expect(resolveVariableType(options, ["missing"])).toBeUndefined();
  });

  it("treats members of an opaque object type as unconstrained", () => {
    expect(resolveVariableType({ variableTypes: { bag: "object" } }, ["bag", "anything"])).toBe(
      "any",
    );
  });
});

describe("checkProp — typed prop declarations", () => {
  const options: SchemaOptions = {
    elements: { a: { href: "url", title: "string" }, div: true, button: true },
    components: {
      Card: {
        component: () => null,
        props: { title: "string", count: ["string", "number"], onAction: "function" },
      },
      Free: () => null,
    },
    variables: { actions: { go: () => {} }, user: { name: "Ada" } },
  };

  it("checks host props against their declared types", () => {
    expect(checkProp("a", "href", "/docs", options)).toBeNull();
    expect(checkProp("a", "title", "hello", options)).toBeNull();
    expect(checkProp("a", "title", 42, options)).not.toBeNull();
    // A prop outside the typed record is not allowed.
    expect(checkProp("a", "rel", "noopener", options)).not.toBeNull();
  });

  it("still applies the built-in host rules under a typed declaration", () => {
    expect(checkProp("a", "href", "javascript:alert(1)", options)).not.toBeNull();
    expect(checkProp("div", "style", "color:red", options)).not.toBeNull();
  });

  it("validates component props against the catalog declaration", () => {
    expect(checkProp("Card", "title", "hi", options)).toBeNull();
    expect(checkProp("Card", "count", 3, options)).toBeNull();
    expect(checkProp("Card", "title", true, options)).not.toBeNull();
    expect(checkProp("Card", "onAction", variable("actions", "go"), options)).toBeNull();
    expect(checkProp("Card", "onAction", "alert(1)", options)).not.toBeNull();
    expect(checkProp("Card", "bogus", "x", options)).not.toBeNull();
  });

  it("names the allowed props in the rejection reason", () => {
    expect(checkProp("Card", "bogus", "x", options)).toBe(
      "not an allowed prop for <Card> (allowed: title, count, onAction)",
    );
    const empty: SchemaOptions = { components: { Box: { props: {} } } };
    expect(checkProp("Box", "tone", "x", empty)).toBe("<Box> takes no props");
  });

  it("leaves undeclared components as the author's contract", () => {
    expect(checkProp("Free", "anything", "goes", options)).toBeNull();
    expect(checkProp("Unknown", "anything", "goes", options)).toBeNull();
  });

  it("rejects an on* variable that resolves to a non-function", () => {
    expect(checkProp("button", "onClick", variable("user", "name"), options)).not.toBeNull();
    expect(checkProp("button", "onClick", variable("actions", "go"), options)).toBeNull();
  });
});

describe("render-time enforcement", () => {
  it("drops a string style instead of letting React throw", () => {
    expect(toHtml(`<div style="color:red">hi</div>`)).toBe("<div>hi</div>");
  });

  it("renders a style variable that resolves to an object", () => {
    expect(
      toHtml(`<div style={theme.card}>hi</div>`, {
        variables: { theme: { card: { color: "red" } } },
      }),
    ).toBe(`<div style="color:red">hi</div>`);
  });

  it("drops unsafe URLs and keeps safe ones", () => {
    expect(toHtml(`<a href="javascript:alert(1)">x</a>`)).toBe("<a>x</a>");
    expect(toHtml(`<a href="/docs">x</a>`)).toBe(`<a href="/docs">x</a>`);
  });

  it("drops string event handlers", () => {
    expect(toHtml(`<button onClick="alert(1)">go</button>`)).toBe("<button>go</button>");
  });

  it("wires an on* handler through a predefined variable", () => {
    const go = vi.fn();
    const core = createParser();
    core.write(`<button onClick={actions.go}>hit</button>`);
    core.end();
    const renderer = createRenderer({ variables: { actions: { go } } });
    const { getByText } = render(createElement(Fragment, null, renderer.render(core.getTree())));
    fireEvent.click(getByText("hit"));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("skips an element outside the allowlist (default behavior)", () => {
    expect(toHtml(`<div><script>alert(1)</script>ok</div>`, { elements: ["div"] })).toBe(
      "<div>ok</div>",
    );
  });

  it("can render a disallowed element as the Pending placeholder", () => {
    const Marker = (): ReactNode => createElement("em", null, "…");
    expect(
      toHtml(`<div><iframe src="x"></iframe></div>`, {
        elements: ["div"],
        onDisallowedElement: "pending",
        Pending: Marker,
      }),
    ).toBe("<div><em>…</em></div>");
  });

  it("drops props outside a per-tag allowlist", () => {
    expect(toHtml(`<a href="/x" id="z">t</a>`, { elements: { a: ["href"] } })).toBe(
      `<a href="/x">t</a>`,
    );
  });

  it("applies the allowlist to nested JSX inside an expression", () => {
    expect(toHtml(`<div>{<script>x</script>}</div>`, { elements: ["div"] })).toBe("<div></div>");
  });
});

describe("parse-time events through the React adapter", () => {
  it("reports disallowed elements and invalid props with locations", async () => {
    async function* source(): AsyncGenerator<string> {
      yield `<script src="x"></script>`;
      yield `<div style="color:red">a</div>`;
    }
    const events: JsxErrorEvent[] = [];
    const parser = createIncrementalJsxParser(source(), {
      elements: ["div"],
      onJsxError: (event) => events.push(event),
    });
    await parser.done;

    const disallowed = events.find((e) => e.kind === "disallowed-element");
    expect(disallowed).toMatchObject({ tag: "script" });
    expect(disallowed?.location.line).toBe(1);
    expect(disallowed?.location.column).toBe(1);

    const invalid = events.find((e) => e.kind === "invalid-prop");
    expect(invalid).toMatchObject({
      tag: "div",
      prop: "style",
      reason: "expected object (a predefined variable reference), got string",
      location: { line: 1, column: 26 },
    });
  });

  it("stays quiet for schema-conforming input", async () => {
    async function* source(): AsyncGenerator<string> {
      yield `<div><a href="/x">ok</a></div>`;
    }
    const events: JsxErrorEvent[] = [];
    const parser = createIncrementalJsxParser(source(), {
      elements: { div: true, a: ["href"] },
      onJsxError: (event) => events.push(event),
    });
    await parser.done;
    expect(events).toEqual([]);
  });
});

describe("component prop enforcement end to end", () => {
  const Card = ({ title, extra }: { title?: ReactNode; extra?: ReactNode }): ReactNode =>
    createElement("section", null, "t:", title, " e:", extra);

  it("drops a component prop outside the declared catalog", () => {
    expect(
      toHtml(`<Card title="ok" extra="nope" />`, {
        components: { Card: { component: Card, props: { title: "string" } } },
      }),
    ).toBe("<section>t:ok e:</section>");
  });

  it("drops a component prop that fails its declared type", () => {
    expect(
      toHtml(`<Card title={42} />`, {
        components: { Card: { component: Card, props: { title: "string" } } },
      }),
    ).toBe("<section>t: e:</section>");
  });

  it("reports component prop violations at parse time", async () => {
    async function* source(): AsyncGenerator<string> {
      yield `<Card title={42} />`;
    }
    const events: JsxErrorEvent[] = [];
    const parser = createIncrementalJsxParser(source(), {
      components: { Card: { component: Card, props: { title: "string" } } },
      onJsxError: (event) => events.push(event),
    });
    await parser.done;
    const invalid = events.find((e) => e.kind === "invalid-prop");
    expect(invalid).toMatchObject({ tag: "Card", prop: "title" });
  });

  it("treats a type-declared variable as known and well-typed", async () => {
    async function* source(): AsyncGenerator<string> {
      yield `<div style={theme.card}>x</div>`;
    }
    const events: JsxErrorEvent[] = [];
    const parser = createIncrementalJsxParser(source(), {
      variableTypes: { theme: { card: "object" } },
      onJsxError: (event) => events.push(event),
    });
    await parser.done;
    expect(events).toEqual([]);
  });
});

describe("formatPromptContract", () => {
  it("describes the configured elements, components, and variables", () => {
    const contract = formatPromptContract({
      elements: { div: true, a: ["href", "title"] },
      components: { Card: () => null },
      variables: { user: { name: "Ada", age: 42 }, actions: { proceed: () => {} } },
    });
    expect(contract).toContain("- <div>");
    expect(contract).toContain("- <a> — allowed props: href, title");
    expect(contract).toContain("- <Card>");
    expect(contract).toContain("- {user} — object with fields: name (string), age (number)");
    expect(contract).toContain("- {actions} — object with fields: proceed (function)");
    expect(contract).toContain("dangerouslySetInnerHTML");
    // Shapes only — variable values must never leak into the contract.
    expect(contract).not.toContain("Ada");
  });

  it("describes declared prop types and variable types", () => {
    const contract = formatPromptContract({
      elements: { a: { href: "url", title: "string" } },
      components: {
        Card: { component: () => null, props: { title: "string", width: ["string", "number"] } },
        Free: () => null,
      },
      variableTypes: { theme: { card: "object" }, actions: { confirm: "function" } },
      variables: { actions: { confirm: () => {} } },
    });
    expect(contract).toContain("- <a> — allowed props: href (URL string), title (string)");
    expect(contract).toContain(
      "- <Card> — allowed props: title (string), width (string or number)",
    );
    expect(contract).toContain("- <Free>");
    // Declared types win over the value-derived shape.
    expect(contract).toContain("- {actions} — object with fields: confirm (function)");
    expect(contract).toContain("- {theme} — object with fields: card (object)");
  });

  it("describes components with their declared descriptions", () => {
    const contract = formatPromptContract({
      components: {
        Card: {
          props: { title: "string" },
          description: "A titled panel.\n  Wrap related content.",
        },
        Note: { description: "A short aside." },
      },
    });
    expect(contract).toContain(
      "- <Card> — allowed props: title (string)\n  A titled panel. Wrap related content.",
    );
    // A description alone makes a spec: any props, but still described.
    expect(contract).toContain("- <Note>\n  A short aside.");
  });

  it("lists the list-form allowlist as a closed set", () => {
    const contract = formatPromptContract({ elements: ["div", "p"] });
    expect(contract).toContain("- <div>\n- <p>\n- Never use an element outside this list.");
  });

  it("falls back to sensible wording when nothing is configured", () => {
    const contract = formatPromptContract();
    expect(contract).toContain("Any standard lowercase HTML element is allowed.");
    expect(contract).toContain("No components are available");
    expect(contract).toContain("No variables are defined");
  });
});
