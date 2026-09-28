import { describe, expect, it } from "vitest";

import type { SourceLocation } from "./position";
import { createSchemaChecks, validateOpeningTag, validateVariable } from "./validate";

const loc: SourceLocation = { line: 1, column: 1, offset: 0, lineText: "<x>" };

describe("createSchemaChecks", () => {
  const checks = createSchemaChecks({
    elements: { div: true, a: { href: "url" } },
    components: { Card: { props: { title: "string" } } },
    variables: { user: { name: "uhyo" } },
  });

  it("derives every check from the schema", () => {
    expect(checks.isKnownComponent("Card")).toBe(true);
    expect(checks.isKnownComponent("Nope")).toBe(false);
    expect(checks.isAllowedElement("div")).toBe(true);
    expect(checks.isAllowedElement("span")).toBe(false);
    expect(checks.isKnownVariable(["user", "name"])).toBe(true);
    expect(checks.isKnownVariable(["user", "nmae"])).toBe(false);
    expect(checks.checkProp("Card", "title", "x")).toBeNull();
    expect(checks.checkProp("Card", "other", "x")).not.toBeNull();
  });

  it("accepts a custom component lookup", () => {
    const custom = createSchemaChecks({}, (tag) => tag === "Dyn");
    expect(custom.isKnownComponent("Dyn")).toBe(true);
    expect(createSchemaChecks({}).isKnownComponent("Dyn")).toBe(false);
  });
});

describe("validateOpeningTag", () => {
  const checks = createSchemaChecks({
    elements: ["div"],
    components: { Card: { props: { title: "string" } } },
  });

  it("returns no errors (the shared empty result) for a valid tag", () => {
    const a = validateOpeningTag("div", {}, loc, checks);
    expect(a).toEqual([]);
    expect(validateOpeningTag("Card", { title: "x" }, loc, checks)).toBe(a);
  });

  it("reports the tag, then every rejected prop", () => {
    expect(validateOpeningTag("Nope", {}, loc, checks)).toEqual([
      {
        kind: "unknown-component",
        message: "Unknown component <Nope>",
        tag: "Nope",
        location: loc,
      },
    ]);
    expect(
      validateOpeningTag("span", { style: "color: red" }, loc, checks).map((e) => e.kind),
    ).toEqual(["disallowed-element", "invalid-prop"]);
    expect(validateOpeningTag("Card", { title: 1, x: "y" }, loc, checks)).toMatchObject([
      { kind: "invalid-prop", prop: "title" },
      { kind: "invalid-prop", prop: "x" },
    ]);
  });
});

describe("validateVariable", () => {
  const checks = createSchemaChecks({ variables: { user: { name: "uhyo" } } });

  it("returns null for a known path and an error otherwise", () => {
    expect(validateVariable(["user", "name"], loc, checks)).toBeNull();
    expect(validateVariable(["user", "nmae"], loc, checks)).toEqual({
      kind: "unknown-variable",
      message: "Unknown variable reference {user.nmae}",
      name: "user",
      path: ["user", "nmae"],
      location: loc,
    });
  });
});
