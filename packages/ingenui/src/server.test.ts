import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { defineGenUiSchema } from "./schema";
import { resolveGenUiAction } from "./server";

describe("resolveGenUiAction", () => {
  const schema = defineGenUiSchema({ actions: { submit: { description: "Submit." } } });

  it("resolves a declared action with its canonical message", () => {
    expect(resolveGenUiAction(schema, "submit")).toEqual({
      name: "submit",
      reference: "actions.submit",
      message: "The `actions.submit` action was fired by the user.",
      declared: true,
    });
  });

  it("resolves model-defined actions with dynamic actions (the default)", () => {
    expect(resolveGenUiAction(schema, "choosePlanPro")).toMatchObject({
      name: "choosePlanPro",
      declared: false,
    });
  });

  it("rejects names the model could not have wired", () => {
    for (const name of ["", "has space", "a.b", "1abc", "__proto__", "constructor", "toString"]) {
      expect(resolveGenUiAction(schema, name), name).toBeNull();
    }
  });

  it("normalizes the client's values into the data and the message", () => {
    expect(
      resolveGenUiAction(schema, "submit", { email: "ada@example.com", "bad key": "x", n: {} }),
    ).toEqual({
      name: "submit",
      reference: "actions.submit",
      message:
        "The `actions.submit` action was fired by the user with these values:\n" +
        '- email: "ada@example.com"',
      data: { email: "ada@example.com" },
      declared: true,
    });
    // Malformed values are dropped, not trusted.
    expect(resolveGenUiAction(schema, "submit", "email=x")).toEqual(
      resolveGenUiAction(schema, "submit"),
    );
  });

  it("rejects undeclared actions with dynamicActions: false", () => {
    const strict = defineGenUiSchema({ ...schema, dynamicActions: false });
    expect(resolveGenUiAction(strict, "submit")).not.toBeNull();
    expect(resolveGenUiAction(strict, "choosePlanPro")).toBeNull();
  });
});

describe("React-free entries", () => {
  const srcDir = dirname(fileURLToPath(import.meta.url));

  /** Every module specifier statically imported by `entry`, following relative imports. */
  function importGraph(entry: string): Set<string> {
    const specifiers = new Set<string>();
    const visited = new Set<string>();
    const visit = (file: string): void => {
      if (visited.has(file)) return;
      visited.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:import|export)[^;]*?from\s+"([^"]+)"/g)) {
        const specifier = match[1]!;
        if (specifier.startsWith(".")) {
          const base = resolve(dirname(file), specifier);
          visit(base.endsWith(".ts") ? base : `${base}.ts`);
        } else {
          specifiers.add(specifier);
        }
      }
    };
    visit(resolve(srcDir, entry));
    return specifiers;
  }

  for (const entry of ["server.ts", "schema.ts"]) {
    it(`${entry} imports only the parser's React-free core`, () => {
      expect([...importGraph(entry)]).toEqual(["@ingenui/incremental-jsx-parser/core"]);
    });
  }
});
